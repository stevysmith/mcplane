/**
 * Readiness for MCP 2026-07-28: warnings and notes, never blockers. The revision drops the
 * initialize handshake for per-request _meta and server/discover, requires Mcp-Method and Mcp-Name
 * headers on Streamable HTTP, deprecates Dynamic Client Registration for Client ID Metadata
 * Documents, and has clients validate the issuer (RFC 8414 §3.3, RFC 9207). A warning means a
 * 2026-07-28 client would fail today; a note means something deprecated or optional.
 *
 * Spec:         https://modelcontextprotocol.io/specification/2026-07-28
 * Key changes:  https://modelcontextprotocol.io/specification/2026-07-28/changelog
 * Release post: https://blog.modelcontextprotocol.io/posts/2026-07-28/
 */
import { McpClient, type RpcReply } from '../mcp-client.js';
import type { Check } from '../types.js';
import { VERSION } from '../version.js';
import { metadata, type Discovery } from './oauth.js';

export const MODERN = '2026-07-28';
/** Handshake-era revisions, any of which is a fine answer to an initialize. */
const LEGACY = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];

/** Every modern request carries its version, client and capabilities in _meta (basic/versioning). */
const META = {
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientInfo': { name: 'mcplane', version: VERSION },
  'io.modelcontextprotocol/clientCapabilities': {},
};
/** MCP-Protocol-Version and Mcp-Method go on every modern POST (basic/transports/streamable-http#request-metadata). */
const modernHeaders = (method: string) => ({ 'mcp-protocol-version': MODERN, 'mcp-method': method });

const check = (id: string, level: Check['level'], title: string, more: Partial<Check> = {}): Check => ({ id: `readiness.${id}`, level, title, ...more });
const rpcError = (r: RpcReply | null) => (r?.body?.error ? `JSON-RPC ${r.body.error.code}${r.body.error.message ? ` ${String(r.body.error.message).slice(0, 80)}` : ''}` : '');
const said = (r: RpcReply | null) => (r ? [`HTTP ${r.status}`, rpcError(r)].filter(Boolean).join(', ') : 'no answer');

export type Era = 'modern' | 'legacy' | 'auth' | 'broken';

/**
 * Reads the answer to a modern server/discover request the way a dual-era client does
 * (basic/versioning#backward-compatibility): a DiscoverResult or a modern error means a modern
 * server; a 4xx or a JSON-RPC error that isn't modern means a legacy one, and the client falls
 * back to initialize. A 5xx, or no JSON-RPC answer at all, gives it nothing to go on.
 */
export function eraOf(r: RpcReply | null): { era: Era; versions: string[]; detail: string } {
  if (!r) return { era: 'broken', versions: [], detail: 'no answer' };
  if (r.status === 401) return { era: 'auth', versions: [], detail: 'HTTP 401' };
  const versions = r.body?.result?.supportedVersions;
  if (Array.isArray(versions)) return { era: 'modern', versions, detail: `supportedVersions ${versions.join(', ')}` };
  // UnsupportedProtocolVersionError (-32022): modern, but not this version.
  if (r.body?.error?.code === -32022) return { era: 'modern', versions: r.body.error.data?.supported ?? [], detail: said(r) };
  if (r.status >= 500) return { era: 'broken', versions: [], detail: said(r) };
  if (typeof r.body?.error?.code === 'number' || r.status >= 400) return { era: 'legacy', versions: [], detail: said(r) };
  return { era: 'broken', versions: [], detail: `HTTP ${r.status} without a JSON-RPC answer` };
}

export function eraCheck(e: ReturnType<typeof eraOf>): Check {
  const title = 'Speaks MCP 2026-07-28';
  if (e.era === 'modern' && e.versions.includes(MODERN)) return check('era', 'pass', title, { detail: `server/discover: ${e.detail}` });
  if (e.era === 'modern') return check('era', 'info', title, { detail: `server/discover: ${e.detail}`, fix: 'Modern, but not 2026-07-28: clients retry with a version from your supported list.' });
  if (e.era === 'auth') return check('era', 'skip', title, { detail: 'the server answers 401 before sign-in', fix: 'Run again with --token <access token> to check how a 2026-07-28 client gets on after signing in.' });
  if (e.era === 'legacy')
    return check('era', 'info', title, {
      detail: `legacy only: server/discover got ${e.detail}`,
      fix: 'Nothing breaks yet: clients that speak both eras fall back to initialize. To serve 2026-07-28 clients directly, move to an SDK release that implements it (TypeScript, Python, Go and C# do) and answer server/discover.',
    });
  return check('era', 'warn', title, {
    detail: `server/discover got ${e.detail}`,
    fix: 'A 2026-07-28 client’s first request gets an error page. Clients that speak both eras fall back to initialize on a 4xx or a JSON-RPC error, so answer methods you don’t know with JSON-RPC -32601 instead of failing.',
  });
}

/**
 * An initialize that offers 2026-07-28. Under the 2025-11-25 lifecycle a server answers with the
 * requested version only if it supports it, otherwise with one it does; 2026-07-28 has no initialize
 * at all, so the right answer is a handshake-era version. A modern-only server rejects initialize
 * and SHOULD name its versions in the error (basic/versioning).
 * https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#version-negotiation
 */
export function initializeCheck(r: RpcReply | null, era: Era): Check {
  const title = 'An initialize that offers 2026-07-28 is negotiated down';
  if (r?.status === 401) return check('initialize', 'skip', title, { detail: 'HTTP 401', fix: 'Run again with --token <access token>.' });
  const v = r?.body?.result?.protocolVersion;
  if (v === MODERN)
    return check('initialize', 'warn', title, {
      detail: 'initialize answered with "2026-07-28"',
      fix: '2026-07-28 has no initialize handshake, so answering one with it tells the client you speak something you don’t. Answer with the newest version you implement (e.g. 2025-11-25). A handler that copies params.protocolVersion back is the usual cause: check it against a supported list.',
    });
  if (typeof v === 'string' && LEGACY.includes(v)) return check('initialize', 'pass', title, { detail: `answered with ${v}` });
  if (typeof v === 'string') return check('initialize', 'warn', title, { detail: `answered with "${v}", which isn't a published version`, fix: 'Answer with a version you implement, such as 2025-11-25.' });
  if (era === 'modern') {
    const named = /\d{4}-\d{2}-\d{2}/.test(JSON.stringify(r?.body ?? ''));
    return named
      ? check('initialize', 'pass', title, { detail: `modern only: initialize got ${said(r)}, naming the versions it supports` })
      : check('initialize', 'info', title, {
          detail: `modern only: initialize got ${said(r)}`,
          fix: 'Name the versions you support in that error. Clients from before 2026-07-28 have no way forward, and the error is the only thing they can show.',
        });
  }
  return check('initialize', 'warn', title, {
    detail: `initialize got ${said(r)}`,
    fix: 'Answer with a version you support instead of an error. Under the 2025-11-25 lifecycle a server that doesn’t support the requested version replies with one it does, and clients that offer their newest version first fail against you otherwise.',
  });
}

/** Modern servers: a tools/list carrying Mcp-Method is the ordinary case. A strict server rejects one without it (-32020). */
export function modernHeaderCheck(r: RpcReply | null): Check {
  const title = 'Accepts the Mcp-Method and Mcp-Name headers';
  return r && r.status < 300 && r.body?.result
    ? check('headers', 'pass', title, { detail: 'a 2026-07-28 tools/list with Mcp-Method works (Mcp-Name only goes on tools/call, resources/read and prompts/get, which this probe doesn’t send)' })
    : check('headers', 'warn', title, { detail: `a 2026-07-28 tools/list with Mcp-Method got ${said(r)}`, fix: 'Mcp-Method is required on every 2026-07-28 POST and must match the body’s method.' });
}

/** Legacy servers: the same tools/list with and without the new headers should get the same answer. */
export function legacyHeaderCheck(plain: RpcReply | null, tagged: RpcReply | null): Check {
  const title = 'Accepts the Mcp-Method and Mcp-Name headers';
  const ok = (r: RpcReply | null) => !!r && r.status < 300 && !r.body?.error;
  if (!ok(plain)) return check('headers', 'skip', title, { detail: `tools/list got ${said(plain)} without them, so there was nothing to compare` });
  return ok(tagged)
    ? check('headers', 'pass', title, { detail: 'tools/list answers the same with Mcp-Method and Mcp-Name set' })
    : check('headers', 'warn', title, {
        detail: `tools/list works, but with Mcp-Method and Mcp-Name set it got ${said(tagged)}`,
        fix: '2026-07-28 clients send these on every request, and gateways route on them. A firewall rule, proxy or header allowlist is rejecting them: let Mcp-* headers through.',
      });
}

/** Browser clients send both headers on every POST, so the CORS preflight must allow them. Null when the server doesn't answer CORS at all (server.cors covers that). */
export function corsCheck(allowOrigin: string | null, allowHeaders: string | null): Check | null {
  if (!allowOrigin) return null;
  const allowed = (allowHeaders ?? '').toLowerCase().split(',').map((h) => h.trim());
  const missing = ['mcp-method', 'mcp-name'].filter((h) => !allowed.includes(h) && !allowed.includes('*'));
  return missing.length
    ? check('cors', 'info', 'CORS allows the Mcp-Method and Mcp-Name headers', {
        detail: `Access-Control-Allow-Headers: ${allowHeaders ?? 'missing'}`,
        fix: `Add ${missing.join(' and ')} to Access-Control-Allow-Headers. Browser-based 2026-07-28 clients send them on every request, and the preflight fails without them.`,
      })
    : check('cors', 'pass', 'CORS allows the Mcp-Method and Mcp-Name headers');
}

/**
 * MCP Events is a draft, not part of 2026-07-28: events/list, events/poll, events/stream and
 * events/subscribe, from the Triggers and Events Working Group. Reported, never a warning.
 * https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md
 */
export function eventsCheck(r: RpcReply | null): Check {
  const title = 'Lists MCP Events (events/list, a draft)';
  const events = r?.body?.result?.events;
  if (Array.isArray(events)) return check('events', 'pass', title, { detail: events.length ? events.map((e: { name?: string }) => e.name).join(', ') : 'no event types yet' });
  if (r?.status === 401) return check('events', 'skip', title, { detail: 'HTTP 401' });
  return check('events', 'info', title, {
    detail: `events/list got ${said(r)}`,
    fix: 'Nothing to do yet. Events is a draft from the Triggers and Events Working Group, not part of 2026-07-28; if it lands, servers declare event types with events/list.',
  });
}

/** 2026-07-28 clients MUST check the metadata's issuer against the issuer they built the URL from, and MUST NOT use it otherwise (authorization-server-discovery). */
export function issuerCheck(d: Discovery): Check | null {
  const doc = d.oauth ?? d.oidc;
  if (!doc?.forIssuer) return null;
  const title = 'The metadata’s issuer matches its URL';
  const iss = doc.json?.issuer;
  if (iss === doc.forIssuer) return check('issuer', 'pass', title, { detail: iss });
  return check('issuer', 'warn', title, {
    detail: typeof iss === 'string' ? `${doc.url} says "${iss}", expected "${doc.forIssuer}"` : `${doc.url} has no issuer`,
    fix: 'Make issuer exactly the identifier the well-known URL is built from, trailing slash included (RFC 8414 §3.3). 2026-07-28 clients must refuse metadata whose issuer differs.',
  });
}

/** client_id_metadata_document_supported: DCR is deprecated in 2026-07-28 for CIMD, removable from the first revision on or after 2027-07-28. */
export function cimdCheck(md: Record<string, any>): Check {
  const title = 'Client ID Metadata Documents are advertised';
  return md.client_id_metadata_document_supported === true
    ? check('cimd', 'pass', title)
    : check('cimd', 'info', title, {
        detail: md.registration_endpoint ? 'Dynamic Client Registration only' : 'neither CIMD nor Dynamic Client Registration',
        fix: '2026-07-28 deprecates Dynamic Client Registration in favour of Client ID Metadata Documents; DCR can go in the first revision on or after 2027-07-28. Accept URL client_ids, fetch and validate the document, and advertise client_id_metadata_document_supported: true.',
      });
}

/** authorization_response_iss_parameter_supported (RFC 9207): a SHOULD in 2026-07-28, expected to become a MUST. */
export function issCheck(md: Record<string, any>): Check {
  const title = 'The authorization server returns iss (RFC 9207)';
  return md.authorization_response_iss_parameter_supported === true
    ? check('iss', 'pass', title)
    : check('iss', 'info', title, {
        detail: 'authorization_response_iss_parameter_supported not declared',
        fix: 'Return iss in authorization responses, error responses included, and advertise authorization_response_iss_parameter_supported: true. It is a SHOULD in 2026-07-28 and expected to become a MUST; clients already compare any iss they get.',
      });
}

export async function readinessChecks(url: string, auth: 'none' | 'oauth', opts: { token?: string; oauth?: Discovery | null } = {}): Promise<Check[]> {
  const bearer: Record<string, string> = opts.token ? { authorization: `Bearer ${opts.token}` } : {};
  // Each modern request stands alone: a fresh client, so no session id goes with it.
  const modern = (method: string) => new McpClient(url, bearer).request(method, { _meta: META }, { headers: modernHeaders(method) }).catch(() => null);
  const e = eraOf(await modern('server/discover'));
  const checks: Check[] = [eraCheck(e)];

  if (e.era !== 'auth') {
    const init = await new McpClient(url, bearer).request('initialize', { protocolVersion: MODERN, capabilities: {}, clientInfo: { name: 'mcplane', version: VERSION } }).catch(() => null);
    checks.push(initializeCheck(init, e.era));
    if (e.era === 'modern') {
      checks.push(modernHeaderCheck(await modern('tools/list')));
      checks.push(eventsCheck(await modern('events/list')));
    } else {
      const c = new McpClient(url, bearer);
      const opened = await c.initialize().catch(() => null);
      if (opened && opened.status < 300) {
        const plain = await c.request('tools/list').catch(() => null);
        const tagged = await c.request('tools/list', undefined, { headers: { 'mcp-method': 'tools/list', 'mcp-name': 'mcplane-probe' } }).catch(() => null);
        checks.push(legacyHeaderCheck(plain, tagged));
        checks.push(eventsCheck(await c.request('events/list').catch(() => null)));
      }
    }
    const pre = await fetch(url, {
      method: 'OPTIONS',
      headers: { origin: 'https://chatgpt.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, mcp-protocol-version, mcp-method, mcp-name' },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    const cors = pre && pre.status < 300 ? corsCheck(pre.headers.get('access-control-allow-origin'), pre.headers.get('access-control-allow-headers')) : null;
    if (cors) checks.push(cors);
  }

  // From the discovery documents alone, so these run before sign-in too.
  const md = metadata(opts.oauth);
  if (auth === 'oauth' && opts.oauth && md) {
    const iss = issuerCheck(opts.oauth);
    if (iss) checks.push(iss);
    checks.push(cimdCheck(md), issCheck(md));
  }
  return checks;
}
