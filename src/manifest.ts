import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { STORE_NAMES, type Manifest } from './types.js';

export { draftManifest, forStore, storesOf } from './draft.js';

export const MANIFEST_FILE = 'mcplane.json';
export { SCHEMA_URL } from './draft.js';

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

