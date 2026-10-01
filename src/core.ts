/**
 * mcplane's checks for any runtime with fetch (Workers, Deno, browsers' servers).
 * Import from "mcplane/core".
 */
import { ardChecks } from './checks/ard.js';
import { authChecks } from './checks/auth.js';
import { chainChecks } from './checks/chain.js';
import { listingChecks, repoChecks } from './checks/listing.js';
import { discover } from './checks/oauth.js';
import { readinessChecks } from './checks/readiness.js';
import { serverChecks } from './checks/server.js';
import { toolChecks } from './checks/tools.js';
import { VERCEL_REMINDERS, vercelChecks } from './checks/vercel.js';
import { storesOf } from './draft.js';
import type { SocketCheck } from './checks/server.js';
import type { Check, Manifest, StoreId } from './types.js';

export interface PreflightResult {
  checks: Check[];
  reminders: string[];
  stores: StoreId[];
}

/** Things no script can see, which have still cost real submissions. */
function reminders(m: Manifest, stores: StoreId[]): string[] {
  const r: string[] = [];
  if (m.server.auth === 'oauth') {
    r.push('Give reviewers a demo account a stranger can use: email and password (not your Google or SSO login), email already confirmed, no 2FA or SMS, seeded with data for every test case. Re-check the seed right before submitting.');
    r.push('Sign in through your OAuth flow once as a brand-new user. A blank post-sign-in redirect stranded a ChatGPT reviewer between registration and consent.');
  }
  if (stores.some((s) => s === 'chatgpt' || s === 'claude-connectors')) {
    r.push('If a tool writes somewhere public (posts, sends, publishes), give reviewers a safe target: a sandbox account or a "playground" option that validates and then discards. Reviewers test writes; they shouldn’t post to a real timeline.');
  }
  if (stores.includes('chatgpt')) {
    r.push('ChatGPT needs a demo video recorded in developer mode that shows the tools your test cases use. Re-record it whenever tools change ("mcplane demo" records it on a Mac with ChatGPT desktop).');
    r.push('After "Submit for Review" the ChatGPT portal shows nothing for about 20 seconds. Confirm the status on the plugins list, not the button.');
    r.push('OpenAI no longer asks for hint justifications: its automated review checks each tool’s hints. If it flags one you believe is right, appeal with an explanation.');
    r.push('ChatGPT allows one version in review at a time. To change a submission, Cancel Review and resubmit the same draft.');
  }
  if (stores.includes('claude-connectors') || stores.includes('claude-plugins')) {
    if (stores.includes('claude-connectors')) r.push('Claude connectors are submitted from an organisation’s admin settings (claude.ai/directory/manage), so you need admin rights in a paid org. The tool list is synced from your server when you submit; it is not an editable field.');
    if (stores.includes('claude-plugins')) r.push('Run "claude plugin validate --strict" in the plugin repo; the portal validates every commit on the branch it tracks.');
    r.push('Claude: "Passed review" is not the same as listed. Check claude.ai/directory for your listing after approval; with the new portal you choose when to publish.');
  }
  if (stores.includes('vercel-connect') && m.server.auth === 'oauth') r.push(...VERCEL_REMINDERS);
  return r;
}

/** Runtime-neutral: fetch only. Node adds socket checks (TLS 1.2) through extraChecks; see preflight-node. */
export async function preflight(m: Manifest, opts: { stores?: StoreId[]; register?: boolean; token?: string; extraChecks?: SocketCheck[] } = {}): Promise<PreflightResult> {
  const stores = opts.stores?.length ? opts.stores : storesOf(m);
  const auth = m.server.auth ?? 'none';
  const server = await serverChecks(m.server.url, auth, opts.token, opts.extraChecks);
  // One read of the OAuth discovery documents, shared by the sign-in chain, Vercel Connect and readiness checks.
  const oauth = auth === 'oauth' ? await discover(m.server.url).catch(() => null) : null;
  // A server that doesn't answer at all has already failed; probing it for the next revision adds nothing.
  const down = server.checks.some((c) => c.id === 'server.reachable' && c.level === 'fail');
  const [authC, chain, listing, repo, ard, readiness] = await Promise.all([
    auth === 'oauth' ? authChecks(m.server.url, { register: opts.register }) : Promise.resolve([]),
    auth === 'oauth' ? chainChecks(m, oauth).catch(() => []) : Promise.resolve([]),
    listingChecks(m, server.tools, stores),
    repoChecks(m, stores),
    ardChecks(m),
    down ? Promise.resolve([]) : readinessChecks(m.server.url, auth, { token: opts.token, oauth }),
  ]);
  const vercel = stores.includes('vercel-connect') ? vercelChecks(m, oauth) : [];
  const all = [...server.checks, ...authC, ...chain, ...toolChecks(server.tools), ...listing, ...repo, ...vercel, ...ard, ...readiness];
  // Keep checks that apply to every store or to one we're submitting to.
  const checks = all.filter((c) => !c.stores?.length || c.stores.some((s) => stores.includes(s)));
  return { checks, reminders: reminders(m, stores), stores };
}

export { draftManifest, forStore, storesOf, SCHEMA_URL } from './draft.js';
export { toolChecks } from './checks/tools.js';
export { validateArd, ardManifest } from './checks/ard.js';
export { STORE_NAMES } from './types.js';
export type { Check, Level, Manifest, StoreId, Tool } from './types.js';
