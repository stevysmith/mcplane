/**
 * Runs mcplane's checks across the remote servers in Claude's public connector
 * directory and writes aggregate numbers: how many servers pass or fail each
 * check. For a data report, not a leaderboard: per-server rows stay in a local,
 * gitignored file and are never published.
 *
 * Polite by design: one pass, a few servers at a time, the same requests a store
 * scanner makes (no sign-in, no client registration), an identifying user agent.
 *
 *   npx tsx scripts/scan-claude-directory.ts                 # plan only, probes nothing
 *   npx tsx scripts/scan-claude-directory.ts --urls a,b      # probe just these URLs
 *   npx tsx scripts/scan-claude-directory.ts --yes [--limit N] [--concurrency 6]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { preflight, type Check, type Manifest } from '../src/core.js';

const UA = 'mcplane-scan/0.3 (+https://github.com/stevysmith/mcplane)';
const FEED = 'https://api.anthropic.com/api/directory/servers?verified_tier=anthropic,partner,community&visibility=commercial&limit=5000';
const OUT = '.mcplane-scan';
const PER_SERVER_MS = 60_000;

const { values } = parseArgs({
  options: {
    yes: { type: 'boolean' },
    urls: { type: 'string' },
    limit: { type: 'string' },
    concurrency: { type: 'string', default: '6' },
  },
});

// Identify ourselves on every request that doesn't choose its own user agent (the bot-filter check does, on purpose).
const native = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (!headers.has('user-agent')) headers.set('user-agent', UA);
  return native(input, { ...init, headers });
};

interface Entry {
  url: string;
  name: string;
  tier?: string;
  authless?: boolean;
  privacy?: string | null;
  support?: string | null;
  icon?: string | null;
}

async function directory(): Promise<Entry[]> {
  const data = (await (await native(FEED, { headers: { 'user-agent': UA } })).json()) as { servers: any[] };
  const seen = new Set<string>();
  return data.servers
    .filter((s) => s.remote?.url && !s.remote.url_regex && !seen.has(s.remote.url) && seen.add(s.remote.url))
    .map((s) => ({ url: s.remote.url, name: s.display_name ?? s.name, tier: s.verified_tier, authless: s.remote.is_authless, privacy: s.privacy_policy, support: s.support, icon: s.icon_url }));
}

/** The listing as Anthropic holds it, so no page discovery is needed. */
function manifestOf(e: Entry): Manifest {
  return {
    name: 'scan',
    title: e.name,
    server: { url: e.url, auth: e.authless ? 'none' : 'oauth' },
    links: { privacy: e.privacy ?? undefined, support: e.support && /^https?:/.test(e.support) ? e.support : undefined },
    icon: e.icon ?? undefined,
    stores: ['claude-connectors', 'chatgpt'],
  };
}

async function scanOne(e: Entry): Promise<{ entry: Entry; checks: Check[]; error?: string }> {
  const deadline = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), PER_SERVER_MS));
  try {
    const r = await Promise.race([preflight(manifestOf(e)), deadline]);
    return { entry: e, checks: r.checks };
  } catch (err) {
    return { entry: e, checks: [], error: (err as Error).message };
  }
}

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

async function main() {
  const entries: Entry[] = values.urls
    ? values.urls.split(',').map((url) => ({ url: url.trim(), name: new URL(url.trim()).hostname }))
    : await directory();
  const limit = values.limit ? Number(values.limit) : entries.length;
  const target = entries.slice(0, limit);
  const concurrency = Number(values.concurrency);

  if (!values.yes && !values.urls) {
    const authless = target.filter((e) => e.authless).length;
    console.log(`Plan: ${target.length} remote servers from Claude's directory (${authless} authless, ${target.length - authless} behind sign-in).`);
    console.log(`Each gets the store-scanner checks (about 20 requests, no sign-in, no client registration), ${concurrency} servers at a time, user agent "${UA}".`);
    console.log('Nothing has been probed. Add --yes to run it.');
    return;
  }

  let done = 0;
  const results = await pool(target, concurrency, async (e) => {
    const r = await scanOne(e);
    if (++done % 50 === 0 || done === target.length) console.error(`${done}/${target.length}`);
    return r;
  });

  // Aggregate by check id: counts only, no names.
  const byCheck = new Map<string, { title: string; pass: number; warn: number; fail: number; skip: number }>();
  for (const r of results)
    for (const c of r.checks) {
      const row = byCheck.get(c.id) ?? { title: c.title, pass: 0, warn: 0, fail: 0, skip: 0 };
      row[c.level]++;
      byCheck.set(c.id, row);
    }
  const reachable = results.filter((r) => r.checks.some((c) => (c.id === 'server.initialize' || c.id === 'server.reachable') && c.level === 'pass')).length;
  const summary = {
    scannedOn: new Date().toISOString().slice(0, 10),
    source: FEED,
    servers: results.length,
    reachable,
    timedOut: results.filter((r) => r.error).length,
    withAnyBlocking: results.filter((r) => r.checks.some((c) => c.level === 'fail')).length,
    checks: Object.fromEntries([...byCheck].sort((a, b) => b[1].fail + b[1].warn - (a[1].fail + a[1].warn))),
  };

  await mkdir(OUT, { recursive: true });
  const stamp = summary.scannedOn;
  await writeFile(`${OUT}/summary-${stamp}.json`, JSON.stringify(summary, null, 2) + '\n');
  // Private: per-server rows for debugging the checks themselves. Never publish this file.
  await writeFile(
    `${OUT}/servers-${stamp}.jsonl`,
    results.map((r) => JSON.stringify({ url: r.entry.url, tier: r.entry.tier, error: r.error, failed: r.checks.filter((c) => c.level === 'fail').map((c) => c.id), warned: r.checks.filter((c) => c.level === 'warn').map((c) => c.id) })).join('\n') + '\n',
  );

  console.log(`${summary.servers} servers, ${summary.reachable} reachable, ${summary.withAnyBlocking} with something blocking, ${summary.timedOut} timed out.`);
  for (const [id, r] of Object.entries(summary.checks).slice(0, 15)) console.log(`  ${String(r.fail).padStart(5)} fail ${String(r.warn).padStart(5)} warn  ${id}  ${r.title}`);
  console.log(`\nWrote ${OUT}/summary-${stamp}.json (aggregate) and ${OUT}/servers-${stamp}.jsonl (private, gitignored).`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
