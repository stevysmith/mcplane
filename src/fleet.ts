/**
 * Fleet: many MCP servers, one view. Finds every mcplane.json under a folder
 * (your ~/Projects, a monorepo) and runs checks across all of them, so
 * seventeen apps cost the same attention as one.
 */
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { drift } from './drift.js';
import { MANIFEST_FILE, loadManifest, storesOf } from './manifest.js';
import { preflight } from './preflight.js';
import { load } from './submissions.js';
import type { Manifest, StoreId } from './types.js';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.mcplane', '.next', '.wrangler', 'vendor', 'target']);

export interface Project {
  dir: string;
  path: string;
  manifest?: Manifest;
  error?: string;
}

/** Folders under root that hold an mcplane.json, depth-first, a few levels down. */
export async function findProjects(root = process.cwd(), depth = 3): Promise<Project[]> {
  const found: Project[] = [];
  const walk = async (dir: string, level: number) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    if (entries.some((e) => e.isFile() && e.name === MANIFEST_FILE)) {
      const p: Project = { dir, path: relative(root, dir) || '.' };
      try {
        p.manifest = await loadManifest(dir);
      } catch (e) {
        p.error = (e as Error).message;
      }
      found.push(p);
    }
    if (level >= depth) return;
    for (const e of entries) if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) await walk(join(dir, e.name), level + 1);
  };
  await walk(resolve(root), 0);
  return found;
}

/** Runs fn over items, a few at a time. */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

export interface FleetRow {
  project: string;
  name?: string;
  url?: string;
  blocking?: number;
  toReview?: number;
  driftActions?: { store: StoreId; what: string }[];
  noSnapshot?: StoreId[];
  waiting: { store: StoreId; since: string }[];
  live: StoreId[];
  error?: string;
}

/** Preflight, drift and submissions for every project under root. Checks run four projects at a time. */
export async function fleet(root = process.cwd(), opts: { checks?: boolean; token?: string } = {}): Promise<FleetRow[]> {
  const projects = await findProjects(root);
  return pool(projects, 4, async (p): Promise<FleetRow> => {
    const subs = await load(p.dir);
    const row: FleetRow = {
      project: p.path,
      name: p.manifest?.title,
      url: p.manifest?.server.url,
      waiting: subs.filter((s) => s.status === 'waiting').map((s) => ({ store: s.store, since: s.submittedOn })),
      live: [...new Set(subs.filter((s) => s.status === 'approved').map((s) => s.store))],
      error: p.error,
    };
    if (!p.manifest || opts.checks === false) return row;
    try {
      const r = await preflight(p.manifest, { token: opts.token });
      row.blocking = r.checks.filter((c) => c.level === 'fail').length;
      row.toReview = r.checks.filter((c) => c.level === 'warn').length;
      const d = await drift(p.manifest, storesOf(p.manifest), { token: opts.token }, p.dir);
      row.driftActions = d.items.filter((i) => i.level === 'action').map((i) => ({ store: i.store, what: i.what }));
      row.noSnapshot = d.missing;
    } catch (e) {
      row.error = (e as Error).message;
    }
    return row;
  });
}

export function printFleet(rows: FleetRow[]): void {
  if (!rows.length) {
    console.log(`No ${MANIFEST_FILE} found here or a few folders down. Run "mcplane init --url <server>" in each project.`);
    return;
  }
  for (const r of rows) {
    const bits = [
      r.error ? `error: ${r.error}` : r.blocking === undefined ? '' : r.blocking ? `${r.blocking} blocking` : 'preflight clean',
      r.toReview ? `${r.toReview} to review` : '',
      r.driftActions?.length ? `${r.driftActions.length} store update${r.driftActions.length === 1 ? '' : 's'} needed` : '',
      r.waiting.length ? `waiting on ${r.waiting.map((w) => w.store).join(', ')}` : '',
      r.live.length ? `live on ${r.live.join(', ')}` : '',
    ].filter(Boolean);
    const mark = r.error || r.blocking || r.driftActions?.length ? '✗' : '✓';
    console.log(`${mark} ${(r.name ?? r.project).padEnd(24)} ${bits.join(' · ')}`);
    for (const a of r.driftActions ?? []) console.log(`    ${a.store}: ${a.what}`);
  }
  const bad = rows.filter((r) => r.error || r.blocking || r.driftActions?.length).length;
  console.log(`\n${rows.length} project${rows.length === 1 ? '' : 's'}, ${bad} need${bad === 1 ? 's' : ''} attention. Details: cd into one and run "mcplane preflight" or "mcplane drift".`);
}

/** Runs one mcplane command in every project, one after another. */
export async function fleetRun(root: string, args: string[]): Promise<number> {
  const projects = (await findProjects(root)).filter((p) => p.manifest);
  let failed = 0;
  for (const p of projects) {
    console.log(`\n━━ ${p.manifest!.title} (${p.path})`);
    const r = spawnSync(process.execPath, [...process.execArgv, process.argv[1], ...args], { cwd: p.dir, stdio: 'inherit' });
    if (r.status !== 0) failed++;
  }
  console.log(`\n${projects.length - failed} of ${projects.length} succeeded.`);
  return failed ? 1 : 0;
}
