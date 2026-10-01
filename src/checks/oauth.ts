/**
 * OAuth discovery the way Vercel Connect and MCP clients run it, from the documents alone:
 * protected-resource metadata (RFC 9728) on the MCP host, then the authorization server's
 * RFC 8414 metadata and OpenID Connect discovery, path-suffixed forms included. Read-only:
 * nothing is registered.
 *
 * https://vercel.com/docs/connect/providers
 * https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery
 */

export interface Doc {
  url: string;
  /** 0 when nothing answered. */
  status: number;
  contentType: string;
  /** The body, when it parsed as a JSON object. */
  json: Record<string, any> | null;
  /** The issuer identifier this URL was built from (RFC 8414 §3.3: the document's issuer must equal it). */
  forIssuer?: string;
}

export interface Discovery {
  /** The MCP server URL discovery started from. */
  resource: string;
  /** Protected-resource metadata, when a well-known URL answered with it. */
  prm: Doc | null;
  /** The first authorization server named in the PRM, else the MCP URL itself (what Vercel Connect is given). */
  issuer: string;
  /** Every RFC 8414 URL tried, in order, and the one that answered with JSON. */
  oauthTried: Doc[];
  oauth: Doc | null;
  /** Every OpenID Connect URL tried, in order, and the one that answered with JSON. */
  oidcTried: Doc[];
  oidc: Doc | null;
}

/** Well-known URLs for an issuer or resource. RFC 8414 §3.1 inserts the suffix between host and path; OIDC also appends it. */
export function wellKnown(base: string, suffix: string): { inserted: string | null; origin: string; appended: string | null } {
  const u = new URL(base);
  const path = u.pathname.replace(/\/+$/, '');
  return {
    inserted: path ? `${u.origin}/.well-known/${suffix}${path}` : null,
    origin: `${u.origin}/.well-known/${suffix}`,
    appended: path ? `${u.origin}${path}/.well-known/${suffix}` : null,
  };
}

export const isJsonType = (t: string) => /\bjson\b/i.test(t);

async function getDoc(url: string, forIssuer?: string): Promise<Doc> {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'mcplane' }, redirect: 'follow', signal: AbortSignal.timeout(10_000) }).catch(() => null);
  const contentType = res?.headers.get('content-type') ?? '';
  const text = res ? await res.text().catch(() => '') : '';
  let json: Record<string, any> | null = null;
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) json = v;
  } catch {}
  return { url, status: res?.status ?? 0, contentType, json, forIssuer };
}

/** A document a client would use: 200, served as JSON, a JSON object. */
export const usable = (d: Doc | null | undefined): d is Doc => !!d && d.status === 200 && !!d.json && isJsonType(d.contentType);

/** Tries each [url, issuer it was built from] in order, skipping forms that don't apply, and stops at the first usable document. */
async function firstOf(...urls: [string | null, string][]): Promise<{ tried: Doc[]; hit: Doc | null }> {
  const tried: Doc[] = [];
  for (const [url, issuer] of urls) {
    if (!url) continue;
    const d = await getDoc(url, issuer);
    tried.push(d);
    if (usable(d)) return { tried, hit: d };
  }
  return { tried, hit: null };
}

export async function discover(resource: string): Promise<Discovery> {
  const pr = wellKnown(resource, 'oauth-protected-resource');
  const prm = await firstOf([pr.inserted, ''], [pr.origin, '']);
  const named = prm.hit?.json?.authorization_servers;
  const issuer = Array.isArray(named) && typeof named[0] === 'string' ? named[0] : resource;
  const as = wellKnown(issuer, 'oauth-authorization-server');
  const oi = wellKnown(issuer, 'openid-configuration');
  // The issuer a document must declare is the identifier its URL was built from, exactly. For a path
  // issuer, the origin form (which Vercel Connect also reads) was built from the origin.
  const atOrigin = as.inserted ? new URL(issuer).origin : issuer;
  // MCP clients try the path-suffixed forms first.
  const [oauth, oidc] = await Promise.all([firstOf([as.inserted, issuer], [as.origin, atOrigin]), firstOf([oi.inserted, issuer], [oi.appended, issuer], [oi.origin, atOrigin])]);
  return { resource, prm: prm.hit, issuer, oauthTried: oauth.tried, oauth: oauth.hit, oidcTried: oidc.tried, oidc: oidc.hit };
}

/** What a client reads: the OAuth document, with gaps filled from OpenID Connect discovery (Vercel Connect does this). */
export const metadata = (d: Discovery | null | undefined): Record<string, any> | null =>
  d && (d.oauth || d.oidc) ? { ...(d.oidc?.json ?? {}), ...(d.oauth?.json ?? {}) } : null;
