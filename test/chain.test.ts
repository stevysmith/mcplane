import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { authLinks, chainChecks, walk, wallOf } from '../src/checks/chain.js';
import type { Discovery } from '../src/checks/oauth.js';
import type { Manifest } from '../src/types.js';

function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; url: string; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, hits })));
}

/** Discovery documents pointing at a local authorization endpoint. */
const disco = (authorize: string): Discovery => ({
  resource: 'https://mcp.acme.dev/mcp',
  prm: null,
  issuer: 'https://auth.acme.dev',
  oauthTried: [],
  oauth: { url: 'https://auth.acme.dev/.well-known/oauth-authorization-server', status: 200, contentType: 'application/json', json: { authorization_endpoint: authorize, scopes_supported: ['orders:read'] } },
  oidcTried: [],
  oidc: null,
});
const manifest = (signIn?: string[]): Manifest => ({ name: 'acme', title: 'Acme', server: { url: 'https://mcp.acme.dev/mcp', auth: 'oauth', ...(signIn ? { signIn } : {}) } });
const challenge = (res: ServerResponse) => res.writeHead(403, { 'cf-mitigated': 'challenge', 'content-type': 'text/html' }).end('<html>Just a moment...</html>');

test('wallOf reads bot challenges and refusals from the response', () => {
  assert.equal(wallOf(403, new Headers({ 'cf-mitigated': 'challenge' })), 'Cloudflare challenge (cf-mitigated: challenge)');
  assert.equal(wallOf(202, new Headers({ 'x-amzn-waf-action': 'challenge' })), 'AWS WAF challenge (x-amzn-waf-action)');
  assert.equal(wallOf(429, new Headers({ 'x-vercel-mitigated': 'challenge' })), 'Vercel challenge (x-vercel-mitigated: challenge)');
  assert.equal(wallOf(403, new Headers()), 'HTTP 403');
  assert.equal(wallOf(400, new Headers()), null);
  assert.equal(wallOf(200, new Headers({ 'cf-mitigated': 'none' })), null);
});

test('authLinks finds sign-in pages and identity providers, not assets or other links', () => {
  const html = `<html><head>
    <link rel="stylesheet" href="https://accounts.acme.dev/app.css">
    <script src="https://clerk.acme.dev/npm/@clerk/clerk-js@5/dist/clerk.browser.js"></script>
    <meta http-equiv="refresh" content="8; url=https://accounts.acme.dev/sign-in?redirect_url=x&amp;y=1">
    </head><body>
    <a href="/pricing">Pricing</a> <a href="/login">Log in</a>
    <form action="https://login.microsoftonline.com/common/oauth2/v2.0/authorize"></form>
    <script>window.fallback = "https://accounts.acme.dev/sign-in";</script>
    <img src="https://auth.acme.dev/logo.png">
  </body></html>`;
  assert.deepEqual(authLinks(html, 'https://api.acme.dev/oauth/consent').sort(), [
    'https://accounts.acme.dev/sign-in',
    'https://accounts.acme.dev/sign-in?redirect_url=x&y=1',
    'https://api.acme.dev/login',
    'https://clerk.acme.dev/npm/@clerk/clerk-js@5/dist/clerk.browser.js',
    'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  ]);
});

test('the chain follows the authorization endpoint to the sign-in page and the identity provider it loads', async () => {
  const idp = await serve((req, res) => challenge(res));
  const as = await serve((req, res) => {
    if (req.url!.startsWith('/authorize')) res.writeHead(302, { location: '/sign-in?return=1' }).end();
    else if (req.url!.startsWith('/sign-in')) res.writeHead(200, { 'content-type': 'text/html' }).end(`<script src="${idp.url}/clerk/v1/client.js"></script>`);
    else res.writeHead(404).end();
  });
  try {
    const [check] = await chainChecks(manifest(), disco(`${as.url}/authorize`));
    assert.equal(check.id, 'auth.chain');
    assert.equal(check.level, 'warn');
    assert.equal(check.detail, `${idp.url}/clerk/v1/client.js: Cloudflare challenge (cf-mitigated: challenge)`);
    assert.match(check.fix!, /skip rule/);
    // A realistic authorization request, for a client that isn't registered: nothing is signed in or registered.
    const authorize = new URL(as.url + as.hits[0].split(' ')[1]);
    assert.equal(authorize.searchParams.get('client_id'), 'mcplane-preflight');
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorize.searchParams.get('scope'), 'orders:read');
    assert.ok([...as.hits, ...idp.hits].every((h) => h.startsWith('GET ')));
  } finally {
    as.server.close();
    idp.server.close();
  }
});

test('the chain stops where an unregistered client is refused, and checks server.signIn from there', async () => {
  const signIn = await serve((req, res) => (req.url === '/sign-in' ? challenge(res) : res.writeHead(200, { 'content-type': 'text/html' }).end('<p>ok</p>')));
  const as = await serve((req, res) => res.writeHead(400, { 'content-type': 'text/plain' }).end('invalid_client'));
  try {
    const [stopped] = await chainChecks(manifest(), disco(`${as.url}/authorize`));
    assert.equal(stopped.level, 'info');
    assert.match(stopped.detail!, /stopped at the authorization endpoint: .*\/authorize: HTTP 400 \(invalid_client\)/);
    assert.match(stopped.fix!, /server\.signIn/);

    const [walled] = await chainChecks(manifest([`${signIn.url}/sign-in`]), disco(`${as.url}/authorize`));
    assert.equal(walled.level, 'warn');
    assert.equal(walled.detail, `${signIn.url}/sign-in: Cloudflare challenge (cf-mitigated: challenge)`);

    const [clear] = await chainChecks(manifest([`${signIn.url}/welcome`]), disco(`${as.url}/authorize`));
    assert.equal(clear.level, 'pass');
    assert.match(clear.detail!, /no bot challenge or 403 on 127\.0\.0\.1/);
  } finally {
    as.server.close();
    signIn.server.close();
  }
});

test('the chain never follows an error back to the client, and gives up on redirect loops', async () => {
  const as = await serve((req, res) => {
    if (req.url!.startsWith('/authorize')) res.writeHead(302, { location: 'https://chatgpt.com/connector_platform_oauth_redirect?error=invalid_client&state=mcplane' }).end();
    else res.writeHead(302, { location: '/loop' }).end();
  });
  try {
    const back = await walk(`${as.url}/authorize`);
    assert.equal(back.hops.length, 1);
    assert.equal(back.hops[0].status, 302);
    const loop = await walk(`${as.url}/loop`);
    assert.equal(loop.hops.length, 6, 'the first request and five redirects');
    const budget = { left: 2 };
    assert.equal((await walk(`${as.url}/loop`, budget)).hops.length, 2);
    assert.equal(budget.left, 0);
  } finally {
    as.server.close();
  }
});

test('no authorization endpoint, no chain', async () => {
  assert.deepEqual(await chainChecks(manifest(), null), []);
});
