#!/usr/bin/env node
import { writeFile, access } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { McpClient } from './mcp-client.js';
import { MANIFEST_FILE, loadManifest } from './manifest.js';
import { preflight } from './preflight.js';
import { printPreflight } from './report.js';
import { STORE_NAMES, type Manifest, type StoreId } from './types.js';

const HELP = `mcplane: fastlane for MCP servers

Usage
  mcplane init --url <mcp url>        Create mcplane.json from your live server
  mcplane preflight [--store <id>]... Check against every store's rejection causes
      --url <mcp url>                 Check a server without a manifest
      --json                          Machine-readable output (exit 1 on blockers)
      --verbose                       List passing checks too
      --register                      Also test OAuth client registration (writes test clients)
      --token <token>                 Access token for servers behind sign-in (or MCPLANE_TOKEN)

Stores: ${Object.keys(STORE_NAMES).join(', ')}
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      url: { type: 'string' },
      store: { type: 'string', multiple: true },
      json: { type: 'boolean' },
      verbose: { type: 'boolean' },
      register: { type: 'boolean' },
      token: { type: 'string' },
    },
    allowPositionals: true,
  });

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
