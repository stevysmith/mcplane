import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { schemaProblems } from '../src/agent-plugins.js';
import { listingChecks } from '../src/checks/listing.js';
import { museChallengeCheck, museChallengeUrl } from '../src/checks/muse.js';
import { credentialReads, pluginChecks, policyFindings } from '../src/checks/plugin.js';
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
    assert.match(steps, /about 4 to 6 minutes, and the page's spinner never finishes: reload/);
    assert.match(steps, /"Needs further review" sends a tool to human review\. It isn't an error/);
    assert.match(steps, /Name tools by what they do/);
    assert.match(steps, /cancel the review \(back to Draft\), reconnect so ChatGPT rediscovers the tools, then resubmit/);

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

test('pack muse: the portal’s three tasks, Verify server and per-tool annotations from a saved tool list', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcplane-pack-'));
  const tools = [
    { name: 'get_order', annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false } },
    { name: 'cancel_order', annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true } },
  ];
  await writeFile(join(dir, 'tools.json'), JSON.stringify({ tools }));
  const m: Manifest = { name: 'acme', title: 'Acme', oneLiner: 'Look up Acme orders.', server: { url: 'https://mcp.acme.dev/mcp', auth: 'none' }, links: { privacy: 'https://acme.dev/privacy' } };
  const pack = await packFor(m, 'muse', { dir, tools: 'tools.json' });
  assert.deepEqual(pack.problems, []);
  assert.deepEqual(pack.todo, []);
  const md = String(pack.files.find((f) => f.path === 'muse.md')!.content);
  assert.match(md, /Submitted then In review/);
  assert.match(md, /\*\*Business verification:\*\* a code sent by email\. Each "Verify email" click sends a new code and invalidates the last one/);
  assert.match(md, /\*\*Data processing questionnaire:\*\* your company details and where data is stored/);
  assert.match(md, /\*\*Technical details:\*\* a wizard in five steps: Technical specs, Credentials, Verify server, Test and MCP listing/);
  assert.match(md, /\*\*Credentials:\*\* none required: for an authless MCP/);
  assert.match(md, /Publish https:\/\/mcp\.acme\.dev\/\.well-known\/muse-challenge\/<token> with a body of exactly `muse-challenge=<token>`/);
  assert.match(md, /mcplane preflight --store muse --muse-token <token>/);
  assert.match(md, /Verify before you run Test, since verifying asks for the test again/);
  assert.match(md, /expires about 24 hours after it's shown, and Muse allows one attempt a minute/);
  assert.match(md, /"We couldn't confirm what happened\. Your verification is reloaded; check it before you try again\." three times, and no request ever reached the server/);
  assert.match(md, /- get_order: Read\n- cancel_order: Write/);
  assert.match(md, /hasn't published an update process yet/);
  assert.doesNotMatch(md, /gives no status/);
  const oauth = await packFor({ ...m, server: { ...m.server, auth: 'oauth' } }, 'muse', { dir, tools: 'tools.json' });
  assert.match(String(oauth.files[0].content), /\*\*Credentials:\*\* a test API key or similar/);
  const port = await packFor({ ...m, server: { ...m.server, url: 'https://mcp.acme.dev:8443/mcp' } }, 'muse', { dir, tools: 'tools.json' });
  assert.deepEqual(port.problems, ["Muse verifies your server over HTTPS on port 443, and https://mcp.acme.dev:8443 isn't"]);
});

/* ---------------- Muse: Verify server ---------------- */

test('museChallengeCheck wants exactly "muse-challenge=<token>" as plain text, with no redirect or sign-in', async () => {
  const token = 'tok_123';
  const seen: (string | undefined)[] = [];
  const { server, url } = await serve((req, res) => {
    seen.push(req.headers.authorization ?? req.headers.cookie);
    if (req.url === '/ok') res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(`muse-challenge=${token}`);
    else if (req.url === '/newline') res.writeHead(200, { 'content-type': 'text/plain' }).end(`muse-challenge=${token}\n`);
    else if (req.url === '/html') res.writeHead(200, { 'content-type': 'text/plain' }).end('<!doctype html><html><body>App</body></html>');
    else if (req.url === '/json') res.writeHead(200, { 'content-type': 'application/json' }).end(`muse-challenge=${token}`);
    else if (req.url === '/redirect') res.writeHead(301, { location: '/ok' }).end();
    else if (req.url === '/login') res.writeHead(401).end();
    else res.writeHead(404).end();
  });
  try {
    const check = (path: string) => museChallengeCheck('https://mcp.acme.dev/mcp', token, { url: `${url}${path}` });
    const ok = await check('/ok');
    assert.equal(ok.level, 'pass');
    assert.deepEqual(ok.stores, ['muse']);
    assert.equal((await check('/newline')).level, 'warn');
    assert.match((await check('/json')).detail!, /content type is application\/json/);
    assert.match((await check('/html')).detail!, /answers with a web page/);
    assert.match((await check('/redirect')).detail!, /HTTP 301 redirect to \/ok/);
    assert.match((await check('/login')).detail!, /HTTP 401: the file needs sign-in/);
    assert.match((await check('/missing')).detail!, /HTTP 404/);
    assert.ok(seen.every((h) => h === undefined), 'no token or cookie is sent');
    const count = seen.length;
    const http = await museChallengeCheck(`${url}/mcp`, token);
    assert.equal(http.level, 'fail');
    assert.match(http.detail!, /isn't HTTPS on port 443/);
    assert.equal(seen.length, count, 'a server that is not on HTTPS 443 is not fetched');
    assert.equal(museChallengeUrl('https://mcp.acme.dev/mcp', token), 'https://mcp.acme.dev/.well-known/muse-challenge/tok_123', 'the file is on the MCP host');
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

/* ---------------- Claude plugin directory ---------------- */

const enc = (s: string) => new TextEncoder().encode(s);

/** A plugin folder: .claude-plugin/plugin.json with this icon, plus the given files. */
async function pluginFolder(icon: string | undefined, files: Record<string, string | Uint8Array>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mcplane-plugin-'));
  await mkdir(join(dir, '.claude-plugin'), { recursive: true });
  await writeFile(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'acme', version: '1.0.0', ...(icon ? { icon } : {}) }));
  for (const [path, data] of Object.entries(files)) {
    await mkdir(join(dir, ...path.split('/').slice(0, -1)), { recursive: true });
    await writeFile(join(dir, ...path.split('/')), data);
  }
  return dir;
}

const plugin: Manifest = { name: 'acme', title: 'Acme', server: { url: 'https://mcp.acme.dev/mcp' }, repository: 'https://github.com/acme/acme-plugin', stores: ['claude-plugins'] };

test('policyFindings: what the plugin directory refuses from an unverified organization', () => {
  const f = (path: string, data: string | Uint8Array) => ({ path, data: typeof data === 'string' ? enc(data) : data });
  const found = policyFindings(
    [
      f('.claude-plugin/plugin.json', '{"name":"acme","icon":"./assets/icon.svg"}'),
      f('skills/publish/SKILL.md', '---\nname: publish\n---\nPublish.'),
      f('README', 'Acme'),
      f('LICENSE', 'MIT'),
      f('.gitignore', 'node_modules\n'),
      f('assets/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>'),
      f('assets/logo.png', png(512, 512)),
      f('config.yml', 'a: 1'),
      f('docs/diagram.svg', '<svg/>'),
      f('scripts/run.sh', '#!/bin/sh\n'),
      f('skills/publish/run.md', '#!/usr/bin/env node\n'),
      f('package.json', '{}'),
      f('requirements.txt', 'requests'),
      f('notes.txt', new Uint8Array([0x61, 0x00, 0x62])),
      f('latin1.md', new Uint8Array([0x63, 0x61, 0x66, 0xe9])),
      f('LICENSE.md', '#!not really'),
    ],
    './assets/icon.svg',
  );
  assert.deepEqual(found, [
    { path: 'docs/diagram.svg', why: 'not an allowed type' },
    { path: 'scripts/run.sh', why: 'not an allowed type' },
    { path: 'skills/publish/run.md', why: 'starts with #!' },
    { path: 'package.json', why: 'package manager file' },
    { path: 'requirements.txt', why: 'package manager file' },
    { path: 'notes.txt', why: 'not UTF-8 text, or holds a NUL byte' },
    { path: 'latin1.md', why: 'not UTF-8 text, or holds a NUL byte' },
    { path: 'LICENSE.md', why: 'starts with #!' },
  ]);
});

test('credentialReads: an env var or key file sent to a server, not userConfig, CI or local use', () => {
  const f = (path: string, data: string) => ({ path, data: enc(data) });
  const reads = credentialReads([
    f('skills/publish/SKILL.md', 'curl -H "Authorization: Bearer $ACME_API_KEY" https://api.acme.dev/publish'),
    f('.mcp.json', '{"mcpServers":{"acme":{"url":"https://mcp.acme.dev/mcp","headers":{"Authorization":"Bearer ${ACME_TOKEN}"}}}}'),
    f('skills/pay/SKILL.md', 'Read ~/.acme/wallet.json and POST it to https://pay.acme.dev'),
    f('skills/ok/SKILL.md', 'curl https://api.acme.dev -H "x-key: $CLAUDE_PLUGIN_OPTION_API_KEY" ${user_config.api_key}'),
    f('.github/workflows/ci.yml', 'run: curl -H "Authorization: $GITHUB_TOKEN" https://api.github.com'),
    f('skills/local/SKILL.md', 'Export $ACME_API_KEY before you start.'),
  ]);
  assert.deepEqual(reads, [
    { path: 'skills/publish/SKILL.md', reads: ['$ACME_API_KEY'] },
    { path: '.mcp.json', reads: ['$ACME_TOKEN'] },
    { path: 'skills/pay/SKILL.md', reads: ['~/.acme/wallet.json'] },
  ]);
});

test('pluginChecks: file policy, credential forward and icon, from the plugin folder', async () => {
  const dir = await pluginFolder('./assets/icon.svg', {
    'assets/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"/>',
    'skills/publish/SKILL.md': '---\nname: publish\ndescription: Publish.\n---\ncurl -H "Authorization: Bearer $ACME_API_KEY" https://api.acme.dev\n',
    'scripts/publish.mjs': 'console.log(1)\n',
    'package.json': '{}',
    'node_modules/x/index.js': 'skipped',
    '.DS_Store': new Uint8Array([0, 0, 0, 1]),
  });
  const by = Object.fromEntries((await pluginChecks(plugin, dir)).map((c) => [c.id, c]));
  assert.equal(by['plugin.file-types'].level, 'fail');
  assert.deepEqual(by['plugin.file-types'].stores, ['claude-plugins']);
  assert.equal(by['plugin.file-types'].detail, 'package manager file: package.json; not an allowed type: scripts/publish.mjs');
  assert.match(by['plugin.file-types'].fix!, /"Files outside the allowed types accepted only from Verified organizations"/);
  assert.match(by['plugin.file-types'].fix!, /pre-submission-checklist\.md\) is looser/);
  assert.equal(by['plugin.credential-forward'].level, 'warn');
  assert.equal(by['plugin.credential-forward'].detail, 'skills/publish/SKILL.md ($ACME_API_KEY)');
  assert.match(by['plugin.credential-forward'].fix!, /MCP_FORWARDS_CREDENTIAL_ENV.*"Update adds credential forward".*userConfig in plugin\.json, marked sensitive: true/);
  assert.equal(by['plugin.icon'].level, 'warn');
  assert.equal(by['plugin.icon'].detail, './assets/icon.svg is SVG, 64×64');
  assert.match(by['plugin.icon'].fix!, /256 px PNG.*GitHub repo owner’s avatar.*512 px worked/);

  const verified = Object.fromEntries((await pluginChecks({ ...plugin, claudePlugin: { verified: true } }, dir)).map((c) => [c.id, c.level]));
  assert.equal(verified['plugin.file-types'], 'info', 'Verified organizations are exempt');

  const clean = await pluginFolder('./assets/icon.png', { 'assets/icon.png': png(512, 512), 'skills/publish/SKILL.md': '---\nname: publish\ndescription: Publish.\n---\nUse the publish_html tool.\n', LICENSE: 'MIT', '.gitignore': 'node_modules\n' });
  const ok = await pluginChecks(plugin, clean);
  assert.deepEqual(ok.map((c) => [c.id, c.level]), [['plugin.file-types', 'pass'], ['plugin.credential-forward', 'pass'], ['plugin.icon', 'pass']]);
  const small = await pluginFolder('./assets/icon.png', { 'assets/icon.png': png(128, 96) });
  assert.equal((await pluginChecks(plugin, small)).find((c) => c.id === 'plugin.icon')?.detail, './assets/icon.png is 128×96');

  // claudePlugin.dir points at the plugin from the manifest's folder; with no plugin, a skip only when asked for.
  const parent = join(clean, '..');
  assert.equal((await pluginChecks({ ...plugin, claudePlugin: { dir: relative(parent, clean) } }, parent)).find((c) => c.id === 'plugin.icon')?.level, 'pass');
  const empty = await mkdtemp(join(tmpdir(), 'mcplane-noplugin-'));
  assert.deepEqual((await pluginChecks(plugin, empty, { explicit: true })).map((c) => [c.id, c.level]), [['plugin.files', 'skip']]);
  assert.deepEqual(await pluginChecks(plugin, empty), []);
});

test('pluginChecks reads what git would commit, not ignored files', async (t) => {
  const dir = await pluginFolder('./assets/icon.png', { 'assets/icon.png': png(512, 512), '.gitignore': 'secret.sh\nbuild/\n', 'secret.sh': '#!/bin/sh\n', 'build/out.js': 'x' });
  try {
    execFileSync('git', ['init', '-q', dir]);
  } catch {
    t.skip('git is not installed');
    return;
  }
  const types = (await pluginChecks(plugin, dir)).find((c) => c.id === 'plugin.file-types')!;
  assert.equal(types.level, 'pass', types.detail);
  assert.equal(types.detail, '3 files in .');
});

test('pack claude-plugins: the directory’s file policy, credentials, icon and how a version goes live', async () => {
  const dir = await pluginFolder('./assets/icon.svg', { 'assets/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"/>', 'scripts/run.sh': '#!/bin/sh\n' });
  const pack = await packFor(plugin, 'claude-plugins', { dir });
  assert.deepEqual(pack.problems, ['The plugin’s files meet the Claude plugin directory’s policy: not an allowed type: scripts/run.sh']);
  assert.ok(pack.todo.some((t) => t.startsWith('The plugin’s icon is a square PNG: ./assets/icon.svg is SVG')), pack.todo.join('\n'));
  const md = String(pack.files.find((f) => f.path === 'claude-plugins.md')!.content);
  assert.match(md, /"Files outside the allowed types accepted only from Verified organizations"/);
  assert.match(md, /"Update adds credential forward"/);
  assert.match(md, /plugin-icons\/<hash>\/256\.png/);
  assert.match(md, /An Approved version is not live until it's published/);
  assert.match(md, /"Doesn't apply for now: no version of this plugin goes live without an Anthropic reviewer"/);
  assert.match(md, /every Publish button is disabled while a publish request waits, and a waiting request carries over to the newest Approved version/);
  assert.match(md, /Read the Review tab, not the header banner/);
  assert.match(md, /A live version that no longer meets the policy keeps serving, with a notice/);
  const none = await packFor(plugin, 'claude-plugins', { dir: await mkdtemp(join(tmpdir(), 'mcplane-noplugin-')) });
  assert.ok(none.todo.some((t) => t.includes('Set claudePlugin.dir')));
});

test('pack claude-connectors: review criteria, editing a listing in review, the queue and MCP App screenshots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcplane-pack-'));
  const tools = [
    { name: 'publish', title: 'Publish', annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false }, _meta: { ui: { resourceUri: 'ui://acme/card' } } },
    { name: 'get_order', title: 'Get order', annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false } },
  ];
  await writeFile(join(dir, 'tools.json'), JSON.stringify({ tools }));
  const m: Manifest = { name: 'acme', title: 'Acme', oneLiner: 'Acme orders.', server: { url: 'https://mcp.acme.dev/mcp', auth: 'oauth' }, reviewerAccess: 'reviewer@acme.dev, password in the form' };
  const pack = await packFor(m, 'claude-connectors', { dir, tools: 'tools.json' });
  const md = String(pack.files[0].content);
  assert.match(md, /review-criteria\.md/);
  assert.match(md, /"Transfer money, cryptocurrency, or other financial assets"/);
  assert.match(md, /"collect conversation data beyond what the tool needs"/);
  assert.match(md, /your server has an MCP App \(publish shows a ui:\/\/ resource\), so add 3 to 5 PNG screenshots/);
  assert.ok(pack.todo.some((t) => t.includes('3 to 5 PNG screenshots')));
  assert.match(md, /A reviewer test account is required/);
  assert.match(md, /\*\*Update the copy reviewers see\*\* has Claude re-read your server's tools, prompts and MCP App through a custom connector/);
  assert.match(md, /Customize > Connectors > Add custom connector, then sign in/);
  assert.match(md, /\*\*Sync from server\*\* replaces the tool names/);
  assert.match(md, /"Reviewers see what you save here, so you don't need to resubmit"/);
  assert.match(md, /Withdrawing frees the slug but loses your place in the queue/);
  assert.match(md, /claude-ai-mcp\/issues\/1192/);
  assert.match(md, /mcp-review@anthropic\.com get automatic replies only/);
  assert.match(md, /submission-status\.md/);
  await writeFile(join(dir, 'tools.json'), JSON.stringify({ tools: [tools[1]] }));
  const plain = await packFor(m, 'claude-connectors', { dir, tools: 'tools.json' });
  assert.match(String(plain.files[0].content), /Screenshots: none needed: no tool shows an MCP App/);
  assert.deepEqual(plain.todo, []);
});
