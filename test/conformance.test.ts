import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ardFindings, ardManifest, describesServer, validateArd } from '../src/checks/ard.js';
import { wellKnown, type Discovery, type Doc } from '../src/checks/oauth.js';
import { cimdCheck, corsCheck, eraCheck, eraOf, eventsCheck, initializeCheck, issCheck, issuerCheck, legacyHeaderCheck, modernHeaderCheck } from '../src/checks/readiness.js';
import { clientCreation, vercelChecks } from '../src/checks/vercel.js';
import { caseSlug, evalSuite, frontmatter, toolId } from '../src/evals.js';
import { parseConnectDirectory } from '../src/listings.js';
import type { RpcReply } from '../src/mcp-client.js';
import { packFor } from '../src/packs.js';
import type { Check, Manifest, Tool } from '../src/types.js';

const m: Manifest = {
  name: 'acme',
  title: 'Acme',
  oneLiner: 'Look up Acme orders.',
  server: { url: 'https://mcp.acme.dev/mcp', auth: 'oauth' },
  links: { website: 'https://acme.dev', docs: 'https://acme.dev/docs' },
  prompts: ['Where is my Acme order?', 'Show my last invoice'],
  tests: {
    positive: [{ scenario: 'Track an order', prompt: 'Where is order 42?', tools: ['get_order'], expected: 'The status of order 42.' }],
    negative: [{ scenario: 'Weather (not Acme)', prompt: 'Will it rain tomorrow?' }],
  },
};
const levels = (cs: Check[]) => Object.fromEntries(cs.map((c) => [c.id, c.level]));

/* ---------------- OAuth discovery ---------------- */

const doc = (url: string, json: Record<string, any> | null, o: Partial<Doc> = {}): Doc => ({ url, status: 200, contentType: 'application/json', json, ...o });
const GOOD = {
  issuer: 'https://auth.acme.dev',
  authorization_endpoint: 'https://auth.acme.dev/authorize',
  token_endpoint: 'https://auth.acme.dev/token',
  registration_endpoint: 'https://auth.acme.dev/register',
  revocation_endpoint: 'https://auth.acme.dev/revoke',
  grant_types_supported: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'],
  code_challenge_methods_supported: ['S256'],
  scopes_supported: ['orders:read'],
};
function disco(md: Record<string, any> = {}, o: Partial<Discovery> = {}): Discovery {
  return {
    resource: 'https://mcp.acme.dev/mcp',
    prm: doc('https://mcp.acme.dev/.well-known/oauth-protected-resource/mcp', { resource: 'https://mcp.acme.dev/mcp', authorization_servers: ['https://auth.acme.dev'] }),
    issuer: 'https://auth.acme.dev',
    oauthTried: [],
    oauth: doc('https://auth.acme.dev/.well-known/oauth-authorization-server', { ...GOOD, ...md }, { forIssuer: 'https://auth.acme.dev' }),
    oidcTried: [],
    oidc: null,
    ...o,
  };
}

test('wellKnown builds the RFC 8414 path-inserted, origin and appended forms', () => {
  assert.deepEqual(wellKnown('https://auth.example.com/tenant1', 'oauth-authorization-server'), {
    inserted: 'https://auth.example.com/.well-known/oauth-authorization-server/tenant1',
    origin: 'https://auth.example.com/.well-known/oauth-authorization-server',
    appended: 'https://auth.example.com/tenant1/.well-known/oauth-authorization-server',
  });
  assert.equal(wellKnown('https://auth.example.com/', 'openid-configuration').inserted, null);
});

/* ---------------- Vercel Connect ---------------- */

test('Vercel Connect: complete metadata has nothing to fix', () => {
  const cs = vercelChecks(m, disco());
  assert.deepEqual(cs.filter((c) => c.level !== 'pass'), []);
  assert.ok(cs.every((c) => c.stores?.[0] === 'vercel-connect'));
});

test('Vercel Connect: an authless server needs an API key method', () => {
  const none = { ...m, server: { ...m.server, auth: 'none' as const } };
  assert.equal(vercelChecks(none, null)[0].level, 'warn');
  assert.equal(vercelChecks({ ...none, vercelConnect: { apiKey: { docs: 'https://acme.dev/keys' } } }, null)[0].level, 'pass');
});

test('Vercel Connect: Required gaps block, Recommended warn, Optional are notes', () => {
  const by = levels(vercelChecks(m, disco({ grant_types_supported: undefined, code_challenge_methods_supported: [], revocation_endpoint: undefined, scopes_supported: undefined })));
  assert.equal(by['vercel.grant-types'], 'fail');
  assert.equal(by['vercel.refresh'], 'warn');
  assert.equal(by['vercel.pkce'], 'warn');
  assert.equal(by['vercel.revocation'], 'info');
  assert.equal(by['vercel.scopes'], 'info');
  assert.equal(levels(vercelChecks(m, disco({ grant_types_supported: ['refresh_token'] })))['vercel.grant-types'], 'fail');
  assert.equal(levels(vercelChecks(m, disco({ authorization_endpoint: undefined })))['vercel.authorization-endpoint'], 'fail');
});

test('Vercel Connect: client creation through DCR or CIMD', () => {
  assert.deepEqual(clientCreation({ registration_endpoint: 'x' }).usable, ['client_secret_basic'], 'RFC 8414 default');
  assert.equal(clientCreation({ registration_endpoint: 'x', token_endpoint_auth_methods_supported: ['tls_client_auth'] }).dcr, false);
  assert.equal(clientCreation({ client_id_metadata_document_supported: true, token_endpoint_auth_methods_supported: ['private_key_jwt'] }).cimd, true);
  assert.equal(clientCreation({ client_id_metadata_document_supported: true, token_endpoint_auth_methods_supported: ['none'] }).cimd, false, 'public clients need S256');
  assert.equal(clientCreation({ client_id_metadata_document_supported: true, token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'] }).cimd, true);
  const by = levels(vercelChecks(m, disco({ registration_endpoint: undefined })));
  assert.equal(by['vercel.registration'], 'warn');
  assert.equal(by['vercel.auth-methods'], undefined, 'only judged when DCR is offered');
  assert.equal(levels(vercelChecks(m, disco({ token_endpoint_auth_methods_supported: undefined })))['vercel.auth-methods'], 'warn');
  assert.equal(levels(vercelChecks(m, disco({ token_endpoint_auth_methods_supported: ['tls_client_auth'] })))['vercel.auth-methods'], 'warn');
});

test('Vercel Connect: OAuth and OpenID Connect documents must agree', () => {
  const oidc = doc('https://auth.acme.dev/.well-known/openid-configuration', { issuer: 'https://auth.acme.dev', token_endpoint: 'https://auth.acme.dev/oauth/token' });
  const c = vercelChecks(m, disco({}, { oidc })).find((x) => x.id === 'vercel.oidc-agrees')!;
  assert.equal(c.level, 'fail');
  assert.match(c.detail!, /token_endpoint/);
});

test('Vercel Connect: a document served as HTML, and metadata only at the origin', () => {
  const html = doc('https://auth.acme.dev/.well-known/oauth-authorization-server', GOOD, { contentType: 'text/html' });
  const c = vercelChecks(m, disco({}, { oauth: null, oauthTried: [html] }))[0];
  assert.equal(c.level, 'fail');
  assert.match(c.detail!, /served as text\/html/);
  // A PRM that names a path issuer: every client builds the path-suffixed URL.
  const atOrigin = doc('https://auth.acme.dev/.well-known/oauth-authorization-server', { ...GOOD, issuer: 'https://auth.acme.dev' }, { forIssuer: 'https://auth.acme.dev' });
  assert.equal(vercelChecks(m, disco({}, { issuer: 'https://auth.acme.dev/tenant1', oauth: atOrigin }))[0].level, 'fail');
  // No PRM: Connect takes the MCP URL as the issuer, and the bare host still works.
  const onMcpHost = doc('https://mcp.acme.dev/.well-known/oauth-authorization-server', { ...GOOD, issuer: 'https://mcp.acme.dev' }, { forIssuer: 'https://mcp.acme.dev' });
  const noPrm = vercelChecks(m, disco({}, { prm: null, issuer: 'https://mcp.acme.dev/mcp', oauth: onMcpHost }))[0];
  assert.equal(noPrm.level, 'warn');
  assert.match(noPrm.fix!, /enter mcp\.acme\.dev/);
});

/* ---------------- MCP 2026-07-28 readiness ---------------- */

const reply = (status: number, body: any): RpcReply => ({ status, contentType: 'application/json', body, headers: new Headers() });

test('eraOf reads server/discover the way a dual-era client does', () => {
  assert.equal(eraOf(reply(200, { result: { supportedVersions: ['2026-07-28'] } })).era, 'modern');
  assert.equal(eraOf(reply(400, { error: { code: -32022, data: { supported: ['2027-01-01'] } } })).era, 'modern');
  assert.equal(eraOf(reply(200, { error: { code: -32601, message: 'Method not found' } })).era, 'legacy');
  assert.equal(eraOf(reply(400, null)).era, 'legacy');
  assert.equal(eraOf(reply(401, null)).era, 'auth');
  assert.equal(eraOf(reply(502, 'Bad gateway')).era, 'broken');
  assert.equal(eraOf(null).era, 'broken');
  assert.equal(eraCheck(eraOf(reply(200, { result: { supportedVersions: ['2026-07-28'] } }))).level, 'pass');
  assert.equal(eraCheck(eraOf(reply(200, { error: { code: -32601 } }))).level, 'info');
  assert.equal(eraCheck(eraOf(reply(500, null))).level, 'warn');
  assert.equal(eraCheck(eraOf(reply(401, null))).level, 'skip');
});

test('initialize offering 2026-07-28: negotiate down, never echo it back', () => {
  assert.equal(initializeCheck(reply(200, { result: { protocolVersion: '2025-11-25' } }), 'modern').level, 'pass');
  const echo = initializeCheck(reply(200, { result: { protocolVersion: '2026-07-28' } }), 'legacy');
  assert.equal(echo.level, 'warn');
  assert.match(echo.fix!, /copies params\.protocolVersion/);
  assert.equal(initializeCheck(reply(200, { error: { code: -32602, message: 'Unsupported protocol version' } }), 'legacy').level, 'warn');
  assert.equal(initializeCheck(reply(400, { error: { code: -32600, message: 'use 2026-07-28' } }), 'modern').level, 'pass', 'modern only, names its versions');
  assert.equal(initializeCheck(reply(400, { error: { code: -32600, message: 'Bad request' } }), 'modern').level, 'info');
  assert.equal(initializeCheck(reply(401, null), 'auth').level, 'skip');
});

test('Mcp-Method and Mcp-Name: tolerated, and allowed by CORS', () => {
  const ok = reply(200, { result: { tools: [] } });
  assert.equal(legacyHeaderCheck(ok, ok).level, 'pass');
  assert.equal(legacyHeaderCheck(ok, reply(400, 'Request header not allowed')).level, 'warn');
  assert.equal(legacyHeaderCheck(reply(500, null), ok).level, 'skip');
  assert.equal(modernHeaderCheck(ok).level, 'pass');
  assert.equal(modernHeaderCheck(reply(400, { error: { code: -32020 } })).level, 'warn');
  assert.equal(corsCheck(null, null), null, 'no CORS at all is server.cors’s business');
  assert.equal(corsCheck('*', '*')!.level, 'pass');
  assert.equal(corsCheck('*', 'Content-Type, Mcp-Method, MCP-Name')!.level, 'pass');
  assert.equal(corsCheck('*', 'content-type, mcp-protocol-version')!.level, 'info');
});

test('MCP Events is a draft: reported, never a warning', () => {
  assert.equal(eventsCheck(reply(200, { result: { events: [{ name: 'order.shipped' }] } })).level, 'pass');
  assert.equal(eventsCheck(reply(404, { error: { code: -32601 } })).level, 'info');
  assert.equal(eventsCheck(null).level, 'info');
});

test('issuer, CIMD and RFC 9207 from the discovery documents', () => {
  assert.equal(issuerCheck(disco())!.level, 'pass');
  assert.equal(issuerCheck(disco({ issuer: 'https://auth.acme.dev/' }))!.level, 'warn', 'a trailing slash is a different issuer');
  assert.equal(cimdCheck({ registration_endpoint: 'x' }).level, 'info');
  assert.equal(cimdCheck({ client_id_metadata_document_supported: true }).level, 'pass');
  assert.equal(issCheck({}).level, 'info');
  assert.equal(issCheck({ authorization_response_iss_parameter_supported: true }).level, 'pass');
});

/* ---------------- ARD ---------------- */

const entry = { identifier: 'urn:air:acme.dev:server:acme', displayName: 'Acme', type: 'application/mcp-server-card+json', url: 'https://acme.dev/.well-known/mcp/server-card.json', representativeQueries: ['a', 'b'] };

test('validateArd follows ARD v0.91 and says what only Lighthouse 13.5 rejects', () => {
  assert.deepEqual(validateArd({ specVersion: '1.0', entries: [entry] }), { errors: [], warnings: [], lighthouse: [] });
  const v = validateArd({ entries: [{ ...entry, identifier: 'acme', data: {} }], host: { displayName: 'Acme', url: 'https://acme.dev' } });
  assert.ok(v.errors.some((e) => /isn't urn:air/.test(e)));
  assert.ok(v.errors.some((e) => /exactly one of url and data/.test(e)));
  assert.deepEqual(v.lighthouse, ['no specVersion', 'host.url']);
  assert.deepEqual(validateArd({ specVersion: '1.0', entries: [{ ...entry, representativeQueries: ['a'] }] }).warnings, ['Acme: 1 representativeQueries']);
  assert.deepEqual(validateArd([]).errors, ['not a JSON object']);
});

test('ardManifest writes an entry ARD v0.91 and Lighthouse both accept', () => {
  const doc = ardManifest(m, { tools: ['get_order', 'list_invoices'], serverCard: 'https://mcp.acme.dev/.well-known/mcp/server-card.json' });
  assert.deepEqual(validateArd(doc), { errors: [], warnings: [], lighthouse: [] });
  const e = doc.entries[0] as Record<string, any>;
  assert.equal(e.identifier, 'urn:air:acme.dev:server:acme');
  assert.deepEqual(e.representativeQueries, ['Where is my Acme order?', 'Show my last invoice', 'Where is order 42?']);
  assert.deepEqual(e.capabilities, ['get_order', 'list_invoices']);
  assert.equal(ardManifest(m).entries[0].url, m.server.url, 'without a server card it points at the endpoint');
});

test('ardFindings: the predecessor path, Lighthouse’s view and this server’s entry', () => {
  const manifest = { specVersion: '1.0', entries: [entry] };
  const legacyOnly = levels(ardFindings(m.server.url, { origin: 'https://acme.dev', ard: undefined, legacy: manifest }));
  assert.equal(legacyOnly['ard.path'], 'warn');
  assert.equal(legacyOnly['ard.lighthouse'], 'pass');
  assert.equal(legacyOnly['ard.entry'], 'pass', 'a server card on the apex counts for mcp.acme.dev');
  const ardOnly = levels(ardFindings(m.server.url, { origin: 'https://acme.dev', ard: manifest, legacy: undefined }));
  assert.equal(ardOnly['ard.path'], 'pass');
  assert.equal(ardOnly['ard.lighthouse'], 'info', 'Lighthouse 13.5 reads ai-catalog.json or an Agentmap line');
  const viaAgentmap = ardFindings(m.server.url, { origin: 'https://acme.dev', ard: { entries: [entry] }, legacy: undefined, agentmap: { url: 'https://acme.dev/.well-known/ard.json', doc: { entries: [entry] } } });
  assert.equal(viaAgentmap.find((c) => c.id === 'ard.lighthouse')!.level, 'warn', 'no specVersion');
  assert.equal(describesServer({ ...entry, url: 'https://other.dev/card.json' }, m.server.url), false);
  assert.equal(describesServer({ type: 'application/a2a-agent-card+json', data: { url: m.server.url } }, m.server.url), true);
});

/* ---------------- claude plugin eval ---------------- */

const tools: Tool[] = [
  { name: 'get_order', description: 'An order by id.', outputSchema: { type: 'object' } },
  { name: 'cancel_order', description: 'Cancels an order.' },
];

test('eval suite: graders, mocks and frontmatter in the documented format', () => {
  const p = { plugin: 'acme', server: 'acme.mcp' };
  assert.equal(toolId(p, 'get_order'), 'mcp__plugin_acme_acme_mcp__get_order');
  const { files, problems } = evalSuite(m, p, tools);
  assert.deepEqual(problems, []);
  const at = (path: string) => files.find((f) => f.path === path)?.content;
  assert.match(at('evals/positive-1-track-an-order/prompt.md')!, /^---\ndescription: "Track an order"\ntags: \["mcplane", "positive"\]/);
  assert.match(at('evals/positive-1-track-an-order/graders/calls-get_order.md')!, /type: "tool_used"\ntool: "mcp__plugin_acme_acme_mcp__get_order"\narm: "with-only"/);
  assert.match(at('evals/positive-1-track-an-order/graders/answer.md')!, /type: "llm"[\s\S]*PASS if .*The status of order 42\./);
  assert.match(at('evals/positive-1-track-an-order/mocks/acme.mcp/get_order.md')!, /type: "agent"[\s\S]*Where is order 42\?/);
  for (const t of ['get_order', 'cancel_order']) assert.match(at(`evals/negative-1-weather-not-acme/graders/no-${t}.md`)!, /min: 0\nmax: 0\narm: "both"/);
  assert.deepEqual(JSON.parse(at('evals/mocks/acme.mcp/_tools.json')!).tools, tools);
});

test('eval suite: unknown tools and nothing to assert are problems', () => {
  assert.match(evalSuite(m, { plugin: 'a', server: 'b' }, [{ name: 'other' }]).problems[0], /doesn't have: get_order/);
  const negOnly = { ...m, tests: { negative: m.tests!.negative } };
  const r = evalSuite(negOnly, { plugin: 'a', server: 'b' }, []);
  assert.equal(r.files.length, 0);
  assert.match(r.problems[0], /No tool names/);
});

test('frontmatter quotes anything YAML could misread, and slugs cut at a word', () => {
  assert.equal(frontmatter({ description: 'Order: "42"', max_turns: 6 }, 'Hi'), '---\ndescription: "Order: \\"42\\""\nmax_turns: 6\n---\n\nHi\n');
  assert.equal(caseSlug('Code review turnaround (a different meaning of review)'), 'code-review-turnaround-a-different-meaning-of');
  assert.equal(caseSlug("Check one store's current review time"), 'check-one-stores-current-review-time');
});

/* ---------------- Vercel Connect directory and pack ---------------- */

const DIRECTORY = `# Browse Connectors

Connect your apps and agents to the tools and data they need.

**Linear**Create and update issues in your workspace.

Managed

OAuth

MCP

API Key

[Learn more](/connect/linear)

**Linq**

Beta

iMessage, RCS, and SMS over a Linq shared line

Managed

[Learn more](/connect/linq)

**ZenRows**Experimental. This connector provider has not been verified by Vercel.Extract web content through the ZenRows API.

MCP

[Learn more](/connect/zenrows)
`;

test('parseConnectDirectory reads names, labels and the Experimental flag', () => {
  const rows = parseConnectDirectory(DIRECTORY);
  assert.deepEqual(rows.map((r) => r.slug), ['linear', 'linq', 'zenrows']);
  assert.deepEqual(rows[0].labels, ['Managed', 'OAuth', 'MCP', 'API Key']);
  assert.equal(rows[1].description, 'iMessage, RCS, and SMS over a Linq shared line');
  assert.deepEqual(rows[1].labels, ['Beta', 'Managed']);
  assert.equal(rows[2].experimental, true);
  assert.equal(rows[2].description, 'Extract web content through the ZenRows API.');
});

test('pack vercel-connect: the API key method, and no method at all', async () => {
  const keyed: Manifest = { ...m, server: { ...m.server, auth: 'none' }, listing: { 'vercel-connect': { title: 'Acme API' } }, vercelConnect: { apiKey: { docs: 'https://acme.dev/keys', header: 'x-api-key: <key>' }, apiBase: 'https://api.acme.dev/v1' } };
  const pack = await packFor(keyed, 'vercel-connect');
  const text = pack.files[0].content as string;
  assert.deepEqual(pack.problems, []);
  assert.match(text, /^# Vercel Connect submission: Acme API/, 'per-store listing text');
  assert.match(text, /### API key\n- Where users create a key: https:\/\/acme\.dev\/keys\n- Sent as: x-api-key: <key>/);
  assert.match(text, /REST API: https:\/\/api\.acme\.dev\/v1/);
  assert.match(text, /API key: Configuration Valid/);
  const bare = await packFor({ ...keyed, vercelConnect: undefined }, 'vercel-connect');
  assert.match(bare.problems[0], /connection method/);
});
