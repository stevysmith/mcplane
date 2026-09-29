#!/usr/bin/env node
import { writeFile, access } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { McpClient } from './mcp-client.js';
import { MANIFEST_FILE, loadManifest } from './manifest.js';
import { preflight } from './preflight.js';
import { printPreflight } from './report.js';
import { STORE_NAMES, type Manifest, type StoreId } from './types.js';
import { recordDecision, recordSubmitted, status } from './submissions.js';

const HELP = `mcplane: fastlane for MCP servers

Usage
  mcplane init --url <mcp url>        Create mcplane.json from your live server
  mcplane preflight [--store <id>]... Check against every store's rejection causes
      --url <mcp url>                 Check a server without a manifest
      --json                          Machine-readable output (exit 1 on blockers)
      --verbose                       List passing checks too
      --register                      Also test OAuth client registration (writes test clients)
      --token <token>                 Access token for servers behind sign-in (or MCPLANE_TOKEN)
  mcplane submitted <store>           Record a submission and log it to Review Times
      --date YYYY-MM-DD --kind new|update|resubmission --version x.y.z
      --app-id asdk_app_...           ChatGPT: your app id, so its draft date is checked
      --private                       Keep it local; don't log to Review Times
  mcplane decided <store> approved|rejected|withdrawn [--date YYYY-MM-DD]
  mcplane status                      Every submission, how long it's waited, and the store's typical wait

Stores: ${Object.keys(STORE_NAMES).join(', ')}
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      url: { type: 'string' },
      store: { type: 'string', multiple: true },
      json: { type: 'boolean' },
      verbose: { type: 'boolean' },
      register: { type: 'boolean' },
      token: { type: 'string' },
      date: { type: 'string' },
      kind: { type: 'string' },
      version: { type: 'string' },
      'app-id': { type: 'string' },
      private: { type: 'boolean' },
    },
    allowPositionals: true,
  });
  const asStore = (v: string | undefined): StoreId => {
    if (!v || !(v in STORE_NAMES)) throw new Error(`Which store? One of: ${Object.keys(STORE_NAMES).join(', ')}`);
    return v as StoreId;
  };

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return;
  }

  if (cmd === 'init') {
    if (!values.url) throw new Error('mcplane init needs --url <your MCP server URL>');
    const exists = await access(MANIFEST_FILE).then(() => true, () => false);
    if (exists) throw new Error(`${MANIFEST_FILE} already exists.`);
    const m = await draftManifest(values.url);
    await writeFile(MANIFEST_FILE, JSON.stringify(m, null, 2) + '\n');
    console.log(`Wrote ${MANIFEST_FILE}. Fill in the blanks, then run "mcplane preflight".`);
    return;
  }

  if (cmd === 'preflight') {
    const m = values.url ? await draftManifest(values.url) : await loadManifest();
    const stores = (values.store ?? []) as StoreId[];
    for (const s of stores) if (!(s in STORE_NAMES)) throw new Error(`Unknown store "${s}". Stores: ${Object.keys(STORE_NAMES).join(', ')}`);
    const r = await preflight(m, { stores, register: values.register, token: values.token ?? process.env.MCPLANE_TOKEN });
    if (values.json) console.log(JSON.stringify(r, null, 2));
    else printPreflight(r, { verbose: values.verbose });
    process.exitCode = r.checks.some((c) => c.level === 'fail') ? 1 : 0;
    return;
  }

  if (cmd === 'submitted') {
    const m = await loadManifest();
    const store = asStore(positionals[0]);
    const kind = (values.kind ?? 'new') as 'new' | 'update' | 'resubmission';
    const { submission, note } = await recordSubmitted(m, store, { date: values.date, kind, version: values.version, appId: values['app-id'], share: !values.private });
    console.log(`Recorded: ${STORE_NAMES[store]}, submitted ${submission.submittedOn}${submission.version ? ` (v${submission.version})` : ''}.`);
    console.log(note);
    return;
  }

  if (cmd === 'decided') {
    const store = asStore(positionals[0]);
    const outcome = positionals[1] as 'approved' | 'rejected' | 'withdrawn';
    if (!['approved', 'rejected', 'withdrawn'].includes(outcome)) throw new Error('Say how it went: approved, rejected or withdrawn.');
    const s = await recordDecision(store, outcome, values.date);
    console.log(`${STORE_NAMES[store]}: ${outcome} on ${s.decidedOn}, ${Math.round((Date.parse(s.decidedOn!) - Date.parse(s.submittedOn)) / 86_400_000)} days after submitting.`);
    return;
  }

  if (cmd === 'status') {
    const rows = await status();
    if (!rows.length) {
      console.log('No submissions recorded yet. After you submit, run "mcplane submitted <store>".');
      return;
    }
    if (values.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    for (const r of rows) {
      const s = r.submission;
      const state = s.status === 'waiting' ? `waiting ${r.days} day${r.days === 1 ? '' : 's'}` : `${s.status} after ${r.days} day${r.days === 1 ? '' : 's'}`;
      console.log(`${STORE_NAMES[s.store].padEnd(22)} ${s.submittedOn}  ${state}${s.version ? `  v${s.version}` : ''}`);
      if (r.typical && s.status === 'waiting') console.log(`${''.padEnd(22)} Store right now: ${r.typical}`);
    }
    return;
  }

  throw new Error(`Unknown command "${cmd}". Run "mcplane help".`);
}

/** A starting manifest from what the live server and its domain reveal. */
async function draftManifest(url: string): Promise<Manifest> {
  const client = new McpClient(url);
  const init = await client.initialize().catch(() => null);
  const auth = init?.status === 401 ? 'oauth' : 'none';
  const info = init?.body?.result?.serverInfo ?? {};
  const host = new URL(url).hostname;
  const labels = host.split('.');
  // api.example.com and mcp.example.com usually keep their pages on example.com.
  const origins = [`https://${host}`, ...(labels.length > 2 ? [`https://${labels.slice(1).join('.')}`] : [])];
  const origin = origins[origins.length - 1];
  const found = async (p: string) => {
    for (const o of origins) {
      const r = await fetch(o + p, { method: 'GET', redirect: 'follow' }).catch(() => null);
      if (r?.ok && !(r.headers.get('content-type') ?? '').includes('json')) return o + p;
    }
    return undefined;
  };
  const first = async (...paths: string[]) => {
    for (const p of paths) {
      const hit = await found(p);
      if (hit) return hit;
    }
    return undefined;
  };
  const [privacy, support, terms, docs, icon] = await Promise.all([
    first('/privacy', '/privacy-policy', '/legal/privacy'),
    first('/support', '/contact', '/help'),
    first('/terms', '/terms-of-service', '/legal/terms'),
    first('/llms.txt', '/docs'),
    first('/icon-512.png', '/icon.png', '/apple-touch-icon.png'),
  ]);
  return {
    name: String(info.name ?? new URL(url).hostname.split('.')[0]),
    title: String(info.title ?? info.name ?? ''),
    subtitle: '',
    oneLiner: '',
    description: '',
    server: { url, auth },
    author: { name: '', url: origin },
    links: { website: origin, support, privacy, terms, docs },
    icon,
    stores: ['mcp-registry', 'chatgpt', 'claude-connectors', 'cursor', 'muse'],
  };
}

main().catch((e) => {
  console.error(`mcplane: ${(e as Error).message}`);
  process.exitCode = 2;
});
