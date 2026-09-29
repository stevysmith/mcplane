/**
 * OAuth checks, from Stacktree's ChatGPT rounds. Read-only by default:
 * registering a client writes to your authorization server, so that only
 * happens with --register.
 */
import type { Check } from '../types.js';

const REDIRECTS = {
  chatgpt: ['https://chatgpt.com/connector_platform_oauth_redirect', 'https://platform.openai.com/apps-manage/oauth'],
  claude: ['https://claude.ai/api/mcp/auth_callback'],
  native: ['cursor://anysphere.cursor-mcp/oauth/callback', 'grok://oauth/callback'],
};

const json = async (url: string) => {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'mcplane' }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  return { res, body: res?.ok ? ((await res.json().catch(() => null)) as any) : null };
};

export async function authChecks(url: string, opts: { register?: boolean } = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const u = new URL(url);

  // An unauthenticated call must say how to sign in.
  const bare = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': 'mcplane' },
    body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcplane","version":"0.1.0"}}}',
  }).catch(() => null);
  const www = bare?.headers.get('www-authenticate') ?? '';
  if (bare?.status === 401 && /resource_metadata=/i.test(www)) {
    checks.push({ id: 'auth.401', level: 'pass', title: 'Unauthenticated calls get 401 with resource_metadata' });
  } else {
    checks.push({
      id: 'auth.401',
      level: 'fail',
      title: 'Unauthenticated calls get 401 with resource_metadata',
      detail: `HTTP ${bare?.status ?? 'error'}${www ? `, WWW-Authenticate: ${www.slice(0, 120)}` : ', no WWW-Authenticate'}`,
      fix: 'Answer unauthenticated MCP requests with 401 and WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource". Never 403: to a reviewer a 403 is "unable to connect".',
    });
  }

  // Protected-resource metadata, on the MCP host itself.
  const prm = (await json(`${u.origin}/.well-known/oauth-protected-resource${u.pathname === '/' ? '' : u.pathname}`)).body ?? (await json(`${u.origin}/.well-known/oauth-protected-resource`)).body;
  const asUrl: string | undefined = prm?.authorization_servers?.[0];
  checks.push(
    asUrl
      ? { id: 'auth.prm', level: 'pass', title: 'Protected-resource metadata resolves on the MCP host', detail: `authorization server ${asUrl}` }
      : { id: 'auth.prm', level: 'fail', title: 'Protected-resource metadata resolves on the MCP host', fix: `Serve ${u.origin}/.well-known/oauth-protected-resource with "resource" and "authorization_servers". Clients resolve it against the MCP URL's own host, not your apex domain.` },
  );
  if (!asUrl) return checks;

  const asOrigin = new URL(asUrl).origin;
  const asm = (await json(`${asOrigin}/.well-known/oauth-authorization-server`)).body ?? (await json(`${asOrigin}/.well-known/openid-configuration`)).body;
  if (!asm) {
    checks.push({ id: 'auth.as-metadata', level: 'fail', title: 'Authorization-server metadata resolves', fix: `Serve ${asOrigin}/.well-known/oauth-authorization-server.` });
    return checks;
  }
  checks.push({ id: 'auth.as-metadata', level: 'pass', title: 'Authorization-server metadata resolves' });
  checks.push(
    (asm.code_challenge_methods_supported ?? []).includes('S256')
      ? { id: 'auth.pkce', level: 'pass', title: 'PKCE (S256) is supported' }
      : { id: 'auth.pkce', level: 'fail', title: 'PKCE (S256) is supported', fix: 'Advertise code_challenge_methods_supported: ["S256"].' },
  );
  checks.push(
    asm.registration_endpoint
      ? { id: 'auth.dcr', level: 'pass', title: 'Dynamic Client Registration is offered' }
      : { id: 'auth.dcr', level: 'warn', title: 'Dynamic Client Registration is offered', fix: 'Offer a registration_endpoint (RFC 7591). Anthropic says DCR works best with its directory, and ChatGPT registers itself this way.', stores: ['claude-connectors', 'chatgpt'] },
  );

  if (opts.register && asm.registration_endpoint) {
    for (const [who, uris] of Object.entries(REDIRECTS)) {
      const r = await fetch(asm.registration_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: `mcplane-preflight-${who}`, redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
      }).catch(() => null);
      checks.push(
        r && (r.status === 201 || r.status === 200)
          ? { id: `auth.dcr-${who}`, level: 'pass', title: `Registration accepts ${who} redirect URIs` }
          : {
              id: `auth.dcr-${who}`,
              level: 'fail',
              title: `Registration accepts ${who} redirect URIs`,
              detail: `HTTP ${r?.status ?? 'error'}: ${uris.join(', ')}`,
              fix: who === 'native' ? 'Accept private-use URI schemes (RFC 8252). Rejecting them locks out every native client: Cursor, Grok, desktop apps.' : 'Allow these redirect URIs in client registration.',
            },
      );
    }
  }
  return checks;
}
