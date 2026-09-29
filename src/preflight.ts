import { authChecks } from './checks/auth.js';
import { listingChecks, repoChecks } from './checks/listing.js';
import { serverChecks } from './checks/server.js';
import { toolChecks } from './checks/tools.js';
import { storesOf } from './manifest.js';
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
    r.push('Give reviewers a demo account: email and password, no 2FA, SMS or email confirmation, seeded with data that matches every test case. Re-check the seed right before submitting.');
    r.push('Sign in through your OAuth flow once as a brand-new user. A blank post-sign-in redirect stranded a ChatGPT reviewer between registration and consent.');
  }
  if (stores.includes('chatgpt')) {
    r.push('ChatGPT needs a demo video recorded in developer mode that shows the tools your test cases use. Re-record it whenever tools change.');
    r.push('After "Submit for Review" the ChatGPT portal shows nothing for about 20 seconds. Confirm the status on the plugins list, not the button.');
    r.push('Tool-annotation justifications are cut at 200 characters without warning.');
    r.push('ChatGPT allows one version in review at a time. To change a submission, Cancel Review and resubmit the same draft.');
  }
  if (stores.includes('claude-connectors') || stores.includes('claude-plugins')) {
    if (stores.includes('claude-plugins')) r.push('Run "claude plugin validate --strict" in the plugin repo; the portal validates every commit on the branch it tracks.');
    r.push('Claude: "Passed review" is not the same as listed. Check claude.ai/directory for your listing after approval; with the new portal you choose when to publish.');
  }
  return r;
}

export async function preflight(m: Manifest, opts: { stores?: StoreId[]; register?: boolean; token?: string } = {}): Promise<PreflightResult> {
  const stores = opts.stores?.length ? opts.stores : storesOf(m);
  const auth = m.server.auth ?? 'none';
  const server = await serverChecks(m.server.url, auth, opts.token);
  const [authC, listing, repo] = await Promise.all([
    auth === 'oauth' ? authChecks(m.server.url, { register: opts.register }) : Promise.resolve([]),
    listingChecks(m, server.tools, stores),
    repoChecks(m, stores),
  ]);
  const all = [...server.checks, ...authC, ...toolChecks(server.tools), ...listing, ...repo];
  // Keep checks that apply to every store or to one we're submitting to.
  const checks = all.filter((c) => !c.stores?.length || c.stores.some((s) => stores.includes(s)));
  return { checks, reminders: reminders(m, stores), stores };
}
