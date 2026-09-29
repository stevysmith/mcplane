/** Runtime-neutral pieces of the manifest: fetch only, no filesystem. */
import { McpClient } from './mcp-client.js';
import { STORE_NAMES, type Manifest, type StoreId } from './types.js';

export const SCHEMA_URL = 'https://unpkg.com/mcplane/schema.json';

/** The manifest as one store sees it: that store's listing text over the shared fields. */
export function forStore(m: Manifest, store: StoreId): Manifest {
  const o = m.listing?.[store];
  if (!o) return m;
  const set = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''));
  return { ...m, ...set };
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

