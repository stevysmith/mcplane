import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { toolChecks } from '../src/checks/tools.js';
import { diffTools } from '../src/drift.js';
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

test('thirdPerson conjugates the opening verb only', () => {
  assert.equal(packs.thirdPerson('Add a report'), 'adds a report');
  assert.equal(packs.thirdPerson('Search the catalog'), 'searches the catalog');
  assert.equal(packs.thirdPerson('Copy a file'), 'copies a file');
  assert.equal(packs.thirdPerson('The current weather'), null);
});

test('justifications stay under ChatGPT’s 200 characters and prefer your own', () => {
  const t: Tool = { name: 'x', description: `Publish ${'a very long description '.repeat(20)}.`, annotations: hints(false, true) };
  const j = packs.justify(t, 'Acme');
  for (const v of Object.values(j)) assert.ok(v.length <= 200, v);
  assert.equal(packs.justify(t, 'Acme', { openWorld: 'Mine.' }).open_world_justification, 'Mine.');
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
