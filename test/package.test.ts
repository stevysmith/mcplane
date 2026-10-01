import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { schemaProblems } from '../src/agent-plugins.js';
import { listingChecks } from '../src/checks/listing.js';
import { iconProblems, imageInfo } from '../src/images.js';
import { packFor, parseToolsFile } from '../src/packs.js';
import { bundleSkills, frontMatter } from '../src/skills.js';
import type { Manifest } from '../src/types.js';
import { DOS_DATE, unzip, zip } from '../src/zip.js';

/* ---------------- fixtures ---------------- */

const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16be = (n: number) => [(n >>> 8) & 255, n & 255];
const u16le = (n: number) => [n & 255, (n >>> 8) & 255];
const u24le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

const png = (w: number, h: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32be(13), ...ascii('IHDR'), ...u32be(w), ...u32be(h), 8, 6, 0, 0, 0, 0, 0, 0, 0]);
// SOI, an APP0 segment, then a baseline start-of-frame (C0) holding height then width.
const jpeg = (w: number, h: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...u16be(16), ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, ...u16be(17), 8, ...u16be(h), ...u16be(w), 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9]);
const riff = (chunk: string, body: number[]) => new Uint8Array([...ascii('RIFF'), ...u32be(0).reverse(), ...ascii('WEBP'), ...ascii(chunk), ...u32be(body.length).reverse(), ...body]);
const webpX = (w: number, h: number) => riff('VP8X', [0, 0, 0, 0, ...u24le(w - 1), ...u24le(h - 1)]);
const webpL = (w: number, h: number) => {
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
  return riff('VP8L', [0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255]);
};
const webpLossy = (w: number, h: number) => riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(w), ...u16le(h)]);
const svg = (attrs: string) => new TextEncoder().encode(`<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect/></svg>`);

function serve(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` })));
}

const skill = (name: string, description: string, body = 'Do the thing.\n') => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;

/* ---------------- ZIP ---------------- */

test('zip dates every entry 1980-01-01, marks it as made on Unix and keeps executable bits', () => {
  const files = [
    { path: 'plugin.json', data: '{"name":"acme"}' },
    { path: 'skills/run/scripts/run.sh', data: '#!/bin/sh\necho hi\n', mode: 0o755 },
  ];
  const out = zip(files);
  const entries = unzip(out);
  assert.deepEqual(entries.map((e) => [e.path, e.mode, e.dosDate]), [['plugin.json', 0o644, DOS_DATE], ['skills/run/scripts/run.sh', 0o755, DOS_DATE]]);
  assert.equal(DOS_DATE, 0x21);
  assert.equal(new TextDecoder().decode(entries[1].data), '#!/bin/sh\necho hi\n');
  assert.deepEqual(zip(files), out, 'the same files give the same bytes');
});

test('zip: an independent reader sees the dates and modes', async (t) => {
  let zipinfo: string;
  const dir = await mkdtemp(join(tmpdir(), 'mcplane-zip-'));
  const file = join(dir, 'p.zip');
  await writeFile(file, zip([{ path: 'a.txt', data: 'a' }, { path: 'run.sh', data: 'echo', mode: 0o755 }]));
  try {
    zipinfo = execFileSync('zipinfo', [file], { encoding: 'utf8' });
  } catch {
    t.skip('zipinfo is not installed');
    return;
  }
  assert.match(zipinfo, /-rw-r--r--.*80-Jan-01.*a\.txt/);
  assert.match(zipinfo, /-rwxr-xr-x.*80-Jan-01.*run\.sh/);
});

/* ---------------- images ---------------- */

test('imageInfo reads sizes from PNG, JPEG, WebP and SVG bytes', () => {
  assert.deepEqual(imageInfo(png(512, 512)), { format: 'png', width: 512, height: 512 });
  assert.deepEqual(imageInfo(jpeg(640, 480)), { format: 'jpeg', width: 640, height: 480 });
  assert.deepEqual(imageInfo(webpX(256, 256)), { format: 'webp', width: 256, height: 256 });
  assert.deepEqual(imageInfo(webpL(300, 200)), { format: 'webp', width: 300, height: 200 });
  assert.deepEqual(imageInfo(webpLossy(128, 128)), { format: 'webp', width: 128, height: 128 });
  assert.deepEqual(imageInfo(svg('viewBox="0 0 64 64"')), { format: 'svg', width: 64, height: 64 });
  assert.deepEqual(imageInfo(svg('width="100" height="50"')), { format: 'svg', width: 100, height: 50 });
  assert.match(imageInfo(svg('class="x"')).error!, /neither a viewBox nor a width and height/);
  assert.equal(imageInfo(new TextEncoder().encode('<html>not an icon</html>')).format, null);
});

test('icon rules apply to every format, not just PNG', () => {
  assert.deepEqual(iconProblems(imageInfo(png(512, 512)), 'icon'), []);
  assert.match(iconProblems(imageInfo(jpeg(640, 480)), 'icon')[0], /640×480; it must be square/);
  assert.match(iconProblems(imageInfo(webpX(5000, 5000)), 'icon')[0], /48 to 4096 px/);
  assert.match(iconProblems(imageInfo(svg('viewBox="0 0 64 32"')), 'icon')[0], /must be square/);
  assert.deepEqual(iconProblems(imageInfo(svg('viewBox="0 0 24 24"')), 'icon').length, 1);
});

/* ---------------- skills ---------------- */

test('frontMatter reads the YAML skills use, and refuses what strict loaders refuse', () => {
  const ok = frontMatter('---\nname: publish\ndescription: >-\n  Publish HTML and\n  get a link.\nmetadata:\n  owner: acme\nallowed-tools:\n  - Bash\n---\nBody\n');
  assert.ok(!('error' in ok));
  if ('error' in ok) return;
  assert.equal(ok.data.description, 'Publish HTML and get a link.');
  assert.deepEqual(ok.data.metadata, { owner: 'acme' });
  assert.deepEqual(ok.data['allowed-tools'], ['Bash']);
  assert.equal(ok.body.trim(), 'Body');
  const quoted = frontMatter('---\nname: "publish"\ndescription: "Use when: the user says \\"publish\\""\n---\nx');
  assert.ok(!('error' in quoted) && quoted.data.description === 'Use when: the user says "publish"');
  const literal = frontMatter("---\nname: 'it''s'\ndescription: |\n  line one\n  line two\n---\nx");
  assert.ok(!('error' in literal) && literal.data.name === "it's" && literal.data.description === 'line one\nline two');
  assert.match((frontMatter('---\nname: x\ndescription: Use when: anything\n---\nx') as { error: string }).error, /quote the value/);
  assert.match((frontMatter('# Just markdown') as { error: string }).error, /must start with front matter/);
  assert.match((frontMatter('---\nname: x\n') as { error: string }).error, /no closing/);
});

test('bundleSkills keeps scripts executable and finds what stores reject', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcplane-skills-'));
  const at = (...p: string[]) => join(dir, 'skills', ...p);
  await mkdir(at('publish', 'scripts'), { recursive: true });
  await writeFile(at('publish', 'SKILL.md'), skill('publish', 'Publish a page and return its link.', 'Run `bash scripts/publish.sh`.\n'));
  await writeFile(at('publish', 'scripts', 'publish.sh'), '#!/bin/sh\n');
  await chmod(at('publish', 'scripts', 'publish.sh'), 0o755);
  await writeFile(at('publish', '.env'), 'SECRET=1');
  await mkdir(at('report'), { recursive: true });
  await writeFile(at('report', 'SKILL.md'), skill('acme-report', 'Writes a report.', 'Then run scripts/publish.sh.\n'));
  await mkdir(at('long'), { recursive: true });
  await writeFile(at('long', 'SKILL.md'), `---\nname: long\ndescription: ${'x'.repeat(1025)}\nversion: 2\n---\nBody\n`);
  await mkdir(at('empty'), { recursive: true });

  const b = await bundleSkills('skills', dir, 'acme');
  const paths = Object.fromEntries(b.files.map((f) => [f.path, f.mode]));
  assert.equal(paths['skills/publish/scripts/publish.sh'], 0o755);
  assert.equal(paths['skills/publish/SKILL.md'], 0o644);
  assert.ok(!('skills/publish/.env' in paths), 'hidden files stay out');
  assert.ok(b.todo.some((t) => t.includes('.env')));
  assert.ok(b.todo.some((t) => t.includes('"version"')));
  const problems = b.problems.join('\n');
  assert.match(problems, /skills\/report\/SKILL.md: name "acme-report" doesn't match its folder "report"/);
  assert.match(problems, /skills\/report\/SKILL.md refers to scripts\/publish.sh, which isn't in the skill's folder/);
  assert.match(problems, /skills\/long\/SKILL.md: the description is 1025 characters; the limit is 1024/);
  assert.match(problems, /skills\/empty has no SKILL.md/);
  assert.doesNotMatch(problems, /skills\/publish/);
  assert.deepEqual(b.names, ['long', 'publish', 'acme-report']);

  const picked = await bundleSkills(['skills/publish'], dir, 'acme');
  assert.deepEqual(picked.problems, []);
  assert.deepEqual(picked.names, ['publish']);
  assert.match((await bundleSkills('nope', dir, 'acme')).problems[0], /chatgpt.skills: nope isn't a folder/);
  assert.deepEqual(await bundleSkills([], dir, 'acme'), { files: [], names: [], problems: [], todo: [] }, 'an empty list ships an MCP-only package');
});

/* ---------------- Agent Plugins schema ---------------- */

const PLUGIN = { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'acme', version: '1.0.0', description: 'Acme orders.', author: { name: 'Acme' }, extensions: { 'com.openai': {} } };
const MCP = { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { acme: { type: 'streamable-http', url: 'https://mcp.acme.dev/mcp' } } };

test('schemaProblems checks plugin.json and mcp.json against the Agent Plugins 1.0.0 schemas', async () => {
  assert.deepEqual(await schemaProblems(PLUGIN, MCP), []);
  const bad = await schemaProblems({ ...PLUGIN, name: 'Acme--App', icon: 'x.png', author: { name: 'Acme', phone: '1' } }, { ...MCP, mcpServers: { acme: { type: 'http', url: 'https://x' }, b: { type: 'streamable-http' } } });
  assert.ok(bad.some((p) => p.startsWith('plugin.json /name must be lowercase')), bad.join('\n'));
  assert.ok(bad.includes('plugin.json: "icon" isn\'t allowed by the Agent Plugins schema'), bad.join('\n'));
  assert.ok(bad.includes('plugin.json /author: "phone" isn\'t allowed by the Agent Plugins schema'), bad.join('\n'));
  assert.ok(bad.includes('mcp.json /mcpServers/acme: "type" must be stdio, streamable-http or sse (Agent Plugins schema)'), bad.join('\n'));
  assert.ok(bad.includes('mcp.json /mcpServers/b: "url" is required by the Agent Plugins schema'), bad.join('\n'));
  assert.equal(bad.length, 5, bad.join('\n'));
});

/* ---------------- tools from a file ---------------- */

test('parseToolsFile takes a tools/list result, a JSON-RPC reply or a bare list', () => {
  const tools = [{ name: 'get_order' }];
  assert.deepEqual(parseToolsFile(JSON.stringify(tools)), tools);
  assert.deepEqual(parseToolsFile(JSON.stringify({ tools })), tools);
  assert.deepEqual(parseToolsFile(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools } })), tools);
  assert.throws(() => parseToolsFile('{"tools": [{"title": "no name"}]}', 'tools.json'), /tools.json should hold a tools\/list result/);
  assert.throws(() => parseToolsFile('nope', 'tools.json'), /isn't valid JSON/);
});

/* ---------------- the ChatGPT package ---------------- */

const base = (url: string, dir: string): Manifest => ({
  name: 'acme',
  title: 'Acme',
  subtitle: 'Look up orders',
  oneLiner: 'Look up Acme orders.',
  description: 'Acme orders, invoices and shipping.',
  category: 'Productivity',
  version: '1.2.0',
  server: { url: `${url}/mcp`, auth: 'oauth' },
  author: { name: 'Acme Ltd', url: 'https://acme.dev' },
  links: { website: 'https://acme.dev', support: 'https://acme.dev/support', privacy: 'https://acme.dev/privacy', terms: 'https://acme.dev/terms' },
  icon: 'assets/icon.png',
  tests: {
    positive: [1, 2, 3, 4, 5].map((n) => ({ scenario: `Case ${n}`, prompt: `Order ${n}?`, tools: ['get_order'], expected: 'The order.' })),
    negative: [1, 2, 3].map((n) => ({ scenario: `Not ${n}`, prompt: `Weather ${n}?` })),
  },
  chatgpt: { demoVideo: 'https://acme.dev/demo.mp4', releaseNotes: 'First version.', skills: 'skills' },
  justifications: { get_order: { readOnly: 'Reads only.' } },
});

test('pack chatgpt builds behind sign-in without --token, bundling local icons and skills', async () => {
  // An OAuth server: everything is 401 until sign-in.
  const { server, url } = await serve((req, res) => {
    res.writeHead(401, { 'www-authenticate': 'Bearer resource_metadata="x"' }).end();
  });
  try {
    const dir = await mkdtemp(join(tmpdir(), 'mcplane-pack-'));
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'assets', 'icon.png'), png(512, 512));
    await mkdir(join(dir, 'skills', 'orders', 'scripts'), { recursive: true });
    await writeFile(join(dir, 'skills', 'orders', 'SKILL.md'), skill('orders', 'Look up an order.', 'Run scripts/find.sh.\n'));
    await writeFile(join(dir, 'skills', 'orders', 'scripts', 'find.sh'), '#!/bin/sh\n');
    await chmod(join(dir, 'skills', 'orders', 'scripts', 'find.sh'), 0o755);

    const pack = await packFor(base(url, dir), 'chatgpt', { dir });
    assert.deepEqual(pack.problems, []);
    assert.ok(pack.todo.some((t) => /\(HTTP 401\); pass --token\. The pack was built without it.*--tools <file>/.test(t)), pack.todo.join('\n'));
    const file = pack.files.find((f) => f.path === 'chatgpt/acme-1.2.0.zip')!;
    const entries = Object.fromEntries(unzip(file.content as Uint8Array).map((e) => [e.path, e]));
    assert.deepEqual(Object.keys(entries).sort(), ['assets/logo.png', 'mcp.json', 'plugin.json', 'skills/orders/SKILL.md', 'skills/orders/scripts/find.sh']);
    assert.equal(entries['skills/orders/scripts/find.sh'].mode, 0o755);
    const plugin = JSON.parse(new TextDecoder().decode(entries['plugin.json'].data));
    assert.equal(plugin.extensions['com.openai'].interface.logo, './assets/logo.png');
    assert.equal(plugin.extensions['com.openai'].interface.composerIcon, './assets/logo.png');
    const steps = String(pack.files.find((f) => f.path === 'chatgpt/chatgpt.md')!.content);
    assert.match(steps, /adds the skill orders/);
    assert.match(steps, /### get_order\n- readOnlyHint: Reads only\./, 'with no tool list, appeal notes keep every tool');

    // The root description limit, and a non-square icon in a format other than PNG.
    await writeFile(join(dir, 'assets', 'wide.jpg'), jpeg(800, 600));
    const long = await packFor({ ...base(url, dir), oneLiner: 'x'.repeat(1025), chatgpt: { ...base(url, dir).chatgpt, logo: 'assets/wide.jpg' } }, 'chatgpt', { dir });
    assert.ok(long.problems.some((p) => /1025 characters; the limit is 1024 \(plugin_description_too_long\)/.test(p)), long.problems.join('\n'));
    assert.ok(long.problems.includes('chatgpt.logo is 800×600; it must be square'), long.problems.join('\n'));
  } finally {
    server.close();
  }
});

test('pack chatgpt checks test cases against a saved tool list', async () => {
  const { server, url } = await serve((req, res) => res.writeHead(401).end());
  try {
    const dir = await mkdtemp(join(tmpdir(), 'mcplane-pack-'));
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'assets', 'icon.png'), png(512, 512));
    await writeFile(join(dir, 'tools.json'), JSON.stringify({ tools: [{ name: 'list_orders', annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false } }] }));
    const m = { ...base(url, dir), chatgpt: { ...base(url, dir).chatgpt, skills: undefined } };
    const pack = await packFor(m, 'chatgpt', { dir, tools: 'tools.json' });
    assert.ok(pack.problems.includes(`test "Case 1" names a tool the server doesn't have: get_order`), pack.problems.join('\n'));
    assert.ok(pack.todo.some((t) => t.includes('No positive test uses list_orders')));
    assert.ok(!pack.todo.some((t) => t.includes('built without')));
    await assert.rejects(packFor(m, 'chatgpt', { dir, tools: 'missing.json' }), /Can't read missing.json/);
  } finally {
    server.close();
  }
});

/* ---------------- preflight: the icon and the package description ---------------- */

test('listing checks: a local icon, any image format, and the plugin description limit', async () => {
  const { server, url } = await serve((req, res) => {
    if (req.url === '/wide.jpg') res.writeHead(200, { 'content-type': 'image/jpeg' }).end(jpeg(800, 600));
    else if (req.url === '/big.png') res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.concat([Buffer.from(png(512, 512)), Buffer.alloc(30 * 1024)]));
    else res.writeHead(404).end();
  });
  try {
    const m: Manifest = { name: 'acme', title: 'Acme', server: { url: `${url}/mcp` }, icon: 'assets/icon.png', oneLiner: 'x'.repeat(1100) };
    const by = async (mm: Manifest, stores: Parameters<typeof listingChecks>[2]) => Object.fromEntries((await listingChecks(mm, [], stores)).map((c) => [c.id, c]));
    const onlyChatgpt = await by(m, ['chatgpt']);
    assert.equal(onlyChatgpt['listing.icon'].level, 'info');
    assert.equal(onlyChatgpt['listing.plugin-description'].level, 'fail');
    assert.match(onlyChatgpt['listing.plugin-description'].detail!, /1100 characters \(plugin_description_too_long\)/);
    const both = await by(m, ['chatgpt', 'claude-connectors']);
    assert.equal(both['listing.icon'].level, 'warn');
    assert.deepEqual(both['listing.icon'].stores, ['claude-connectors']);
    const jpg = await by({ ...m, icon: `${url}/wide.jpg` }, ['claude-connectors']);
    assert.equal(jpg['listing.icon'].level, 'warn');
    assert.equal(jpg['listing.icon'].detail, 'JPEG, 800×600');
    // Over 10 KB is fine now: the ZIP takes 5 MiB, so there's no small-icon warning.
    const big = await by({ ...m, icon: `${url}/big.png` }, ['chatgpt']);
    assert.equal(big['listing.icon'].level, 'pass');
    assert.equal(big['listing.icon-small'], undefined);
  } finally {
    server.close();
  }
});
