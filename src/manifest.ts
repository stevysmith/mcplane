import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { McpClient } from './mcp-client.js';
import { STORE_NAMES, type Manifest, type StoreId } from './types.js';

export const MANIFEST_FILE = 'mcplane.json';
export const SCHEMA_URL = 'https://unpkg.com/mcplane/schema.json';

export async function loadManifest(dir = process.cwd()): Promise<Manifest> {
  const path = resolve(dir, MANIFEST_FILE);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(`No ${MANIFEST_FILE} here. Run "mcplane init --url <your MCP server URL>" to create one.`);
  }
  let m: Manifest;
  try {
    m = JSON.parse(raw) as Manifest;
  } catch (e) {
    throw new Error(`${MANIFEST_FILE} isn't valid JSON: ${(e as Error).message}`);
  }
  const problems: string[] = [];
  if (!m.name) problems.push('"name" is required');
  if (!m.title) problems.push('"title" is required');
  if (!m.server?.url) problems.push('"server.url" is required');
  for (const s of m.stores ?? []) if (!(s in STORE_NAMES)) problems.push(`unknown store "${s}"`);
  if (problems.length) throw new Error(`${MANIFEST_FILE}: ${problems.join('; ')}`);
  return m;
}

/**
 * Creates .mcplane with its own .gitignore: snapshots are committed (CI reads
 * them for drift), while submissions (private Review Times tokens) and packs stay local.
 */
export async function ensureLocalDir(dir = process.cwd()): Promise<string> {
  const d = resolve(dir, '.mcplane');
  await mkdir(d, { recursive: true });
  await writeFile(resolve(d, '.gitignore'), 'submissions.json\npacks/\n', { flag: 'wx' }).catch(() => null);
  return d;
}

export function storesOf(m: Manifest): StoreId[] {
  return m.stores?.length ? m.stores : (Object.keys(STORE_NAMES) as StoreId[]);
}

/** A starting manifest from what the live server and its domain reveal. */
export async function draftManifest(url: string): Promise<Manifest> {
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
    $schema: SCHEMA_URL,
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

