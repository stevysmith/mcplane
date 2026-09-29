/**
 * Your submissions, kept in .mcplane/submissions.json (gitignored: it holds
 * the private tokens that update your Review Times reports), and logged to
 * Review Times so every wait counts toward the public numbers.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Manifest, StoreId } from './types.js';

const RT = process.env.MCPLANE_REVIEWTIMES_URL ?? 'https://reviewtimes.fyi';
const DIR = '.mcplane';
const FILE = `${DIR}/submissions.json`;

/** Review Times store slugs. Grok and Docker are read straight from their GitHub queues, so they aren't reported twice. */
const RT_SLUG: Partial<Record<StoreId, string>> = {
  chatgpt: 'chatgpt',
  'claude-connectors': 'claude-connectors',
  'claude-plugins': 'claude-plugins',
  cursor: 'cursor',
  muse: 'muse',
};
const TRACKED_FROM_GITHUB: StoreId[] = ['grok', 'docker'];

export interface Submission {
  store: StoreId;
  kind: 'new' | 'update' | 'resubmission';
  version?: string;
  submittedOn: string;
  status: 'waiting' | 'approved' | 'rejected' | 'withdrawn';
  decidedOn?: string;
  reviewTimes?: { token: string; shareUrl: string | null };
}

export async function load(dir = process.cwd()): Promise<Submission[]> {
  try {
    return JSON.parse(await readFile(resolve(dir, FILE), 'utf8')) as Submission[];
  } catch {
    return [];
  }
}

async function save(list: Submission[], dir = process.cwd()): Promise<void> {
  await mkdir(resolve(dir, DIR), { recursive: true });
  await writeFile(resolve(dir, FILE), JSON.stringify(list, null, 2) + '\n');
}

const today = () => new Date().toISOString().slice(0, 10);

/** What identifies this listing to Review Times' directory watch, so the report can close itself. */
function listingRef(m: Manifest, store: StoreId, appId?: string): string | undefined {
  if (store === 'chatgpt') return appId;
  if (store === 'claude-connectors' || store === 'muse') return m.server.url;
  if (store === 'claude-plugins' || store === 'cursor') return m.repository;
  return undefined;
}

export async function recordSubmitted(
  m: Manifest,
  store: StoreId,
  opts: { date?: string; kind?: Submission['kind']; version?: string; appId?: string; share?: boolean },
): Promise<{ submission: Submission; note: string }> {
  const s: Submission = { store, kind: opts.kind ?? 'new', version: opts.version, submittedOn: opts.date ?? today(), status: 'waiting' };
  let note: string;
  const slug = RT_SLUG[store];
  if (TRACKED_FROM_GITHUB.includes(store)) {
    note = 'Review Times reads this store’s review queue from GitHub, so it counts your pull request already.';
  } else if (!slug) {
    s.status = 'approved';
    s.decidedOn = s.submittedOn;
    note = 'This store publishes without a review, so it counts as live from today.';
  } else if (opts.share === false) {
    note = 'Kept locally only (--private).';
  } else {
    const res = await fetch(`${RT}/api/v1/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'mcplane' },
      body: JSON.stringify({ store: slug, submitted_on: s.submittedOn, status: 'waiting', kind: s.kind, listing_ref: listingRef(m, store, opts.appId) }),
    });
    const body = (await res.json().catch(() => ({}))) as { token?: string; share_url?: string | null; error?: string };
    if (!res.ok || !body.token) throw new Error(`Review Times didn't take the report: ${body.error ?? `HTTP ${res.status}`}`);
    s.reviewTimes = { token: body.token, shareUrl: body.share_url ?? null };
    note = `Logged to Review Times (anonymous). Public page: ${body.share_url ?? `${RT}/${slug}`}`;
  }
  const list = await load();
  list.push(s);
  await save(list);
  return { submission: s, note };
}

export async function recordDecision(store: StoreId, outcome: 'approved' | 'rejected' | 'withdrawn', date?: string): Promise<Submission> {
  const list = await load();
  const s = [...list].reverse().find((x) => x.store === store && x.status === 'waiting');
  if (!s) throw new Error(`No waiting ${store} submission recorded. Run "mcplane submitted ${store}" first.`);
  s.status = outcome;
  s.decidedOn = date ?? today();
  if (s.reviewTimes) {
    const res = await fetch(`${RT}/api/v1/reports/${s.reviewTimes.token}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'user-agent': 'mcplane' },
      body: JSON.stringify({ status: outcome, decided_on: s.decidedOn }),
    });
    if (!res.ok) throw new Error(`Review Times didn't take the update: HTTP ${res.status}`);
  }
  await save(list);
  return s;
}

export interface StatusRow {
  submission: Submission;
  days: number;
  typical: string | null;
}

/** Refreshes each waiting submission from Review Times (the directory watch may have closed it) and adds the store's typical wait. */
export async function status(): Promise<StatusRow[]> {
  const list = await load();
  const verdicts = new Map<string, string | null>();
  for (const s of list) {
    if (s.status === 'waiting' && s.reviewTimes) {
      const r = await fetch(`${RT}/api/v1/reports/${s.reviewTimes.token}`, { headers: { 'user-agent': 'mcplane' } }).catch(() => null);
      const b = r?.ok ? ((await r.json()) as { status?: Submission['status']; decided_on?: string | null }) : null;
      if (b?.status && b.status !== 'waiting') {
        s.status = b.status;
        s.decidedOn = b.decided_on ?? undefined;
      }
    }
    const slug = RT_SLUG[s.store] ?? (s.store === 'docker' ? 'docker-mcp' : s.store === 'grok' ? 'grok' : null);
    if (slug && !verdicts.has(slug)) {
      const r = await fetch(`${RT}/api/v1/stores/${slug}`, { headers: { 'user-agent': 'mcplane' } }).catch(() => null);
      verdicts.set(slug, r?.ok ? (((await r.json()) as { verdict?: string }).verdict ?? null) : null);
    }
  }
  await save(list);
  const dayMs = 86_400_000;
  return list.map((s) => {
    const end = s.decidedOn ? Date.parse(s.decidedOn) : Date.now();
    const slug = RT_SLUG[s.store] ?? (s.store === 'docker' ? 'docker-mcp' : s.store === 'grok' ? 'grok' : null);
    return { submission: s, days: Math.max(0, Math.floor((end - Date.parse(s.submittedOn)) / dayMs)), typical: slug ? (verdicts.get(slug) ?? null) : null };
  });
}
