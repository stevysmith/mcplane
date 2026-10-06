import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { toolChecks } from '../src/checks/tools.js';
import { diffTools, drift } from '../src/drift.js';
import { tryLinks } from '../src/extras.js';
import { loadManifest } from '../src/manifest.js';
import { _test as packs } from '../src/packs.js';
import { _test as pub, registryName, serverJson } from '../src/publish.js';
import type { Manifest, Tool } from '../src/types.js';

const m: Manifest = {
  name: 'acme',
  title: 'Acme',
  oneLiner: 'Look up Acme orders, invoices and shipping status from any assistant that speaks MCP, without leaving the chat window',
  server: { url: 'https://mcp.acme.dev/mcp', auth: 'none' },
  repository: 'https://github.com/acme/acme-mcp',
  links: { website: 'https://acme.dev' },
};

const hints = (readOnly: boolean, openWorld: boolean, destructive = false) => ({ readOnlyHint: readOnly, openWorldHint: openWorld, destructiveHint: destructive });

test('toolChecks flags a write authorised by a token in the chat', () => {
  const tools: Tool[] = [{ name: 'update_page', title: 'Update', description: 'Update a page.', inputSchema: { properties: { edit_token: {}, html: {} } }, annotations: hints(false, false) }];
  assert.equal(toolChecks(tools).find((c) => c.id === 'tools.bearer-writes')?.level, 'fail');
});

test('toolChecks warns when a tool that sends email says openWorldHint false', () => {
  const tools: Tool[] = [{ name: 'report', title: 'Report', description: 'Records a report and emails the user a link.', annotations: hints(false, false), outputSchema: {} }];
  assert.equal(toolChecks(tools).find((c) => c.id === 'tools.open-world')?.level, 'warn');
  tools[0].annotations!.openWorldHint = true;
  assert.equal(toolChecks(tools).find((c) => c.id === 'tools.open-world')?.level, 'pass');
});

test('toolChecks catches missing hints, upsells and instructions', () => {
  const tools: Tool[] = [{ name: 'search', description: 'You must always call this first. Upgrade to Pro for more results.', annotations: { readOnlyHint: true } }];
  const by = Object.fromEntries(toolChecks(tools).map((c) => [c.id, c.level]));
  assert.equal(by['tools.title'], 'warn');
  assert.equal(by['tools.hints'], 'fail');
  assert.equal(by['tools.no-upsell'], 'fail');
  assert.equal(by['tools.no-instructions'], 'warn');
});

test('diffTools reports added, removed and changed hints', () => {
  const shape = (name: string, openWorld: boolean) => ({ name, hints: { readOnly: false, destructive: false, openWorld }, input: '', output: '' });
  const d = diffTools([shape('report', false), shape('update', false)], [shape('report', true), shape('status', false)]);
  assert.deepEqual(d.added, ['status']);
  assert.deepEqual(d.removed, ['update']);
  assert.deepEqual(d.changed, [{ tool: 'report', fields: ['openWorldHint false → true'] }]);
});

test('toolChecks warns when a write that overwrites, revokes or deletes says destructiveHint false', () => {
  const tools: Tool[] = [
    { name: 'set_password', title: 'Set passcode', description: 'Set or clear a viewer passcode on a page.', annotations: hints(false, false), outputSchema: {} },
    { name: 'setExpiry', title: 'Set expiry', description: 'Choose when a page stops loading.', annotations: hints(false, false), outputSchema: {} },
    { name: 'update_page', title: 'Update page', description: 'Overwrites the page with new HTML.', annotations: hints(false, false), outputSchema: {} },
  ];
  const c = toolChecks(tools).find((x) => x.id === 'tools.destructive-overwrite');
  assert.equal(c?.level, 'warn');
  assert.match(c!.detail!, /set_password \(password\)/);
  assert.match(c!.detail!, /setExpiry \(expiry\)/);
  assert.match(c!.detail!, /update_page \(overwrites\)/);
});

test('the destructive warning skips additive writes, negations, read-only and already-destructive tools', () => {
  const tools: Tool[] = [
    { name: 'add_report', title: 'Add report', description: 'Adds a new report. It never overwrites or deletes existing reports.', annotations: hints(false, false), outputSchema: {} },
    { name: 'init', title: 'Init', description: 'Writes a starting config file. Refuses to overwrite an existing file.', annotations: hints(false, false), outputSchema: {} },
    { name: 'list_gateways', title: 'List gateways', description: 'Lists payment gateways, including archived ones.', annotations: hints(true, false), outputSchema: {} },
    { name: 'delete_page', title: 'Delete page', description: 'Deletes a page.', annotations: hints(false, false, true), outputSchema: {} },
    { name: 'create_gateway', title: 'Create gateway', description: 'Creates a webhook gateway.', annotations: hints(false, false), outputSchema: {} },
  ];
  assert.equal(toolChecks(tools).find((x) => x.id === 'tools.destructive-overwrite'), undefined);
});

test('toolChecks warns when a non-destructive tool offers a destructive option in its schema', () => {
  const tools: Tool[] = [
    {
      name: 'publish_html',
      title: 'Publish HTML',
      description: 'Turns HTML into a private link.',
      inputSchema: {
        properties: {
          content: { type: 'string', description: 'Full HTML to publish.' },
          burn_after_read: { type: 'boolean', description: 'Auto-delete after first view.' },
          expires_in_hours: { type: 'number', description: 'Lifetime in hours.' },
          password: { type: 'string', description: 'Optional viewer passcode.' },
        },
      },
      annotations: hints(false, true),
      outputSchema: {},
    },
    { name: 'save_file', title: 'Save file', description: 'Saves a file.', inputSchema: { properties: { options: { type: 'object', properties: { mode: { type: 'string', enum: ['append', 'overwrite'] } } } } }, annotations: hints(false, false), outputSchema: {} },
    { name: 'update_page', title: 'Update page', description: 'Changes a page’s settings.', inputSchema: { properties: { expires_at: { type: 'string' } } }, annotations: hints(false, false), outputSchema: {} },
  ];
  const c = toolChecks(tools).find((x) => x.id === 'tools.destructive-option');
  assert.equal(c?.level, 'warn');
  assert.deepEqual(c?.stores, ['chatgpt']);
  assert.match(c!.detail!, /publish_html\.burn_after_read \(burn after read, delete\)/);
  assert.match(c!.detail!, /save_file\.options\.mode \(overwrite\)/, 'one level of nesting, enum values included');
  assert.match(c!.detail!, /update_page\.expires_at \(expires\)/, 'an expiry on a tool that changes something that exists');
  assert.doesNotMatch(c!.detail!, /expires_in_hours|password/, 'a lifetime on a tool that creates, and a passcode, are not flagged');
});

test('the destructive option warning skips additive options, negations, states and hinted tools', () => {
  const tools: Tool[] = [
    { name: 'create_share_link', title: 'Create share link', description: 'Mints a link to a page.', inputSchema: { properties: { expires_in: { type: 'number', description: 'Link lifetime in hours; the link expires after it.' } } }, annotations: hints(false, true), outputSchema: {} },
    { name: 'api_create_key', title: 'Create API key', description: 'Creates an API key.', inputSchema: { properties: { expiry: { type: 'string', description: 'Default 90 days.' } } }, annotations: hints(false, false), outputSchema: {} },
    { name: 'search_prices', title: 'Compare prices', description: 'Compares prices.', inputSchema: { properties: { includeStale: { type: 'boolean', description: 'Saved prices stay until a refresh replaces them.' } } }, annotations: hints(false, true), outputSchema: {} },
    { name: 'upload_file', title: 'Upload file', description: 'Uploads a file.', inputSchema: { properties: { name: { type: 'string', description: 'File name. Never overwrites an existing file.' } } }, annotations: hints(false, false), outputSchema: {} },
    { name: 'tag_items', title: 'Tag items', description: 'Adds a tag.', inputSchema: { properties: { include_deleted: { type: 'boolean', description: 'Also tag items in the deleted folder.' } } }, annotations: hints(false, false), outputSchema: {} },
    { name: 'clear_cache', title: 'Clear cache', description: 'Clears the cache.', inputSchema: { properties: { purge: { type: 'boolean' } } }, annotations: hints(false, false, true), outputSchema: {} },
    { name: 'list_pages', title: 'List pages', description: 'Lists pages.', inputSchema: { properties: { delete_after: { type: 'number' } } }, annotations: hints(true, false), outputSchema: {} },
  ];
  assert.equal(toolChecks(tools).find((x) => x.id === 'tools.destructive-option'), undefined);
});

test('toolChecks warns about tools that move money or handle crypto', () => {
  const tools: Tool[] = [
    { name: 'link_wallet', title: 'Link wallet', description: 'Links an account. Sign the message with personal_sign (EIP-191).', inputSchema: { properties: { code: { type: 'string' }, wallet: { type: 'string' }, signature: { type: 'string' } } }, annotations: hints(false, false), outputSchema: {} },
    { name: 'pay_vendor', title: 'Pay vendor', description: 'Sends a payment to a vendor.', annotations: hints(false, true, true), outputSchema: {} },
    { name: 'get_usdc_balance', title: 'Balance', description: 'The balance of an address.', annotations: hints(true, true), outputSchema: {} },
    { name: 'start_order', title: 'Start order', description: 'Opens a checkout for the cart.', annotations: hints(false, true), outputSchema: {} },
  ];
  const c = toolChecks(tools).find((x) => x.id === 'tools.money-crypto');
  assert.equal(c?.level, 'warn');
  assert.deepEqual(c?.stores, ['chatgpt']);
  assert.match(c!.detail!, /link_wallet \(wallet, personal_sign, eip-191\)/);
  assert.match(c!.detail!, /pay_vendor \(sends a payment\)/);
  assert.match(c!.detail!, /get_usdc_balance \(usdc\)/, 'crypto in a read-only tool’s name counts');
  assert.match(c!.detail!, /start_order \(checkout\)/);
});

test('prices, billing links, check-out dates and passing mentions are not money movement', () => {
  const tools: Tool[] = [
    { name: 'search_hotels', title: 'Search hotels', description: 'Finds hotels with live pricing, the purchase price and how to buy a room.', annotations: hints(true, true), outputSchema: {} },
    { name: 'book_room', title: 'Book room', description: 'Holds a room and returns a link to the billing page. No crypto wallet needed.', inputSchema: { properties: { check_out: { type: 'string' }, checkout_date: { type: 'string' } } }, annotations: hints(false, true), outputSchema: {} },
    { name: 'export_orders', title: 'Export orders', description: 'Exports your purchase history and pricing plan to a CSV.', annotations: hints(false, false), outputSchema: {} },
    { name: 'get_indicator', title: 'Get an indicator', description: 'Inflation, GDP, crypto market cap and more, for any country.', annotations: hints(true, true), outputSchema: {} },
  ];
  assert.equal(toolChecks(tools).find((x) => x.id === 'tools.money-crypto'), undefined, 'a passing mention in a read-only tool’s description does not count');
});

test('drift: a ChatGPT submission in review keeps its tools, so changes need cancel, reconnect and resubmit', async () => {
  // A live server whose report tool changed its openWorldHint and gained a sibling since the snapshot.
  const live: Tool[] = [{ name: 'report', annotations: hints(false, true) }, { name: 'status', annotations: hints(true, false) }];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const rpc = JSON.parse(body);
      if (rpc.id === undefined) return res.writeHead(202).end();
      const result = rpc.method === 'tools/list' ? { tools: live } : { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'acme', version: '1.0.0' } };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
    const mm: Manifest = { ...m, repository: undefined, server: { url, auth: 'none' } };
    const dir = await mkdtemp(join(tmpdir(), 'mcplane-drift-'));
    await mkdir(join(dir, '.mcplane', 'snapshots'), { recursive: true });
    const snapshot = (state: string) =>
      writeFile(
        join(dir, '.mcplane', 'snapshots', 'chatgpt.json'),
        JSON.stringify({ store: 'chatgpt', takenOn: '2026-10-05', state, tools: [{ name: 'report', hints: { readOnly: false, destructive: false, openWorld: false }, input: '', output: '' }], listing: { title: mm.title, oneLiner: mm.oneLiner, website: mm.links?.website } }),
      );

    await snapshot('submitted');
    const inReview = (await drift(mm, ['chatgpt'], {}, dir)).items;
    assert.equal(inReview.length, 1, 'one item: the hint change is part of the tool change');
    assert.equal(inReview[0].level, 'info');
    assert.match(inReview[0].todo, /keeps the tools it was submitted with.*cancel the review \(back to Draft\), reconnect so ChatGPT rediscovers the tools, then resubmit/);

    await snapshot('live');
    const published = (await drift(mm, ['chatgpt'], {}, dir)).items;
    assert.match(published[0].todo, /No resubmission needed for tools/);
    assert.ok(published.some((i) => i.what.startsWith('Hints changed: report')));
  } finally {
    server.close();
  }
});

test('justifications become optional appeal notes for tools the server still has', () => {
  const tools: Tool[] = [{ name: 'publish', annotations: hints(false, true, true) }];
  const notes = packs.appealNotes({ ...m, justifications: { publish: { openWorld: 'Posts to a public page.' }, gone: { readOnly: 'Old tool.' } } }, tools);
  assert.equal(notes, '### publish\n- openWorldHint true: Posts to a public page.');
  assert.equal(packs.appealNotes(m, tools), '');
});

test('registry name and description', () => {
  assert.equal(registryName(m), 'io.github.acme/acme');
  assert.equal(registryName({ ...m, repository: undefined }), 'dev.acme/acme');
  const d = serverJson(m).description;
  assert.ok(d.length <= 100);
  assert.ok(m.oneLiner!.startsWith(d) && !/\s$/.test(d), 'cut at a word boundary');
});

test('editMarketplace adds, bumps and leaves the rest of the file alone', () => {
  const file = `{\n  "name": "xai",\n  "plugins": [\n    {\n      "name": "other",\n      "source": { "source": "url", "url": "https://github.com/o/o.git", "sha": "aaa" }\n    }\n  ]\n}\n`;
  const entry = pub.grokEntry(m, 'b'.repeat(40));
  const added = pub.editMarketplace(file, entry);
  assert.equal(added.mode, 'add');
  const parsed = JSON.parse(added.text);
  assert.equal(parsed.plugins.length, 2);
  assert.equal(parsed.plugins[0].source.sha, 'aaa');
  assert.ok(added.text.startsWith(file.slice(0, file.lastIndexOf('}\n  ]') + 1)));
  assert.equal(pub.editMarketplace(added.text, entry).mode, 'same');
  const bumped = pub.editMarketplace(added.text, { ...entry, source: { ...entry.source, sha: 'c'.repeat(40) } });
  assert.equal(bumped.mode, 'bump');
  assert.equal(JSON.parse(bumped.text).plugins[1].source.sha, 'c'.repeat(40));
});

test('tryLinks builds a Cursor deeplink that decodes to the server URL', () => {
  const cursor = tryLinks(m).find((l) => l.client === 'Cursor')!.how;
  const config = new URL(cursor).searchParams.get('config')!;
  assert.deepEqual(JSON.parse(Buffer.from(config, 'base64').toString()), { url: m.server.url });
});

test('loadManifest explains what is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcplane-'));
  await assert.rejects(loadManifest(dir), /mcplane init/);
  await writeFile(join(dir, 'mcplane.json'), JSON.stringify({ name: 'x', stores: ['chatgpt', 'appstore'] }));
  await assert.rejects(loadManifest(dir), /"title" is required.*"server.url" is required.*unknown store "appstore"/);
});

test('toolChecks follows OpenAI’s current hint definitions', () => {
  const tools: Tool[] = [
    { name: 'notify', title: 'Notify', description: 'Sends a message to a Slack channel.', annotations: hints(false, true, false), outputSchema: {} },
    { name: 'search', title: 'Search', description: 'Web search across the public internet.', annotations: hints(true, false), outputSchema: {} },
  ];
  const by = Object.fromEntries(toolChecks(tools).map((c) => [c.id, c]));
  assert.match(by['tools.destructive-send'].detail!, /notify/);
  assert.match(by['tools.open-world'].detail!, /search/);
});

test('toolChecks flags catch-all request tools and long names', () => {
  const tools: Tool[] = [{ name: 'x'.repeat(65), title: 'Req', description: 'Calls the API.', inputSchema: { properties: { method: {}, path: {} } }, annotations: hints(false, false), outputSchema: {} }];
  const by = Object.fromEntries(toolChecks(tools).map((c) => [c.id, c.level]));
  assert.equal(by['tools.catch-all'], 'warn');
  assert.equal(by['tools.name-length'], 'fail');
});

test('registry prereleases for listing-only changes', () => {
  assert.equal(pub.nextPrerelease('1.2.0'), '1.2.0-1');
  assert.equal(pub.nextPrerelease('1.2.0-1'), '1.2.0-2');
});

test('awesome-remote entry follows the list’s three-line format', async () => {
  const { publish } = await import('../src/publish.js');
  const r = await publish({ ...m, server: { ...m.server, auth: 'oauth' } }, 'awesome-remote-mcp-servers');
  assert.ok(r.lines.includes(`- [Acme](https://acme.dev) \`${m.server.url}\``));
  assert.ok(r.lines.some((l) => l.includes('glama.ai/mcp/connectors/io.github.acme/acme/badges/score.svg')));
  assert.ok(r.lines.some((l) => l.startsWith('  🔐 - ')));
});

test('product prices and sibling tool names are not flagged', () => {
  const tools: Tool[] = [
    { name: 'search_hotels', title: 'Search hotels', description: 'Finds hotels with live pricing and premium rooms. Pass the id to get_hotel for details.', annotations: hints(true, true), outputSchema: {} },
    { name: 'get_hotel', title: 'Get hotel', description: 'One hotel by id.', annotations: hints(true, true), outputSchema: {} },
  ];
  const by = Object.fromEntries(toolChecks(tools).map((c) => [c.id, c.level]));
  assert.equal(by['tools.no-upsell'], 'pass');
  assert.equal(by['tools.no-instructions'], 'pass');
});

test('per-store listing text overrides the shared fields for that store only', async () => {
  const { forStore } = await import('../src/draft.js');
  const withClaude: Manifest = { ...m, description: 'Shared.', listing: { 'claude-connectors': { description: 'Ask Claude.' } } };
  assert.equal(forStore(withClaude, 'claude-connectors').description, 'Ask Claude.');
  assert.equal(forStore(withClaude, 'chatgpt').description, 'Shared.');
  assert.equal(forStore(withClaude, 'claude-connectors').oneLiner, m.oneLiner);
});

test('zip writes entries a standard reader can inflate', async () => {
  const { zip } = await import('../src/zip.js');
  const { inflateRawSync } = await import('node:zlib');
  const out = zip([{ path: 'plugin.json', data: '{"name":"acme"}' }, { path: 'assets/a.bin', data: new Uint8Array([1, 2, 3]) }]);
  const v = new DataView(out.buffer, out.byteOffset);
  const end = out.length - 22;
  assert.equal(v.getUint32(end, true), 0x06054b50);
  assert.equal(v.getUint16(end + 10, true), 2);
  const nameLen = v.getUint16(26, true);
  const size = v.getUint32(18, true);
  const body = out.slice(30 + nameLen, 30 + nameLen + size);
  assert.equal(new TextDecoder().decode(inflateRawSync(body)), '{"name":"acme"}');
});

test('ChatGPT categories map from the old form and brand colours need contrast', () => {
  assert.equal(packs.category('DEVELOPER_TOOLS'), 'Developer Tools');
  assert.equal(packs.category('business & operations'), 'Business & Operations');
  assert.equal(packs.category('Snacks'), null);
  assert.ok(packs.contrast('#2357C6', '#FFFFFF') >= 2);
  assert.ok(packs.contrast('#FFFF66', '#FFFFFF') < 2);
});
