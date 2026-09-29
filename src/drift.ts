/**
 * Drift: what changed since each store last saw your server, and what each
 * store needs because of it. A snapshot of tools and listing text is saved
 * whenever you record a submission (or `mcplane baseline`); drift compares
 * the live server and mcplane.json against it.
 *
 * Every store calls your live server, so behaviour fixes reach users on their
 * own. What doesn't: listing text, tool names in Claude's listing, hint
 * justifications, registry versions and plugins pinned to a commit.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ensureLocalDir } from './manifest.js';
import { McpClient } from './mcp-client.js';
import { STORE_NAMES, type Manifest, type StoreId, type Tool } from './types.js';

interface ToolShape {
  name: string;
  title?: string;
  description?: string;
  hints: { readOnly?: boolean; destructive?: boolean; openWorld?: boolean };
  input: string;
  output: string;
}

export interface Snapshot {
  store: StoreId;
  takenOn: string;
  version?: string;
  state: 'submitted' | 'live';
  tools: ToolShape[];
  listing: Record<string, string | undefined>;
  repoSha?: string;
}

export interface DriftItem {
  store: StoreId;
  level: 'action' | 'info';
  what: string;
  todo: string;
}

const DIR = '.mcplane/snapshots';

/** JSON with sorted keys, so reordering isn't a change. */
function canon(v: unknown): string {
  if (v === undefined || v === null) return '';
  const sort = (x: any): any => (Array.isArray(x) ? x.map(sort) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x);
  return JSON.stringify(sort(v));
}

function shape(t: Tool): ToolShape {
  return {
    name: t.name,
    title: t.title ?? t.annotations?.title,
    description: t.description,
    hints: { readOnly: t.annotations?.readOnlyHint, destructive: t.annotations?.destructiveHint, openWorld: t.annotations?.openWorldHint },
    input: canon(t.inputSchema),
    output: canon(t.outputSchema),
  };
}

function listingOf(m: Manifest): Record<string, string | undefined> {
  return {
    title: m.title,
    subtitle: m.subtitle,
    oneLiner: m.oneLiner,
    description: m.description,
    icon: m.icon,
    privacy: m.links?.privacy,
    support: m.links?.support,
    website: m.links?.website,
  };
}

export async function liveTools(m: Manifest, token?: string): Promise<Tool[]> {
  const c = new McpClient(m.server.url, token ? { authorization: `Bearer ${token}` } : {});
  const init = await c.initialize();
  if (init.status >= 400) throw new Error(`Couldn't read tools from ${m.server.url} (HTTP ${init.status})${m.server.auth === 'oauth' ? '; pass --token' : ''}.`);
  return ((await c.request('tools/list')).body?.result?.tools ?? []) as Tool[];
}

/** HEAD of the plugin repository on GitHub, when there is one. */
export async function repoHead(repository?: string): Promise<string | undefined> {
  const gh = repository?.match(/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?$/);
  if (!gh) return undefined;
  const headers: Record<string, string> = { 'user-agent': 'mcplane', accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(`https://api.github.com/repos/${gh[1]}/${gh[2]}/commits/HEAD`, { headers }).catch(() => null);
  return r?.ok ? ((await r.json()) as { sha?: string }).sha : undefined;
}

export async function takeSnapshot(m: Manifest, store: StoreId, opts: { version?: string; state: Snapshot['state']; token?: string }, dir = process.cwd()): Promise<Snapshot> {
  const [tools, repoSha] = await Promise.all([liveTools(m, opts.token), repoHead(m.repository)]);
  const snap: Snapshot = {
    store,
    takenOn: new Date().toISOString().slice(0, 10),
    version: opts.version,
    state: opts.state,
    tools: tools.map(shape),
    listing: listingOf(m),
    repoSha,
  };
  await ensureLocalDir(dir);
  await mkdir(resolve(dir, DIR), { recursive: true });
  await writeFile(resolve(dir, DIR, `${store}.json`), JSON.stringify(snap, null, 2) + '\n');
  return snap;
}

export async function markLive(store: StoreId, dir = process.cwd()): Promise<void> {
  const snap = await readSnapshot(store, dir);
  if (!snap) return;
  snap.state = 'live';
  await writeFile(resolve(dir, DIR, `${store}.json`), JSON.stringify(snap, null, 2) + '\n');
}

async function readSnapshot(store: StoreId, dir = process.cwd()): Promise<Snapshot | null> {
  try {
    return JSON.parse(await readFile(resolve(dir, DIR, `${store}.json`), 'utf8')) as Snapshot;
  } catch {
    return null;
  }
}

/** What changed between a snapshot and now, as plain descriptions. */
export function diffTools(before: ToolShape[], now: ToolShape[]) {
  const b = new Map(before.map((t) => [t.name, t]));
  const n = new Map(now.map((t) => [t.name, t]));
  const added = [...n.keys()].filter((k) => !b.has(k));
  const removed = [...b.keys()].filter((k) => !n.has(k));
  const changed: { tool: string; fields: string[] }[] = [];
  for (const [name, t] of n) {
    const o = b.get(name);
    if (!o) continue;
    const fields: string[] = [];
    for (const h of ['readOnly', 'destructive', 'openWorld'] as const) if (o.hints[h] !== t.hints[h]) fields.push(`${h}Hint ${o.hints[h]} → ${t.hints[h]}`);
    if (o.input !== t.input) fields.push('inputs');
    if (o.output !== t.output) fields.push('outputSchema');
    if ((o.title ?? '') !== (t.title ?? '')) fields.push('title');
    if ((o.description ?? '') !== (t.description ?? '')) fields.push('description');
    if (fields.length) changed.push({ tool: name, fields });
  }
  return { added, removed, changed };
}

/** Grok bumps pins daily; this reads the pin it currently serves. */
async function grokPin(name: string): Promise<string | undefined> {
  const r = await fetch('https://raw.githubusercontent.com/xai-org/plugin-marketplace/main/.grok-plugin/marketplace.json', { headers: { 'user-agent': 'mcplane' } }).catch(() => null);
  const data = r?.ok ? ((await r.json().catch(() => null)) as { plugins?: { name: string; source?: { sha?: string } }[] } | null) : null;
  return data?.plugins?.find((p) => p.name === name)?.source?.sha;
}

export async function drift(m: Manifest, stores: StoreId[], opts: { token?: string } = {}, dir = process.cwd()): Promise<{ items: DriftItem[]; missing: StoreId[] }> {
  const items: DriftItem[] = [];
  const missing: StoreId[] = [];
  const [live, head] = await Promise.all([liveTools(m, opts.token), repoHead(m.repository)]);
  const now = live.map(shape);
  const listing = listingOf(m);

  for (const store of stores) {
    const snap = await readSnapshot(store, dir);
    if (!snap) {
      missing.push(store);
      continue;
    }
    const d = diffTools(snap.tools, now);
    const toolChange = d.added.length + d.removed.length + d.changed.length > 0;
    const listingChange = Object.keys(listing).filter((k) => (listing[k] ?? '') !== (snap.listing[k] ?? ''));
    const summary = [
      d.added.length && `added ${d.added.join(', ')}`,
      d.removed.length && `removed ${d.removed.join(', ')}`,
      ...d.changed.map((c) => `${c.tool}: ${c.fields.join(', ')}`),
    ]
      .filter(Boolean)
      .join('; ');
    const since = `since ${snap.state === 'live' ? 'the live version' : 'your submission'}${snap.version ? ` (v${snap.version})` : ''} on ${snap.takenOn}`;

    if (store === 'chatgpt') {
      // OpenAI rescans published servers: removals apply at once, new and changed tools after automated checks.
      // Listing text is part of the version and needs a new one.
      const hintChanges = d.changed.filter((c) => c.fields.some((f) => f.includes('Hint')));
      if (toolChange)
        items.push({
          store,
          level: 'info',
          what: `Tools changed ${since}: ${summary}`,
          todo: `No resubmission needed for tools: OpenAI rescans your server, drops removed tools at once and switches new or changed ones over after they pass automated checks (the old definition stays live until then).${d.added.length || d.removed.length ? ' Update the test cases and demo video in your next version.' : ''}`,
        });
      if (hintChanges.length)
        items.push({ store, level: 'action', what: `Hints changed: ${hintChanges.map((c) => c.tool).join(', ')}`, todo: 'Your published version’s justifications explain the old values. Put new ones in the next version ("mcplane pack chatgpt").' });
      if (listingChange.length) items.push({ store, level: 'action', what: `Listing text changed (${listingChange.join(', ')})`, todo: 'Listing changes need a new version, review and publication: "mcplane pack chatgpt", import it into a new version, submit.' });
    }
    if (store === 'claude-connectors') {
      if (d.added.length || d.removed.length)
        items.push({ store, level: 'action', what: `Tool list changed ${since}: ${summary}`, todo: 'Edit the listing’s tool names in claude.ai/directory/manage (changes are reviewed before going live).' });
      const hintChanges = d.changed.filter((c) => c.fields.some((f) => f.includes('Hint')));
      if (hintChanges.length)
        items.push({ store, level: 'action', what: `Safety hints changed: ${hintChanges.map((c) => `${c.tool} (${c.fields.filter((f) => f.includes('Hint')).join(', ')})`).join('; ')}`, todo: 'Reviewers check hints against your read/write answer. Update it if needed and add a line to the listing’s Additional notes.' });
      const other = d.changed.filter((c) => !c.fields.every((f) => f.includes('Hint')));
      if (other.length && !d.added.length && !d.removed.length) items.push({ store, level: 'info', what: `Tool details changed: ${other.map((c) => c.tool).join(', ')}`, todo: 'Claude reads descriptions and schemas live; nothing to resubmit.' });
      if (listingChange.length) items.push({ store, level: 'action', what: `Listing text changed (${listingChange.join(', ')})`, todo: 'Edit the listing in claude.ai/directory/manage.' });
    }
    if (store === 'claude-plugins' || store === 'cursor') {
      if (head && snap.repoSha && head !== snap.repoSha)
        items.push({ store, level: store === 'cursor' ? 'action' : 'info', what: `Plugin repo moved on ${since} (${snap.repoSha.slice(0, 7)} → ${head.slice(0, 7)})`, todo: store === 'cursor' ? 'Cursor pins marketplace plugins to the commit that was current when they were added and doesn’t document updates. Resubmit at cursor.com/marketplace/publish, or ask Cursor to re-pin.' : 'The portal picks up commits on the branch it tracks (push webhook or scheduled check) and validates them; a reviewer publishes each version unless you have auto-publish. Check claude.ai/directory/manage.' });
    }
    if (store === 'grok' && head) {
      const pinned = await grokPin(m.name);
      if (pinned && pinned !== head)
        items.push({ store, level: 'info', what: `Grok serves ${pinned.slice(0, 7)}; your repo is at ${head.slice(0, 7)}`, todo: 'xAI bumps pins daily. If it’s still behind tomorrow, "mcplane publish grok" opens a pin-bump pull request.' });
    }
    if (store === 'muse' && (toolChange || listingChange.length)) {
      items.push({ store, level: 'info', what: `Changed ${since}: ${[summary, listingChange.length && `listing ${listingChange.join(', ')}`].filter(Boolean).join('; ')}`, todo: 'Meta hasn’t published an update process yet. Update the listing in muse.ai/platform if it shows old details.' });
    }
    if (store === 'mcp-registry' && (toolChange || listingChange.length)) {
      items.push({ store, level: 'action', what: `Changed ${since}`, todo: 'Bump the version and run "mcplane publish mcp-registry".' });
    }
  }
  return { items, missing };
}

export function printDrift(r: { items: DriftItem[]; missing: StoreId[] }): void {
  if (!r.items.length) console.log('No drift: every store with a snapshot matches your live server and mcplane.json.');
  for (const i of r.items) {
    console.log(`${i.level === 'action' ? '✗' : '•'} ${STORE_NAMES[i.store]}: ${i.what}`);
    console.log(`    ${i.todo}`);
  }
  if (r.missing.length) console.log(`\nNo snapshot yet for ${r.missing.map((s) => STORE_NAMES[s]).join(', ')}. Run "mcplane baseline <store>" for listings that are already live.`);
}
