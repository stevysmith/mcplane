/**
 * The sign-in chain a reviewer walks: the authorization endpoint, the page it sends them to, and the
 * identity-provider hosts that page loads. Plain GETs, as a browser would send them: nothing signs in
 * and no client is registered, so an authorization server that checks client_id first stops the walk
 * at its own error, and server.signIn (or --sign-in) names the pages to check from there.
 *
 * A bot challenge (Cloudflare's cf-mitigated: challenge) or a 403 anywhere on the chain leaves the
 * OAuth window blank or erroring, often only from the data-centre networks reviewers use, while every
 * check on the MCP server itself passes.
 */
import type { Check, Manifest } from '../types.js';
import { metadata, type Discovery } from './oauth.js';

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
/** Where ChatGPT sends the user back; an authorization server reporting an error redirects here, and we stop. */
const REDIRECT_URI = 'https://chatgpt.com/connector_platform_oauth_redirect';
/** RFC 7636's example S256 challenge: fixed, so the request is the same every run. */
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const MAX_REDIRECTS = 5;
const MAX_PAGES = 6;
/** Every GET the chain makes, redirects included. */
const MAX_REQUESTS = 16;
/** Host or path words that mark a sign-in page or an identity provider. */
const AUTHISH = /(^|[./-])(accounts?|auth|authorize|login|log-in|signin|sign-in|sso|oauth2?|identity|idp|clerk|auth0|okta|cognito|stytch|workos|kinde|descope|frontegg|microsoftonline|appleid)([./-]|$)/i;
const ASSET = /\.(css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|map)(\?|$)/i;

export interface Hop {
  url: string;
  status: number;
  /** What walled it off, if anything. */
  wall: string | null;
  location?: string;
  contentType?: string;
  /** A short reason from the body of an error answer (invalid_client, …). */
  said?: string;
  error?: string;
}

/** A bot challenge or a refusal, read from the response the way a browser would get it. */
export function wallOf(status: number, headers: Headers): string | null {
  const cf = headers.get('cf-mitigated');
  if (cf && /challenge/i.test(cf)) return 'Cloudflare challenge (cf-mitigated: challenge)';
  const aws = headers.get('x-amzn-waf-action');
  if (aws && /challenge|captcha/i.test(aws)) return `AWS WAF ${aws.toLowerCase()} (x-amzn-waf-action)`;
  const vercel = headers.get('x-vercel-mitigated');
  if (vercel && /challenge/i.test(vercel)) return 'Vercel challenge (x-vercel-mitigated: challenge)';
  if (status === 403) return 'HTTP 403';
  return null;
}

/** Sign-in pages and identity-provider URLs a page links to or loads. */
export function authLinks(html: string, base: string): string[] {
  const found = new Set<string>();
  const add = (raw: string) => {
    try {
      const u = new URL(raw.replace(/&amp;/g, '&'), base);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return;
      u.hash = '';
      if (ASSET.test(u.pathname) || !AUTHISH.test(`${u.hostname}${u.pathname}`)) return;
      found.add(u.toString());
    } catch {}
  };
  for (const m of html.matchAll(/\b(?:href|src|action)\s*=\s*["']([^"'<>\s]+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s"'<>`)\\]*)?/gi)) add(m[0]);
  for (const m of html.matchAll(/<meta[^>]+http-equiv\s*=\s*["']refresh["'][^>]*content\s*=\s*["'][^"']*?\burl\s*=\s*([^"']+)["']/gi)) add(m[1].trim());
  return [...found];
}

async function fetchHop(url: string): Promise<{ hop: Hop; html?: string }> {
  const res = await fetch(url, {
    redirect: 'manual',
    headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'en' },
    signal: AbortSignal.timeout(10_000),
  }).catch((e: Error) => e);
  if (res instanceof Error) return { hop: { url, status: 0, wall: null, error: res.name === 'TimeoutError' ? 'timed out' : res.message } };
  const type = res.headers.get('content-type') ?? '';
  const location = res.headers.get('location') ?? undefined;
  const text = /html|json|text/.test(type) && !location ? await res.text().catch(() => '') : '';
  let said: string | undefined;
  if (res.status >= 400 && text) {
    const json = /json/.test(type) ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
    said = json?.error ? String(json.error) : /plain/.test(type) ? text.trim().slice(0, 60) : undefined;
  }
  const hop: Hop = { url, status: res.status, wall: wallOf(res.status, res.headers), location, contentType: type.split(';')[0] || undefined, said };
  return { hop, html: /html/.test(type) ? text : undefined };
}

/** Requests left for one chain, so a long redirect loop or a page full of links can't run away (Workers cap subrequests). */
export interface Budget {
  left: number;
}

/** GETs a URL and follows its redirects by hand, recording every hop. Never follows into the client's redirect URI. */
export async function walk(start: string, budget: Budget = { left: MAX_REQUESTS }): Promise<{ hops: Hop[]; html?: string; last: string }> {
  const hops: Hop[] = [];
  let url = start;
  for (let i = 0; i <= MAX_REDIRECTS && budget.left > 0; i++) {
    budget.left--;
    const { hop, html } = await fetchHop(url);
    hops.push(hop);
    if (!hop.location || hop.status < 300 || hop.status >= 400) return { hops, html, last: url };
    const next = new URL(hop.location, url).toString();
    if (next.startsWith(REDIRECT_URI) || !/^https?:/.test(next)) return { hops, last: url };
    url = next;
  }
  return { hops, last: url };
}

/** The authorization request a client would open, for a client that isn't registered. */
export function authorizeUrl(endpoint: string, md: Record<string, any>, resource: string): string {
  const u = new URL(endpoint);
  const scopes: string[] = Array.isArray(md.scopes_supported) ? md.scopes_supported : [];
  const q: Record<string, string> = {
    response_type: 'code',
    client_id: 'mcplane-preflight',
    redirect_uri: REDIRECT_URI,
    state: 'mcplane',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    resource,
    ...(scopes.length ? { scope: scopes.join(' ') } : {}),
  };
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return u.toString();
}

const show = (h: Hop) => `${h.url.split('?')[0]}: ${h.wall ?? (h.error ? h.error : `HTTP ${h.status}${h.said ? ` (${h.said})` : ''}`)}`;

/** The chain's hops as one check. Exported for tests. */
export function chainCheck(start: Hop[], pages: Hop[][], opts: { stoppedEarly: boolean; seeded: boolean }): Check {
  const title = 'Reviewers can reach your sign-in page';
  const all = [...start, ...pages.flat()];
  const walls = all.filter((h) => h.wall);
  if (walls.length) {
    return {
      id: 'auth.chain',
      level: 'warn',
      title,
      detail: walls.map(show).join('; '),
      fix: 'A bot challenge or a 403 on the sign-in chain leaves the OAuth window blank for reviewers, who sign in from data-centre networks, often through a TLS-inspecting proxy. ChatGPT reports it as "Sign-in could not load". Exempt the authorization endpoint, consent page and sign-in hosts from bot challenges (in Cloudflare, a WAF skip rule for Bot Fight Mode and managed challenges on those hosts and paths), or serve sign-in from a host without one. A pass from your own network proves less: run this again from a cloud VM or CI.',
    };
  }
  const visited = [...new Set(all.filter((h) => !h.error).map((h) => new URL(h.url).host))];
  const failed = all.filter((h) => h.error);
  if (opts.stoppedEarly && !opts.seeded && !pages.length) {
    return {
      id: 'auth.chain',
      level: 'info',
      title,
      detail: `stopped at the authorization endpoint: ${show(start[start.length - 1])}. Without a registered client it doesn't send anyone on to sign in`,
      fix: 'List the sign-in page and identity-provider URLs your consent screen uses in server.signIn in mcplane.json (or pass --sign-in <url>), and preflight checks them for bot challenges and 403s too.',
    };
  }
  return {
    id: 'auth.chain',
    level: 'pass',
    title,
    detail: `no bot challenge or 403 on ${visited.join(', ') || 'the chain'}${failed.length ? `; no answer from ${failed.map(show).join(', ')}` : ''}`,
  };
}

export async function chainChecks(m: Manifest, d: Discovery | null): Promise<Check[]> {
  const md = metadata(d);
  const endpoint = md?.authorization_endpoint;
  if (typeof endpoint !== 'string' || !/^https?:\/\//.test(endpoint)) return [];
  const budget: Budget = { left: MAX_REQUESTS };
  const start = await walk(authorizeUrl(endpoint, md!, m.server.url), budget);
  const last = start.hops[start.hops.length - 1];
  // A 4xx with no page to read means the server wants a registered client before it goes any further.
  const stoppedEarly = !start.html && last.status >= 400;
  const seeds = (Array.isArray(m.server.signIn) ? m.server.signIn : typeof m.server.signIn === 'string' ? [m.server.signIn] : []).filter((u) => /^https?:\/\//.test(u));
  const seen = new Set<string>([...start.hops.map((h) => h.url)]);
  const queue = [...seeds, ...(start.html ? authLinks(start.html, start.last) : [])].filter((u) => !seen.has(u));
  const pages: Hop[][] = [];
  // Two rounds: the pages the chain names, then the identity-provider hosts those pages load.
  for (let round = 0; round < 2 && queue.length && pages.length < MAX_PAGES && budget.left > 0; round++) {
    const batch = [...new Set(queue.splice(0))].filter((u) => !seen.has(u)).slice(0, Math.min(MAX_PAGES - pages.length, budget.left));
    batch.forEach((u) => seen.add(u));
    const results = await Promise.all(batch.map((u) => walk(u, budget)));
    for (const r of results) {
      pages.push(r.hops);
      r.hops.forEach((h) => seen.add(h.url));
      if (r.html) queue.push(...authLinks(r.html, r.last));
    }
  }
  return [chainCheck(start.hops, pages, { stoppedEarly, seeded: seeds.length > 0 })];
}
