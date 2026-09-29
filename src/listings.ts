/**
 * Where you're listed, and whether what went live matches. Every store with an
 * open record is read directly; a save that returned 200 is a claim, the
 * public record is the result. Coverage decays quietly, so this is meant to
 * run on a schedule.
 */
import { liveTools, repoHead } from './drift.js';
import { registryName } from './publish.js';
import { STORE_NAMES, type Manifest, type StoreId } from './types.js';

export interface Listing {
  store: StoreId;
  state: 'listed' | 'missing' | 'unknown';
  url?: string;
  /** Differences between the live record and your server or mcplane.json. */
  issues: string[];
  note?: string;
}

const UA = { 'user-agent': 'mcplane' };
/** Public feeds are sometimes slow (the registry has taken 40s); one retry with a longer wait. */
const getJson = async <T>(url: string): Promise<T | null> => {
  for (const wait of [15_000, 45_000]) {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(wait) }).catch(() => null);
    if (r?.ok) return (await r.json().catch(() => null)) as T | null;
  }
  return null;
};
const getText = async (url: string) => {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20_000) }).catch(() => null);
  return r?.ok ? r.text() : null;
};
const status = async (url: string) => (await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(20_000) }).catch(() => null))?.status ?? 0;
const norm = (s?: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();
const bare = (u?: string) => (u ?? '').replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase();

async function registry(m: Manifest): Promise<Listing> {
  const name = registryName(m);
  const data = await getJson<{ servers?: { server: { name: string; version: string; remotes?: { url: string }[] }; _meta?: Record<string, { status?: string; isLatest?: boolean }> }[] }>(
    `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(name)}`,
  );
  if (!data) return { store: 'mcp-registry', state: 'unknown', issues: [], note: 'Registry API did not answer.' };
  const mine = (data.servers ?? []).filter((x) => x.server.name === name);
  if (!mine.length) return { store: 'mcp-registry', state: 'missing', issues: [], note: `No ${name} in the registry. "mcplane publish mcp-registry".` };
  const latest = mine.find((x) => x._meta?.['io.modelcontextprotocol.registry/official']?.isLatest) ?? mine[mine.length - 1];
  const issues: string[] = [];
  const st = latest._meta?.['io.modelcontextprotocol.registry/official']?.status;
  if (st && st !== 'active') issues.push(`latest version is ${st}`);
  if (m.version && latest.server.version !== m.version) issues.push(`latest is v${latest.server.version}, mcplane.json says v${m.version}`);
  if (!latest.server.remotes?.some((r) => bare(r.url) === bare(m.server.url))) issues.push(`endpoint differs: ${latest.server.remotes?.map((r) => r.url).join(', ') || 'none'}`);
  return { store: 'mcp-registry', state: 'listed', url: `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(name)}`, issues };
}

async function claudeConnectors(m: Manifest, token?: string): Promise<Listing> {
  const data = await getJson<{ servers?: any[] }>('https://api.anthropic.com/api/directory/servers?verified_tier=anthropic,partner,community&visibility=commercial&limit=5000');
  if (!data) return { store: 'claude-connectors', state: 'unknown', issues: [], note: 'Anthropic’s directory feed did not answer.' };
  const hit = data.servers?.find((s) => bare(s.remote?.url ?? s.url) === bare(m.server.url) || norm(s.name).toLowerCase() === norm(m.title).toLowerCase());
  if (!hit) return { store: 'claude-connectors', state: 'missing', issues: [] };
  const issues: string[] = [];
  if (m.oneLiner && norm(hit.one_liner) !== norm(m.oneLiner)) issues.push('one-liner differs from mcplane.json');
  if (m.description && norm(hit.description) !== norm(m.description)) issues.push('description differs from mcplane.json');
  // The tool list is synced from your server at submission and isn't an editable field: compare it with what you serve now.
  const published: string[] = hit.tool_names ?? [];
  const live = (await liveTools(m, token).catch(() => [])).map((t) => t.name);
  if (live.length && published.length) {
    const missing = live.filter((n) => !published.includes(n));
    const gone = published.filter((n) => !live.includes(n));
    if (missing.length) issues.push(`listing doesn't show: ${missing.join(', ')} (ask the review team to resync)`);
    if (gone.length) issues.push(`listing still shows removed tools: ${gone.join(', ')}`);
  }
  const tier = hit.verified_tier ?? hit.tier;
  return { store: 'claude-connectors', state: 'listed', url: hit.directory_url ?? `https://claude.ai/directory/${hit.id}`, issues, note: tier ? `tier: ${tier}` : undefined };
}

async function claudePlugins(m: Manifest, head?: string): Promise<Listing> {
  if (!m.repository) return { store: 'claude-plugins', state: 'unknown', issues: [], note: 'No repository in mcplane.json.' };
  const data = await getJson<{ plugins?: { name: string; source?: { url?: string; sha?: string } }[] }>('https://raw.githubusercontent.com/anthropics/claude-plugins-community/main/.claude-plugin/marketplace.json');
  if (!data) return { store: 'claude-plugins', state: 'unknown', issues: [] };
  const hit = data.plugins?.find((p) => bare(p.source?.url) === bare(m.repository));
  if (!hit) return { store: 'claude-plugins', state: 'missing', issues: [], note: 'Not in the community marketplace mirror (synced nightly from Anthropic’s review).' };
  const issues = head && hit.source?.sha && hit.source.sha !== head ? [`serves ${hit.source.sha.slice(0, 7)}, your repo is at ${head.slice(0, 7)}`] : [];
  return { store: 'claude-plugins', state: 'listed', issues, note: `as "${hit.name}"` };
}

async function cursor(m: Manifest): Promise<Listing> {
  if (!m.repository) return { store: 'cursor', state: 'unknown', issues: [], note: 'No repository in mcplane.json.' };
  const page = await getText('https://cursor.com/marketplace');
  if (!page) return { store: 'cursor', state: 'unknown', issues: [] };
  const html = page.replace(/\\"/g, '"').toLowerCase();
  const found = html.includes(`"repositoryurl":"${bare(m.repository)}`);
  return { store: 'cursor', state: found ? 'listed' : 'missing', issues: [] };
}

async function grok(m: Manifest, head?: string): Promise<Listing> {
  const data = await getJson<{ plugins?: { name: string; source?: { url?: string; sha?: string } }[] }>('https://raw.githubusercontent.com/xai-org/plugin-marketplace/main/.grok-plugin/marketplace.json');
  if (!data) return { store: 'grok', state: 'unknown', issues: [] };
  const hit = data.plugins?.find((p) => p.name === m.name || (m.repository && bare(p.source?.url) === bare(m.repository)));
  if (!hit) return { store: 'grok', state: 'missing', issues: [] };
  const issues = head && hit.source?.sha && hit.source.sha !== head ? [`pinned to ${hit.source.sha.slice(0, 7)}, your repo is at ${head.slice(0, 7)}`] : [];
  return { store: 'grok', state: 'listed', issues };
}

async function glama(m: Manifest): Promise<Listing> {
  const url = `https://glama.ai/mcp/connectors/${registryName(m)}`;
  const code = await status(url);
  if (code === 200) return { store: 'glama', state: 'listed', url, issues: [], note: 'Imported from the registry. Claim it with glama.json so the score badge is yours.' };
  if (code === 404) return { store: 'glama', state: 'missing', issues: [], note: 'Glama imports connectors from the official registry; publish there first.' };
  return { store: 'glama', state: 'unknown', issues: [] };
}

async function awesome(m: Manifest, store: StoreId, repo: string): Promise<Listing> {
  const readme = await getText(`https://raw.githubusercontent.com/${repo}/main/README.md`);
  if (!readme) return { store, state: 'unknown', issues: [] };
  const text = readme.toLowerCase();
  const keys = [m.server.url, m.repository, m.links?.website].filter(Boolean).map((u) => bare(u));
  return { store, state: keys.some((k) => text.includes(k)) ? 'listed' : 'missing', issues: [] };
}

async function docker(m: Manifest): Promise<Listing> {
  const code = await status(`https://github.com/docker/mcp-registry/tree/main/servers/${m.name}`);
  return { store: 'docker', state: code === 200 ? 'listed' : code === 404 ? 'missing' : 'unknown', issues: [] };
}

export function printListings(rows: Listing[]): void {
  const mark = { listed: '✓', missing: '·', unknown: '?' } as const;
  for (const r of rows) {
    const flag = r.state === 'listed' && r.issues.length ? '✗' : mark[r.state];
    console.log(`${flag} ${STORE_NAMES[r.store].padEnd(28)} ${r.state}${r.note ? `  (${r.note})` : ''}`);
    if (r.url && r.state === 'listed') console.log(`    ${r.url}`);
    for (const i of r.issues) console.log(`    ${i}`);
  }
  const listed = rows.filter((r) => r.state === 'listed');
  console.log(`\nListed on ${listed.length} of ${rows.length}; ${listed.filter((r) => r.issues.length).length} need a fix. ? means no public record to read.`);
}

const MANUAL: Partial<Record<StoreId, string>> = {
  chatgpt: 'OpenAI’s directory can’t be read automatically. Open your plugin page and compare.',
  muse: 'Meta publishes no directory feed yet.',
  smithery: 'Check smithery.ai; its public "verified" flag can lag behind passed proofs.',
  cline: 'Cline’s marketplace has no public feed; watch your submission issue.',
  lobehub: 'Check market.lobehub.com.',
};

export async function listings(m: Manifest, stores: StoreId[], opts: { token?: string } = {}): Promise<Listing[]> {
  const head = await repoHead(m.repository);
  const jobs: Promise<Listing>[] = stores.map((s) => {
    if (s === 'mcp-registry') return registry(m);
    if (s === 'claude-connectors') return claudeConnectors(m, opts.token);
    if (s === 'claude-plugins') return claudePlugins(m, head);
    if (s === 'cursor') return cursor(m);
    if (s === 'grok') return grok(m, head);
    if (s === 'glama') return glama(m);
    if (s === 'awesome-mcp-servers') return awesome(m, s, 'punkpeye/awesome-mcp-servers');
    if (s === 'awesome-remote-mcp-servers') return awesome(m, s, 'punkpeye/awesome-remote-mcp-servers');
    if (s === 'docker') return docker(m);
    return Promise.resolve({ store: s, state: 'unknown' as const, issues: [], note: MANUAL[s] });
  });
  return Promise.all(jobs);
}
