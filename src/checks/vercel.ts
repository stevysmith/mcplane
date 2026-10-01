/**
 * Vercel Connect, the connector catalog for apps and agents, takes service submissions since
 * 29 Sep 2026. These checks follow its "For Service Providers" page, from your discovery documents
 * alone (nothing is registered). Its tiers set the level: Required blocks, Recommended warns,
 * Optional is a note. What needs a real token (expires_in, refresh rotation, the redirect URL) is
 * left to the reminders.
 *
 * https://vercel.com/docs/connect/providers
 * https://vercel.com/changelog/vercel-connect-service-submissions
 */
import type { Check, Manifest, StoreId } from '../types.js';
import { isJsonType, metadata, wellKnown, type Discovery } from './oauth.js';

const S: StoreId[] = ['vercel-connect'];

export const CONNECT_CALLBACK = 'https://connect.vercel.com/callback';
/** The client authentication methods Vercel Connect registers clients with. */
export const CONNECT_AUTH_METHODS = ['client_secret_basic', 'client_secret_post', 'none', 'private_key_jwt'];
/** Each grant, and the token subject type Connect offers for it. */
export const SUBJECTS: Record<string, string> = {
  authorization_code: 'user',
  client_credentials: 'app',
  'urn:ietf:params:oauth:grant-type:jwt-bearer': 'jwt-bearer',
};

const check = (id: string, level: Check['level'], title: string, more: Partial<Check> = {}): Check => ({ id: `vercel.${id}`, level, title, ...more, stores: S });

/** What Connect can do about client creation, from the metadata: DCR, CIMD, both or neither. */
export function clientCreation(md: Record<string, any>): { dcr: boolean; cimd: boolean; methods: string[] | undefined; usable: string[] } {
  const methods: string[] | undefined = Array.isArray(md.token_endpoint_auth_methods_supported) ? md.token_endpoint_auth_methods_supported : undefined;
  // RFC 8414 §2: when the list is left out, the default is client_secret_basic.
  const usable = (methods ?? ['client_secret_basic']).filter((x) => CONNECT_AUTH_METHODS.includes(x));
  const s256 = (md.code_challenge_methods_supported ?? []).includes('S256');
  return {
    dcr: typeof md.registration_endpoint === 'string' && usable.length > 0,
    cimd: md.client_id_metadata_document_supported === true && (!!methods?.includes('private_key_jwt') || (!!methods?.includes('none') && s256)),
    methods,
    usable,
  };
}

export function vercelChecks(m: Manifest, d: Discovery | null): Check[] {
  if ((m.server.auth ?? 'none') !== 'oauth') {
    return [
      m.vercelConnect?.apiKey
        ? check('method', 'pass', 'Vercel Connect has a connection method', { detail: 'API key: Vercel validates its configuration only, with no token test' })
        : check('method', 'warn', 'Vercel Connect has a connection method', {
            detail: 'server.auth is "none" and mcplane.json has no vercelConnect.apiKey',
            fix: 'Vercel Connect brokers OAuth tokens and API keys, and a submission needs at least one connection method. An authless server has nothing to connect; if users need a key, describe it under vercelConnect.apiKey.',
          }),
    ];
  }
  if (!d) return [];
  const md = metadata(d);
  const found = [d.oauth, d.oidc].filter((x) => x !== null);
  const tried = [...d.oauthTried, ...d.oidcTried];
  const out: Check[] = [];

  // Required: discovery documents, served as JSON, at the path-suffixed form when the issuer has a path.
  if (!md) {
    const notJson = tried.find((t) => t.status === 200 && t.json && !isJsonType(t.contentType));
    out.push(
      check('metadata', 'fail', 'Authorization-server metadata is published as JSON', {
        detail: notJson ? `${notJson.url} is served as ${notJson.contentType || 'no content type'}` : tried.map((t) => `${t.url} (${t.status || 'no answer'})`).join(', '),
        fix: notJson
          ? 'Serve it as application/json. Vercel Connect skips a document that exists but isn’t served as JSON.'
          : `Publish RFC 8414 metadata (or OpenID Connect discovery) for ${d.issuer}. Vercel Connect reads your endpoints and capabilities from it; without it your users enter every endpoint by hand.`,
      }),
    );
    return out;
  }
  const oauthForms = wellKnown(d.issuer, 'oauth-authorization-server');
  const oidcForms = wellKnown(d.issuer, 'openid-configuration');
  const originOnly = !!oauthForms.inserted && found.every((x) => x.url === oauthForms.origin || x.url === oidcForms.origin);
  const title = 'Authorization-server metadata is published as JSON';
  const pathFix = `For a URL with a path, Vercel Connect looks for the path-suffixed form and can't find metadata that is only at the origin. Serve it at ${oauthForms.inserted} too (RFC 8414 §3.1)`;
  out.push(
    !originOnly
      ? check('metadata', 'pass', title, { detail: found.map((x) => x.url).join(', ') })
      : d.prm
        ? // Your PRM names an issuer with a path, so every client builds the path-suffixed URL.
          check('metadata', 'fail', title, { detail: `only at ${found.map((x) => x.url).join(', ')}, but the issuer ${d.issuer} has a path`, fix: `${pathFix}.` })
        : // No PRM: Connect treats the MCP URL as the issuer. Entering the bare host still works.
          check('metadata', 'warn', title, {
            detail: `only at ${found.map((x) => x.url).join(', ')}, and with no protected-resource metadata Connect takes ${d.issuer} as the issuer`,
            fix: `${pathFix}, or publish protected-resource metadata (RFC 9728) naming your issuer. Until then your users must enter ${new URL(d.issuer).host} rather than the MCP URL.`,
          }),
  );

  // Required: with both documents, Connect fills gaps in the OAuth one from OpenID Connect, so they must agree.
  if (d.oauth && d.oidc) {
    const differ = (['issuer', 'token_endpoint'] as const).filter((k) => d.oauth!.json![k] !== d.oidc!.json![k]);
    out.push(
      differ.length
        ? check('oidc-agrees', 'fail', 'OAuth and OpenID Connect metadata agree', {
            detail: differ.map((k) => `${k}: "${d.oauth!.json![k] ?? ''}" vs "${d.oidc!.json![k] ?? ''}"`).join('; '),
            fix: 'Vercel Connect fills gaps in your OAuth metadata from your OpenID Connect document, and both must declare the same issuer and token_endpoint.',
          })
        : check('oidc-agrees', 'pass', 'OAuth and OpenID Connect metadata agree'),
    );
  }

  out.push(
    typeof md.token_endpoint === 'string'
      ? check('token-endpoint', 'pass', 'token_endpoint is declared')
      : check('token-endpoint', 'fail', 'token_endpoint is declared', { fix: 'Every Vercel Connect flow uses token_endpoint. Declare it in your metadata.' }),
  );

  // Required: grant types decide which token subject types a connector offers.
  const grants: string[] = Array.isArray(md.grant_types_supported) ? md.grant_types_supported : [];
  const subjects = grants.filter((g) => SUBJECTS[g]).map((g) => `${SUBJECTS[g]} (${g.replace('urn:ietf:params:oauth:grant-type:', '')})`);
  out.push(
    !grants.length
      ? check('grant-types', 'fail', 'grant_types_supported says what a connector can do', {
          detail: 'grant_types_supported is missing',
          fix: 'Declare it, e.g. ["authorization_code", "refresh_token"], plus client_credentials if you issue app tokens. Vercel Connect reads it to decide which token types a connector offers, and a grant you leave out never shows up.',
        })
      : !subjects.length
        ? check('grant-types', 'fail', 'grant_types_supported says what a connector can do', {
            detail: `declares ${grants.join(', ')}`,
            fix: 'Include authorization_code (user tokens) or client_credentials (app tokens). None of the declared grants gives Vercel Connect a token to hand out.',
          })
        : check('grant-types', 'pass', 'grant_types_supported says what a connector can do', { detail: `subject types: ${subjects.join(', ')}` }),
  );
  if (grants.includes('authorization_code') && typeof md.authorization_endpoint !== 'string') {
    out.push(check('authorization-endpoint', 'fail', 'authorization_endpoint is declared for user tokens', { fix: 'User tokens need authorization_endpoint alongside token_endpoint.' }));
  }

  // Recommended: Connect creates the OAuth client itself, through DCR or CIMD.
  const cc = clientCreation(md);
  out.push(
    cc.dcr || cc.cimd
      ? check('registration', 'pass', 'Vercel Connect can create the OAuth client', { detail: [cc.dcr && 'Dynamic Client Registration', cc.cimd && 'Client ID Metadata Documents'].filter(Boolean).join(' and ') })
      : check('registration', 'warn', 'Vercel Connect can create the OAuth client', {
          detail: [
            !md.registration_endpoint ? 'no registration_endpoint' : 'registration_endpoint, but no client authentication method Connect uses',
            md.client_id_metadata_document_supported !== true ? 'client_id_metadata_document_supported not declared' : 'CIMD declared, but neither private_key_jwt nor public clients (none) with S256',
          ].join('; '),
          fix: `Declare a registration_endpoint (RFC 7591), or client_id_metadata_document_supported: true with private_key_jwt or public clients and S256. Otherwise each user registers an application with you, allows ${CONNECT_CALLBACK} and pastes in its client ID and secret.`,
        }),
  );
  if (typeof md.registration_endpoint === 'string') {
    out.push(
      !cc.methods
        ? check('auth-methods', 'warn', 'token_endpoint_auth_methods_supported names a method Connect can use', {
            detail: 'not declared (RFC 8414 defaults it to client_secret_basic)',
            fix: `Declare the methods you accept. Vercel Connect registers clients with ${CONNECT_AUTH_METHODS.join(', ')}, and skips DCR when the list names none of them.`,
          })
        : cc.usable.length
          ? check('auth-methods', 'pass', 'token_endpoint_auth_methods_supported names a method Connect can use', { detail: cc.usable.join(', ') })
          : check('auth-methods', 'warn', 'token_endpoint_auth_methods_supported names a method Connect can use', {
              detail: cc.methods.join(', '),
              fix: `Add one of ${CONNECT_AUTH_METHODS.join(', ')}. Without one, Vercel Connect won't register a client and your users paste in a client ID and secret even though you support DCR.`,
            }),
    );
  }
  out.push(
    (md.code_challenge_methods_supported ?? []).includes('S256')
      ? check('pkce', 'pass', 'PKCE with S256 is declared')
      : check('pkce', 'warn', 'PKCE with S256 is declared', { fix: 'Declare code_challenge_methods_supported: ["S256"]. Vercel Connect then uses PKCE (RFC 9700), and it is one of the two routes to CIMD for public clients.' }),
  );
  out.push(
    grants.includes('refresh_token')
      ? check('refresh', 'pass', 'Refresh tokens are declared')
      : check('refresh', 'warn', 'Refresh tokens are declared', { fix: 'Declare refresh_token in grant_types_supported and issue refresh tokens with the authorization code flow. Without them every expiry sends your user back through the consent prompt.' }),
  );

  // Optional: notes, never warnings.
  const prmServers = d.prm?.json?.authorization_servers;
  out.push(
    Array.isArray(prmServers) && prmServers.length
      ? check('prm', 'pass', 'Protected-resource metadata names the authorization server', { detail: d.prm!.url })
      : check('prm', 'info', 'Protected-resource metadata names the authorization server', {
          fix: 'Publish RFC 9728 metadata with a non-empty authorization_servers array, so users can give Vercel Connect the MCP URL they already know instead of looking up your authorization server.',
        }),
  );
  out.push(
    typeof md.revocation_endpoint === 'string'
      ? check('revocation', 'pass', 'revocation_endpoint is declared')
      : check('revocation', 'info', 'revocation_endpoint is declared', {
          fix: 'Declare one (RFC 7009). Vercel Connect then offers revocation and calls it; without it, revoking only removes Vercel’s copy and your side treats the token as live until it expires.',
        }),
  );
  const scopes: string[] = Array.isArray(md.scopes_supported) ? md.scopes_supported : [];
  out.push(
    !scopes.length
      ? check('scopes', 'info', 'scopes_supported lists your scopes', { fix: 'List every scope a client can request. Vercel Connect offers this set when users configure your OAuth client.' })
      : d.oidc && !scopes.includes('openid')
        ? check('scopes', 'info', 'scopes_supported lists your scopes', { detail: scopes.join(' '), fix: 'You serve OpenID Connect, so include openid, plus profile and email where you support them. Vercel Connect shows those apart from your API scopes.' })
        : check('scopes', 'pass', 'scopes_supported lists your scopes', { detail: scopes.join(' ') }),
  );
  return out;
}

/** What only a token or the form can show. */
export const VERCEL_REMINDERS = [
  `Vercel Connect: allow the redirect URL ${CONNECT_CALLBACK} (exact match), return expires_in in token responses, and if you rotate refresh tokens return the new one in every refresh response. None of these can be checked without a token.`,
  'Vercel Connect: test each OAuth method in Submit a Service (Set Up Test Connector, then Test User Token, with the default scopes selected) and keep that connector and its token in your team until review ends. Vercel re-checks it when you submit, and any change to the method or your discovery documents needs a new test.',
];
