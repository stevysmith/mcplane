import type { Check, StoreId } from '../types.js';

const STORES: StoreId[] = ['muse'];
const TITLE = 'Muse can verify your server';

/** Where Muse looks for the file: the MCP server's own host, over HTTPS. */
export const museChallengeUrl = (serverUrl: string, token: string) => `https://${new URL(serverUrl).hostname}/.well-known/muse-challenge/${encodeURIComponent(token)}`;

/**
 * Muse's Verify server step (platform.muse.ai, Technical details): a file at
 * https://<MCP host>/.well-known/muse-challenge/<token> whose body is exactly "muse-challenge=<token>", as plain
 * text, HTTP 200 over HTTPS on 443, with no sign-in or redirect. Muse sends no OAuth token, API key or cookie,
 * and neither does this check. `url` fetches from somewhere else (tests); the port rule still reads serverUrl.
 */
export async function museChallengeCheck(serverUrl: string, token: string, opts: { url?: string } = {}): Promise<Check> {
  const server = new URL(serverUrl);
  const at = opts.url ?? museChallengeUrl(serverUrl, token);
  const expected = `muse-challenge=${token}`;
  const fix = `Serve ${at} with a body of exactly "${expected}" as plain text: HTTP 200 over HTTPS on port 443, with no sign-in and no redirect (Muse sends no OAuth token, API key or cookie). The token expires about 24 hours after the portal shows it, and Muse allows one attempt a minute. Verify before you run Test: verifying again asks for the test again.`;
  const fail = (detail: string, why = fix): Check => ({ id: 'listing.muse-challenge', level: 'fail', title: TITLE, detail, fix: why, stores: STORES });
  if (server.protocol !== 'https:' || (server.port && server.port !== '443')) return fail(`${server.origin} isn't HTTPS on port 443`, `Muse fetches the file over HTTPS on port 443 from your MCP server's host. ${fix}`);
  const res = await fetch(at, { redirect: 'manual', headers: { 'user-agent': 'mcplane' }, signal: AbortSignal.timeout(12_000) }).catch(() => null);
  if (!res) return fail(`${at} didn't answer`);
  if (res.status >= 300 && res.status < 400) return fail(`HTTP ${res.status} redirect${res.headers.get('location') ? ` to ${res.headers.get('location')}` : ''}`, `Muse follows no redirects. ${fix}`);
  if (res.status === 401 || res.status === 403) return fail(`HTTP ${res.status}: the file needs sign-in`, `Exempt /.well-known/muse-challenge/ from sign-in and bot checks. ${fix}`);
  if (res.status !== 200) return fail(`HTTP ${res.status}`);
  const body = await res.text();
  const type = res.headers.get('content-type') ?? '';
  if (body === expected) {
    return /^text\/plain\b/i.test(type)
      ? { id: 'listing.muse-challenge', level: 'pass', title: TITLE, detail: `${at} answers "${expected}". If Muse still says "We couldn't confirm what happened", check your logs for its request before you change anything.`, stores: STORES }
      : { id: 'listing.muse-challenge', level: 'warn', title: TITLE, detail: `the body is right, but the content type is ${type || 'missing'}`, fix: `Muse asks for plain text: serve it as text/plain. ${fix}`, stores: STORES };
  }
  if (body.trim() === expected) return { id: 'listing.muse-challenge', level: 'warn', title: TITLE, detail: 'the body matches apart from spaces or a line break around it', fix: `Muse asks for exactly "${expected}". Drop the trailing newline if you can. ${fix}`, stores: STORES };
  if (/<(!doctype|html)\b/i.test(body)) return fail('answers with a web page, not the token (a single-page app serving its index for unknown paths does this)');
  return fail(`the body is "${body.trim().slice(0, 60)}${body.trim().length > 60 ? '…' : ''}", not "${expected}"`);
}
