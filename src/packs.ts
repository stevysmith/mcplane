/**
 * Submission packs: everything a store asks for, checked against its limits.
 * ChatGPT gets the plugin ZIP its portal uploads; the rest get a markdown pack
 * to paste from.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureLocalDir } from './manifest.js';
import { forStore } from './draft.js';
import { McpClient } from './mcp-client.js';
import { zip, type ZipEntry } from './zip.js';
import { DESCRIPTION_MAX, MCP_SCHEMA, PLUGIN_SCHEMA, schemaProblems } from './agent-plugins.js';
import { EXTENSION, iconProblems, imageInfo } from './images.js';
import { bundleSkills } from './skills.js';
import { ardManifest, validateArd } from './checks/ard.js';
import { discover, metadata } from './checks/oauth.js';
import { CONNECT_CALLBACK, SUBJECTS, clientCreation, vercelChecks } from './checks/vercel.js';
import { evalSuite, toolId, type EvalPlugin } from './evals.js';
import type { Manifest, StoreId, Tool } from './types.js';

export interface Pack {
  files: { path: string; content: string | Uint8Array }[];
  problems: string[];
  todo: string[];
}

export async function listTools(m: Manifest, token?: string): Promise<Tool[]> {
  const c = new McpClient(m.server.url, token ? { authorization: `Bearer ${token}` } : {});
  const init = await c.initialize();
  if (init.status >= 400) throw new Error(`Couldn't read tools from ${m.server.url} (HTTP ${init.status})${m.server.auth === 'oauth' ? '; pass --token' : ''}.`);
  const r = await c.request('tools/list');
  return (r.body?.result?.tools ?? []) as Tool[];
}

export interface PackOptions {
  /** Access token for a server behind sign-in. */
  token?: string;
  /** A saved tools/list result to use instead of asking the server. */
  tools?: string;
  /** The folder holding mcplane.json, which local paths are relative to. */
  dir?: string;
}

/** A saved tools/list: the result ({ "tools": [...] }), the whole JSON-RPC reply, or just the array. */
export function parseToolsFile(text: string, file = 'the tools file'): Tool[] {
  let v: any;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} isn't valid JSON: ${(e as Error).message}`);
  }
  const tools = Array.isArray(v) ? v : Array.isArray(v?.tools) ? v.tools : Array.isArray(v?.result?.tools) ? v.result.tools : null;
  if (!tools || tools.some((t: any) => typeof t?.name !== 'string')) throw new Error(`${file} should hold a tools/list result: { "tools": [ { "name": … }, … ] }`);
  return tools as Tool[];
}

/**
 * The tool list a pack checks against: a saved file when given, else the live server. A pack that
 * doesn't need the list to build (the ChatGPT ZIP, the Claude form) still builds when neither works.
 */
async function toolsFor(m: Manifest, opts: PackOptions): Promise<{ tools: Tool[] | null; why?: string }> {
  if (opts.tools) {
    const path = resolve(opts.dir ?? process.cwd(), opts.tools);
    const text = await readFile(path, 'utf8').catch(() => {
      throw new Error(`Can't read ${opts.tools}.`);
    });
    return { tools: parseToolsFile(text, opts.tools) };
  }
  try {
    return { tools: await listTools(m, opts.token) };
  } catch (e) {
    return { tools: null, why: (e as Error).message };
  }
}

const withoutTools = (why: string | undefined, checked: string) =>
  `${why ?? 'No tool list.'} The pack was built without it, so ${checked} weren't checked. --tools <file> takes a saved tools/list result instead.`;

/**
 * OpenAI no longer asks for hint justifications: its automated review checks the hints and you appeal
 * if it flags one. Justifications already written in mcplane.json are kept as notes for that appeal.
 * With no tool list, every note is kept and the hint values are left out.
 */
function appealNotes(m: Manifest, tools: Tool[] | null): string {
  const live = new Map((tools ?? []).map((t) => [t.name, t.annotations ?? {}]));
  return Object.entries(m.justifications ?? {})
    .filter(([name]) => !tools || live.has(name))
    .map(([name, j]) => {
      const a = live.get(name);
      const line = (hint: string, value: boolean | undefined, why?: string) => (why ? `\n- ${hint}${a ? ` ${!!value}` : ''}: ${why}` : '');
      return `### ${name}${line('readOnlyHint', a?.readOnlyHint, j.readOnly)}${line('openWorldHint', a?.openWorldHint, j.openWorld)}${line('destructiveHint', a?.destructiveHint, j.destructive)}`;
    })
    .join('\n\n');
}

/** The categories ChatGPT's package validator accepts, and the old form's names mapped onto them. */
const CATEGORIES = ['Productivity', 'Creativity', 'Developer Tools', 'Business & Operations', 'Data & Analytics', 'Communication', 'Education & Research', 'Security', 'Finance', 'Healthcare', 'Travel', 'Entertainment', 'Other'];
const OLD_CATEGORY: Record<string, string> = {
  BUSINESS: 'Business & Operations', COLLABORATION: 'Communication', DESIGN: 'Creativity', DEVELOPER_TOOLS: 'Developer Tools', EDUCATION: 'Education & Research',
  ENTERTAINMENT: 'Entertainment', FINANCE: 'Finance', PRODUCTIVITY: 'Productivity', TRAVEL: 'Travel', FOOD: 'Other', LIFESTYLE: 'Other', NEWS: 'Other', SHOPPING: 'Other',
};
function category(raw?: string): string | null {
  if (!raw) return null;
  const hit = CATEGORIES.find((c) => c.toLowerCase() === raw.toLowerCase());
  return hit ?? OLD_CATEGORY[raw.toUpperCase().replace(/[^A-Z]+/g, '_')] ?? null;
}

/** WCAG contrast ratio between two #RRGGBB colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/**
 * An icon for the package, from a URL or a local file (relative to mcplane.json), checked against the
 * package rules: PNG, JPEG, WebP or SVG by its bytes, square, 48 to 4096 px, at most 5 MiB.
 */
async function loadIcon(ref: string, label: string, dir: string, problems: string[]): Promise<{ data: Uint8Array; ext: string } | null> {
  let data: Uint8Array;
  if (/^https?:\/\//i.test(ref)) {
    const res = await fetch(ref, { headers: { 'user-agent': 'mcplane' }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (!res?.ok) {
      problems.push(`${label} ${ref} didn't load (HTTP ${res?.status ?? 'error'})`);
      return null;
    }
    data = new Uint8Array(await res.arrayBuffer());
  } else {
    const path = /^file:/i.test(ref) ? fileURLToPath(ref) : resolve(dir, ref);
    const read = await readFile(path).catch(() => null);
    if (!read) {
      problems.push(`${label} ${ref} isn't a file (paths are relative to mcplane.json)`);
      return null;
    }
    data = new Uint8Array(read);
  }
  const info = imageInfo(data);
  if (data.length > 5 * 1024 * 1024) problems.push(`${label} is ${(data.length / 1048576).toFixed(1)} MiB; the limit is 5 MiB`);
  if (!info.format) {
    problems.push(`${label} ${ref} isn't a PNG, JPEG, WebP or SVG image`);
    return null;
  }
  problems.push(...iconProblems(info, label));
  return { data, ext: EXTENSION[info.format] };
}

/**
 * ChatGPT: the plugin ZIP the portal takes since DevDay (27 Sep 2026). plugin.json in the
 * Agent Plugins format carries the listing, the 5+3 test cases, demo video, release notes
 * and translations; mcp.json points at the server; icons are bundled. Reviewer credentials
 * and the policy attestations stay in the dashboard.
 */
export async function chatgptPack(m: Manifest, opts: PackOptions = {}): Promise<Pack> {
  m = forStore(m, 'chatgpt');
  const g = m.chatgpt ?? {};
  const dir = opts.dir ?? process.cwd();
  const listed = await toolsFor(m, opts);
  const tools = listed.tools ?? [];
  const problems: string[] = [];
  const todo: string[] = [];
  if (!listed.tools) todo.push(withoutTools(listed.why, 'tool hints and the tools your test cases name'));
  const need = (ok: unknown, msg: string) => {
    if (!ok) problems.push(msg);
  };
  const oneLine = (v: string | undefined, max: number, label: string) => {
    need(v, `${label} is missing`);
    if (v && v.length > max) problems.push(`${label} is ${v.length} characters; the limit is ${max}`);
    if (v && /\n/.test(v)) problems.push(`${label} must be one line`);
  };

  need(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(m.name) && m.name.length <= 64, `name "${m.name}" must be lowercase letters, digits and single hyphens, at most 64 characters`);
  need(m.version && /^\d+\.\d+\.\d+/.test(m.version), 'version must be a semantic version (e.g. 1.0.0); every upload needs a new one');
  oneLine(m.title, 30, 'Display name (title)');
  oneLine(m.subtitle, 30, 'Short description (subtitle)');
  need(m.description, 'Long description is missing');
  if ((m.description ?? '').length > 4000) problems.push(`Long description is ${m.description!.length} characters; the limit is 4000`);
  const developerName = g.developerName ?? m.author?.name;
  oneLine(developerName, 80, 'Developer name (chatgpt.developerName or author.name)');
  const cat = category(m.category);
  need(cat, `category "${m.category ?? ''}" isn't one of: ${CATEGORIES.join(', ')}`);
  for (const [k, v] of Object.entries({ website: m.links?.website, support: m.links?.support, privacy: m.links?.privacy, terms: m.links?.terms }))
    need(v && v.startsWith('https://'), `links.${k} must be an https URL (all four are required for review)`);
  const prompts = m.prompts ?? [];
  if (prompts.length > 3) problems.push(`${prompts.length} starter prompts; the limit is 3`);
  for (const p of prompts) if (p.length > 128 || /\n/.test(p) || /(^|\s)@\w/.test(p)) problems.push(`starter prompt "${p.slice(0, 40)}…" must be one line, at most 128 characters, with no @mention`);
  for (const c of g.capabilities ?? []) if (c.length > 120) problems.push(`capability "${c.slice(0, 40)}…" is over 120 characters`);
  if ((g.capabilities ?? []).length > 20) problems.push('at most 20 capabilities');
  if (g.brandColor && (!/^#[0-9a-fA-F]{6}$/.test(g.brandColor) || contrast(g.brandColor, '#FFFFFF') < 2)) problems.push(`brandColor ${g.brandColor} needs 2:1 contrast against white`);
  if (g.brandColorDark && (!/^#[0-9a-fA-F]{6}$/.test(g.brandColorDark) || contrast(g.brandColorDark, '#212121') < 2)) problems.push(`brandColorDark ${g.brandColorDark} needs 2:1 contrast against #212121`);
  need(g.demoVideo, 'chatgpt.demoVideo is missing: a reviewer-accessible video URL showing the main use cases (required for review; "mcplane demo" records one)');
  need(g.releaseNotes, 'chatgpt.releaseNotes is missing (required for review)');

  const missingHints = tools.filter((t) => ['readOnlyHint', 'openWorldHint', 'destructiveHint'].some((h) => typeof (t.annotations as any)?.[h] !== 'boolean'));
  for (const t of missingHints) problems.push(`${t.name} doesn't set all three hints; ChatGPT treats that as a blocker`);

  const pos = m.tests?.positive ?? [];
  const neg = m.tests?.negative ?? [];
  const names = new Set(tools.map((t) => t.name));
  if (pos.length !== 5) problems.push(`tests.positive has ${pos.length}; ChatGPT needs exactly 5`);
  if (neg.length !== 3) problems.push(`tests.negative has ${neg.length}; ChatGPT needs exactly 3`);
  if (listed.tools) for (const p of pos) for (const n of p.tools) if (!names.has(n)) problems.push(`test "${p.scenario}" names a tool the server doesn't have: ${n}`);
  const covered = new Set(pos.flatMap((p) => p.tools));
  for (const t of tools) if (!covered.has(t.name)) todo.push(`No positive test uses ${t.name}. Reviewers check every tool.`);

  // Icons, bundled into the package, from URLs or local files.
  const assets: ZipEntry[] = [];
  const icon = async (ref: string | undefined, file: string, label: string) => {
    if (!ref) return undefined;
    const got = await loadIcon(ref, label, dir, problems);
    if (!got) return undefined;
    const path = `assets/${file}.${got.ext}`;
    assets.push({ path, data: got.data });
    return `./${path}`;
  };
  const logoRef = g.logo ?? m.icon;
  need(logoRef, 'icon is missing: a square image, 48 to 4096 px (a URL, or a local file in chatgpt.logo)');
  const logo = await icon(logoRef, 'logo', g.logo ? 'chatgpt.logo' : 'icon');
  const composerIcon = (await icon(g.composerIcon, 'composer-icon', 'chatgpt.composerIcon')) ?? logo;
  const logoDark = await icon(g.logoDark, 'logo-dark', 'chatgpt.logoDark');

  // Agent Skills, under skills/<folder>/ as the Agent Plugins format discovers them.
  const skills = await bundleSkills(g.skills, dir, m.name);
  problems.push(...skills.problems);
  todo.push(...skills.todo);

  const description = m.oneLiner || m.subtitle || m.title;
  if (description.length > DESCRIPTION_MAX) problems.push(`plugin.json's description, taken from oneLiner, is ${description.length} characters; the limit is ${DESCRIPTION_MAX} (plugin_description_too_long). listing.chatgpt.oneLiner can shorten it for ChatGPT only`);

  const plugin = {
    $schema: PLUGIN_SCHEMA,
    name: m.name,
    version: m.version ?? '1.0.0',
    description,
    author: { name: developerName ?? m.title, ...(m.author?.url ? { url: m.author.url } : {}) },
    ...(m.links?.website ? { homepage: m.links.website } : {}),
    ...(m.repository ? { repository: m.repository } : {}),
    extensions: {
      'com.openai': {
        interface: {
          displayName: m.title,
          shortDescription: m.subtitle ?? '',
          longDescription: m.description ?? '',
          developerName: developerName ?? '',
          category: cat ?? 'Other',
          capabilities: g.capabilities ?? [],
          websiteURL: m.links?.website,
          supportURL: m.links?.support,
          privacyPolicyURL: m.links?.privacy,
          termsOfServiceURL: m.links?.terms,
          ...(prompts.length ? { defaultPrompt: prompts.slice(0, 3) } : {}),
          ...(g.brandColor ? { brandColor: g.brandColor } : {}),
          ...(g.brandColorDark ? { brandColorDark: g.brandColorDark } : {}),
          ...(logo ? { logo } : {}),
          ...(composerIcon ? { composerIcon } : {}),
          ...(logoDark ? { logoDark } : {}),
        },
        review: {
          test_cases: {
            positive: pos.map((p) => ({ description: p.scenario, prompt: p.prompt, tools_triggered: p.tools.join(', '), expected_behavior: p.expected })),
            negative: neg.map((n) => ({ description: n.scenario, prompt: n.prompt })),
          },
          ...(g.demoVideo ? { demo_recording_url: g.demoVideo } : {}),
          ...(g.commerce !== undefined ? { commerce: g.commerce } : {}),
          ...(g.commerceDescription ? { commerce_description: g.commerceDescription } : {}),
        },
        publication: {
          ...(g.countries ? { countries: g.countries } : {}),
          ...(g.releaseNotes ? { release_notes: g.releaseNotes } : {}),
          ...(g.translations ? { translations: g.translations } : {}),
        },
      },
    },
  };
  const mcp = { $schema: MCP_SCHEMA, mcpServers: { [m.name]: { type: 'streamable-http', url: m.server.url } } };
  problems.push(...(await schemaProblems(plugin, mcp)));
  const pkg = zip([
    { path: 'plugin.json', data: JSON.stringify(plugin, null, 2) + '\n' },
    { path: 'mcp.json', data: JSON.stringify(mcp, null, 2) + '\n' },
    ...assets,
    ...skills.files,
  ]);
  if (pkg.length > 100 * 1024 * 1024) problems.push(`the ZIP is ${(pkg.length / 1048576).toFixed(0)} MB; the limit is 100 MB`);
  const zipName = `${m.name}-${m.version ?? '1.0.0'}.zip`;

  const notes = appealNotes(m, listed.tools);

  const steps = `# ChatGPT submission: ${m.title} ${m.version ?? ''}

## 1. Upload the package
platform.openai.com/plugins → **Upload new or existing plugin** → choose your verified developer identity → upload \`${zipName}\`.
It fills the listing, icons, test cases, demo video, release notes and translations${skills.names.length ? `, and adds ${skills.names.length === 1 ? 'the skill' : `${skills.names.length} skills:`} ${skills.names.join(', ')}` : ''}. To change any of them later, edit mcplane.json, bump "version" and run \`mcplane pack chatgpt\` again.${skills.names.length ? '\nSkills are scanned too, which can take up to 2 hours. If one is flagged, take it out of chatgpt.skills and upload again; skills can come back in a later version.' : ''}

## 2. Resolve findings
Open **Metadata & Skills** and **MCPs**, wait for the checks, fix anything listed (Copy issues is handy), and upload again if the package changes.
Domain verification: serve the token it gives you as plain text at ${new URL(m.server.url).origin}/.well-known/openai-apps-challenge, and keep it there.

## 3. What only you can enter
- **Review details:** reviewer credentials${m.server.auth === 'oauth' ? ` (${m.reviewerAccess ?? 'an email-and-password account with no 2FA, SMS or email confirmation, seeded for every test case'})` : ' (none needed: no sign-in)'}. Credentials never go in the ZIP.
- **Submit for review** and the policy attestations.

Hints need no justification: OpenAI's automated review checks readOnlyHint, destructiveHint and openWorldHint against what each tool does. If it flags one you believe is right, appeal with an explanation.${notes ? `\n\n## Appeal notes (optional)\nYour "justifications" in mcplane.json, for an appeal if review flags a hint:\n\n${notes}` : ''}

## Traps
- One review can be active per plugin. To replace a package in review, cancel the review first.
- "Submit for review" can show nothing for a while; confirm the status on the Plugins page.
- Tool changes don't need a new package: OpenAI's scans pick them up. Listing changes do.
- The package takes icons up to 5 MiB, but developer mode's own icon upload (when you add the server by hand to record the demo) takes 10 KB at most.

When it's in: \`mcplane submitted chatgpt --version ${m.version ?? '1.0.0'} --app-id <asdk_app_… from the URL>\`
`;
  return {
    files: [
      { path: `chatgpt/${zipName}`, content: pkg },
      { path: 'chatgpt/plugin.json', content: JSON.stringify(plugin, null, 2) + '\n' },
      { path: 'chatgpt/chatgpt.md', content: steps },
    ],
    problems,
    todo,
  };
}

function readWrite(tools: Tool[]): string {
  const writes = tools.filter((t) => t.annotations?.readOnlyHint === false);
  if (!writes.length) return 'Read only';
  return writes.length === tools.length ? 'Write only (check: most servers also read)' : 'Read and write';
}

export async function claudePack(m: Manifest, opts: PackOptions = {}): Promise<Pack> {
  m = forStore(m, 'claude-connectors');
  const listed = await toolsFor(m, opts);
  const tools = listed.tools ?? [];
  const problems: string[] = [];
  const todo = listed.tools ? [] : [withoutTools(listed.why, 'the tool list and the read/write answer')];
  if ((m.oneLiner ?? '').length > 200) problems.push(`oneLiner is ${m.oneLiner!.length} characters; the limit is 200`);
  if ((m.description ?? '').length > 2000) problems.push(`description is ${m.description!.length} characters; the limit is 2000`);
  if (!m.icon) problems.push('icon is missing; Claude asks for a direct .png/.svg URL when your favicon fails');
  const pos = m.tests?.positive ?? [];
  const useCases = (pos.length ? pos.slice(0, 4).map((p) => `${p.scenario}: "${p.prompt}"`) : (m.prompts ?? []).map((p) => `"${p}"`)).join('\n');
  const tests = pos.length
    ? pos.map((p, i) => `${i + 1}. "${p.prompt}" (${p.tools.join(', ')}): ${p.expected}`).join('\n')
    : 'MISSING: add tests.positive to mcplane.json';
  const md = `# Claude directory submission: ${m.title}

Submit at claude.ai/directory/manage/new (any paid Claude plan). Ten steps; the draft autosaves.

## 1. Connection
- Server URL: ${m.server.url}
- Authentication: ${m.server.auth === 'oauth' ? 'OAuth 2.0 + Dynamic Client Registration (Anthropic says DCR works best)' : 'No authentication (authless)'}

## 2. Tools
Every tool needs a title and explicit hints. Current tools: ${listed.tools ? tools.map((t) => t.name).join(', ') : 'unknown (pass --token or --tools)'}.

## 3. Listing
- Name: ${m.title}
- Slug: ${m.name} (permanent after submission)
- One-liner (${(m.oneLiner ?? '').length}/200): ${m.oneLiner ?? 'MISSING'}
- Description (${(m.description ?? '').length}/2000):

${m.description ?? 'MISSING'}

- Author: ${m.author?.name ?? 'MISSING'}, ${m.author?.url ?? ''}
- Icon: add a custom icon URL: ${m.icon ?? 'MISSING'} (the favicon fallback often fails)
- Documentation: ${m.links?.docs ?? 'MISSING'}
- Support: ${m.links?.support ?? 'MISSING'}
- Privacy policy: ${m.links?.privacy ?? 'MISSING'}

## 4. Use cases (at least three, each with an example prompt)
${useCases || 'MISSING'}

- Connection requirements: ${m.server.auth === 'oauth' ? 'An account on your service; say which plan.' : 'None. No account, sign-in or API key.'}
- Read / write: ${listed.tools ? readWrite(tools) : 'unknown (pass --token or --tools)'}

## 6. Authentication
Match step 1. Partial auth is available if only some tools need sign-in.

## 7. Data handling
Answer API ownership, health data and sponsored content truthfully. Sponsored or promoted content is prohibited.

## 8. Test & launch
${m.server.auth === 'oauth' ? `Reviewer access: ${m.reviewerAccess ?? 'MISSING: a demo account with every step, link and credential needed'}\n` : 'No account or credentials needed.\n'}${tests}

Tick "self-tested" only after running every tool.

## 9. Compliance
Seven statements you make yourself. One asks that tool descriptions contain no instructions about model behaviour: run \`mcplane preflight\` and explain any flagged line in Additional notes.

## After
"Passed review" is not the same as listed: check claude.ai/directory, and choose when to publish.
When it's in: \`mcplane submitted claude-connectors\`
`;
  return { files: [{ path: 'claude-connectors.md', content: md }], problems, todo };
}

const CONNECT_SUBMIT = 'https://vercel.com/d?to=%2F%5Bteam%5D%2F~%2Fconnect%2Fsubmit-service&title=Submit+a+Service';

/**
 * Vercel Connect: every value for Submit a Service, the OAuth method as Connect will discover it,
 * and the token test each OAuth method needs before the form lets you submit.
 * https://vercel.com/docs/connect/providers#submit-your-service-to-vercel-connect
 */
export async function vercelConnectPack(m: Manifest): Promise<Pack> {
  m = forStore(m, 'vercel-connect');
  const v = m.vercelConnect ?? {};
  const oauth = m.server.auth === 'oauth';
  const d = oauth ? await discover(m.server.url).catch(() => null) : null;
  const md = metadata(d) ?? {};
  // Required-tier failures block; so does having no connection method at all.
  const problems = vercelChecks(m, d)
    .filter((c) => c.level === 'fail' || (c.id === 'vercel.method' && c.level !== 'pass'))
    .map((c) => `${c.title}: ${c.detail ?? ''}`.replace(/: $/, ''));
  const description = m.description ?? m.oneLiner;
  if (!description) problems.push('description (or oneLiner) is missing; Service Information describes your service');
  const todo: string[] = [];
  if (m.icon && !/\.svg(\?|$)/i.test(m.icon)) todo.push(`Vercel takes an optional SVG icon and yours is ${m.icon.split('/').pop()}: export an SVG to upload.`);
  const cc = clientCreation(md);
  const auto = cc.dcr || cc.cimd;
  const grants: string[] = Array.isArray(md.grant_types_supported) ? md.grant_types_supported : [];
  const declared: string[] = Array.isArray(md.scopes_supported) ? md.scopes_supported : [];
  const scopes = v.scopes ?? declared;
  if (oauth && auto && v.scopes && v.scopes.join(' ') !== declared.join(' '))
    todo.push('Your default scopes differ from scopes_supported. Vercel treats that as an OAuth override and tests it with Automatic Registration off, using a client ID from your service.');
  const host = new URL(m.server.url).host;
  const found = d ? [d.prm && `protected-resource metadata at ${d.prm.url}`, `issuer ${d.issuer}`, (d.oauth ?? d.oidc)?.url].filter(Boolean).join(' → ') : '';

  const oauthMethod = oauth
    ? `### OAuth
- Server URL: ${m.server.url} (discovery runs when you enter it)
- What Connect finds: ${found || 'nothing (see the problems mcplane printed)'}
- Endpoints: authorization ${md.authorization_endpoint ?? 'MISSING'}, token ${md.token_endpoint ?? 'MISSING'}${md.registration_endpoint ? `, registration ${md.registration_endpoint}` : ''}${md.revocation_endpoint ? `, revocation ${md.revocation_endpoint}` : ''}
- Automatic Registration: ${auto ? `on, through ${[cc.dcr && 'Dynamic Client Registration', cc.cimd && 'Client ID Metadata Documents'].filter(Boolean).join(' or ')}` : `not offered. Register an application with your service using the redirect URL ${CONNECT_CALLBACK}, then enter its client ID (and secret, if you issue one); the draft doesn't keep them`}
- Client authentication: ${cc.usable.join(', ') || cc.methods?.join(', ') || 'not declared'}
- Grants: ${grants.map((g) => (SUBJECTS[g] ? `${g} (${SUBJECTS[g]} tokens)` : g === 'refresh_token' ? 'refresh_token (renewal)' : g)).join(', ') || 'MISSING'}
- Default scopes: ${scopes.length ? scopes.join(' ') : 'none declared'}${v.scopes ? ' (from mcplane.json)' : ''}
- Redirect URL to allow: ${CONNECT_CALLBACK} (an exact match; no wildcard needed)
`
    : '';
  const keyMethod = v.apiKey
    ? `### API key
- Where users create a key: ${v.apiKey.docs ?? 'MISSING: set vercelConnect.apiKey.docs'}
- Sent as: ${v.apiKey.header ?? 'Authorization: Bearer <key>'}
- No token test: Vercel validates the configuration only.
`
    : '';

  const sheet = `# Vercel Connect submission: ${m.title}

Submit a Service: ${CONNECT_SUBMIT}
(Vercel dashboard → Connect → Browse Connectors → Submit a Service. You need permission to create connectors in the team. The draft is kept in your browser, for your account and team only.)

## 1. Service
- Service Name: ${m.title}
- Icon: optional, an SVG upload${m.icon ? ` (yours: ${m.icon})` : ''}
- Service Information:
  - Description: ${description ?? 'MISSING'}
  - Website: ${m.links?.website ?? 'MISSING'}
  - Documentation: ${m.links?.docs ?? 'none'}
  - Support: ${m.links?.support ?? 'none'}
  - Privacy policy: ${m.links?.privacy ?? 'MISSING'}
  - Terms: ${m.links?.terms ?? 'none'}
  - Contact Email: yours. Vercel writes to it if it needs more details (not kept in mcplane.json)

Field names follow Vercel's docs; the form may word them differently.

## 2. Targets (optional)
- MCP server: ${m.server.url}
- REST API: ${v.apiBase ?? 'none in mcplane.json (vercelConnect.apiBase adds one)'}

## 3. Connection methods
${[oauthMethod, keyMethod].filter(Boolean).join('\n') || 'MISSING: Vercel Connect needs OAuth or an API key. An authless server has nothing for it to connect.\n'}
## 4. Test each OAuth method
${
  oauth
    ? `Optional, from a terminal, to see what Connect discovers before you open the form:

    vercel connect create ${host}
    vercel connect token <connector uid>     # a user token; "vercel connect list" shows the uid

Then in the form, for each OAuth method:
1. Preview & Test.
2. Set Up Test Connector${auto ? ', with Automatic Registration on (the toggle only appears because your metadata advertises DCR or CIMD)' : ''}.
3. Create Test Connector. It appears under Test Connectors, selected for submission.
4. Test User Token${grants.includes('client_credentials') ? ' (Test App Token for client credentials)' : ''}, with the method's default scopes selected, and sign in as a user in the popup.
5. Wait for "Token retrieved".
`
    : 'API key methods need no test: Vercel validates the configuration when you submit.\n'
}
## 5. Submit
Review Submission, then Submit for Review. The page shows Service Submitted, a submission ID and each method's status (${[oauth && 'OAuth: Token Verified', v.apiKey && 'API key: Configuration Valid'].filter(Boolean).join('; ') || 'one per connection method'}). Vercel reviews the submission before publishing it to the directory. Keep the test connector and its token in your team until then: Vercel re-checks the test on its servers.

To change it later: Edit and Resubmit.

## If the form refuses
| Message | What to do |
|---|---|
| Create a matching test connector and retrieve a token. | The selected connector has no token, or it tested an earlier configuration. Create a new test connector and test a token. |
| Test the default scopes configured for this connection method. | Test the token again with the default scopes selected. |
| Create a fresh connector with automatic registration, or disable automatic registration and test manual setup. | Create a new test connector with Automatic Registration on, or turn it off. |
| Obtain a new token for the current connector configuration and discovered metadata. | The connector or your discovery documents changed after the test. Create a new test connector and test a token. |
| These OAuth overrides require manual setup. Turn off Auto Registration to test this configuration. | The method customises scopes or other OAuth settings. Turn off Automatic Registration and enter a client ID from your service. |

## Traps
- A token test only counts for the exact configuration it tested. Change a URL, an OAuth setting, a template field or Automatic Registration, or edit your discovery documents, and you need a new test connector and token.
- Return expires_in in token responses. Without it Connect guesses the lifetime and your API sees expired tokens.
- If you rotate refresh tokens, return the new one in every refresh response, or users re-authorise more often than they should.
- Return registration_access_token and registration_client_uri from registration (RFC 7592), so Connect can keep a DCR client in step when a user renames a connector or changes its icon.
- Reset Draft clears the browser draft but leaves test connectors in your team.

When it's in: \`mcplane submitted vercel-connect\`
`;
  return { files: [{ path: 'vercel-connect.md', content: sheet }], problems, todo };
}

/** ARD: one manifest for /.well-known/ard.json that Lighthouse 13.5 also accepts at ai-catalog.json. */
export async function ardPack(m: Manifest, opts: PackOptions = {}): Promise<Pack> {
  const tools = (await toolsFor(m, opts)).tools ?? [];
  const card = `${new URL(m.server.url).origin}/.well-known/mcp/server-card.json`;
  const res = await fetch(card, { headers: { accept: 'application/json', 'user-agent': 'mcplane' }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  const hasCard = !!res?.ok && /json/i.test(res.headers.get('content-type') ?? '') && !!(await res.json().catch(() => null));
  const doc = ardManifest(m, { tools: tools.map((t) => t.name), serverCard: hasCard ? card : undefined });
  const v = validateArd(doc);
  const site = new URL(m.links?.website ?? m.server.url).origin;
  const todo = v.warnings.map((w) => `${w} (2 to 5 representative queries make it findable by search; add prompts or tests to mcplane.json)`);
  if (!hasCard) todo.push(`No server card at ${card}, so the entry points at the MCP endpoint itself. MCP Server Cards (SEP-2127) are still a draft; run this again once you serve one.`);
  if (!tools.length) todo.push('capabilities came from your test cases: tools/list needs sign-in (pass --token, or --tools <file>).');
  const md = `# ARD manifest: ${m.title}

Serve ard.json, as application/json, at:
- ${site}/.well-known/ard.json (ARD v0.91: every consumer must read this one)
- ${site}/.well-known/ai-catalog.json (the predecessor path, which Lighthouse 13.5 still audits), or point to ard.json from robots.txt:

    Agentmap: ${site}/.well-known/ard.json

Lighthouse reads an Agentmap line before ai-catalog.json, so either works for it. In your pages, \`<link rel="ard" href="/.well-known/ard.json">\` is the v0.91 link.

ARD (Agentic Resource Discovery) is a proposal: v0.91, 26 August 2026, https://agenticresourcediscovery.org/spec/
The entry follows the v0.91 entry schema. specVersion "1.0" and host are there for Lighthouse's older ai-catalog schema; ARD ignores them.

Check what's live: \`mcplane preflight\` (the ard.* checks).
`;
  return {
    files: [
      { path: 'ard/ard.json', content: JSON.stringify(doc, null, 2) + '\n' },
      { path: 'ard/ard.md', content: md },
    ],
    problems: [...v.errors, ...v.lighthouse],
    todo,
  };
}

/** The plugin and MCP server names Claude Code builds tool names from: claudePlugin in mcplane.json, else the public plugin repo, else the manifest's name. */
async function evalPlugin(m: Manifest): Promise<EvalPlugin & { guessed: boolean }> {
  let plugin = m.claudePlugin?.name;
  let server = m.claudePlugin?.server;
  const gh = m.repository?.match(/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?$/);
  if ((!plugin || !server) && gh) {
    const raw = (p: string): Promise<any> =>
      fetch(`https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/HEAD/${p}`, { headers: { 'user-agent': 'mcplane' }, signal: AbortSignal.timeout(10_000) })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    const [manifest, mcp] = await Promise.all([raw('.claude-plugin/plugin.json'), raw('.mcp.json')]);
    const servers: Record<string, { url?: string }> = { ...(manifest?.mcpServers && typeof manifest.mcpServers === 'object' ? manifest.mcpServers : {}), ...(mcp?.mcpServers ?? {}) };
    const bare = (u?: string) => (u ?? '').replace(/\/+$/, '').toLowerCase();
    plugin ??= manifest?.name;
    server ??= Object.keys(servers).find((k) => bare(servers[k]?.url) === bare(m.server.url)) ?? Object.keys(servers)[0];
  }
  return { plugin: plugin ?? m.name, server: server ?? m.name, guessed: !plugin || !server };
}

/**
 * Claude Code plugin evals: mcplane.json's review tests as a "claude plugin eval" suite, with mocks
 * from your live tools/list, to copy into the plugin repo.
 * https://code.claude.com/docs/en/plugin-evals
 */
export async function claudeEvalPack(m: Manifest, opts: PackOptions = {}): Promise<Pack> {
  const [p, tools] = await Promise.all([evalPlugin(m), toolsFor(m, opts).then((r) => r.tools ?? [])]);
  const suite = evalSuite(m, p, tools);
  const pos = m.tests?.positive?.length ?? 0;
  const neg = m.tests?.negative?.length ?? 0;
  const pattern = toolId(p, '*');
  const todo: string[] = [];
  if (p.guessed) todo.push(`The plugin and server names are a guess ("${p.plugin}", "${p.server}"). If yours differ, set claudePlugin.name and claudePlugin.server in mcplane.json: tool graders match ${toolId(p, '<tool>')}.`);
  if (!tools.length) todo.push('tools/list needs sign-in, so the mocks have no real descriptions or schemas (pass --token, or --tools <file>).');
  todo.push(`Copy .mcplane/packs/claude-eval/evals/ into the plugin repo${m.repository ? ` (${m.repository})` : ''}, then run "claude plugin eval . --runs 1 --ablation none" for a cheap first pass.`);
  const readme = `# Plugin evals: ${m.title}

${pos} positive and ${neg} negative cases from mcplane.json's review tests, for "claude plugin eval". They test the plugin "${p.plugin}", whose MCP server is "${p.server}", so its tools are ${pattern}.

## Use it
1. Copy evals/ into the plugin repo, next to .claude-plugin/. Add evals/results/ to .gitignore.
2. A cheap first pass while you tune graders: \`claude plugin eval . --runs 1 --ablation none\`
3. The full suite, three runs a case, against a no-plugin baseline: \`claude plugin eval .\`

Every run and every llm grader is a model call on your account.

## What each case checks
- positive-*: an llm judge on the reply, against the expected result in your test. The calls-<tool> graders show whether the plugin's tools were called; they aren't scored, because they can't pass without the plugin and would inflate its delta.
- negative-*: none of the server's tools was called, scored with and without the plugin.

## Mocks
mocks/${p.server}/ answers every tool with a small model (type: agent)${tools.length ? ', using the descriptions and schemas in _tools.json, saved from your live tools/list' : ''}. Each positive case has its own mock for the tools it names, so the data fits the request. Nothing reaches your server and nothing is written.

To use the real server instead: \`claude plugin eval . --mocks off --allow-tools "${pattern}"\`. Only do that when every tool is read-only: write tools would really write.

## CI
\`\`\`yaml
# .github/workflows/plugin-eval.yml in the plugin repo
on: [pull_request]
jobs:
  eval:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm install -g @anthropic-ai/claude-code
      - run: claude plugin eval . --trust-plugin --json results.json --threshold 0.8 --model claude-sonnet-5 --judge-model claude-haiku-4-5 --no-publish --max-cost-usd 5
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
\`\`\`

Exit code 1 means a case scored under the threshold or a case file didn't load; 2 means the cost ceiling stopped the run.

Regenerate after changing the tests in mcplane.json: \`mcplane pack claude-eval\`.
`;
  return { files: [...suite.files.map((f) => ({ path: `claude-eval/${f.path}`, content: f.content })), { path: 'claude-eval/README.md', content: readme }], problems: suite.problems, todo };
}

/** Every pack by name: a store with a form, or one of the extras. */
export const PACKS = ['chatgpt', 'claude-connectors', 'vercel-connect', 'cursor', 'muse', 'directories', 'ard', 'claude-eval'] as const;

export async function packFor(m: Manifest, name: string, opts: PackOptions = {}): Promise<Pack> {
  if (name === 'directories') return directoriesPack(m);
  if (name === 'ard') return ardPack(m, opts);
  if (name === 'claude-eval') return claudeEvalPack(m, opts);
  if (name === 'chatgpt') return chatgptPack(m, opts);
  if (name === 'claude-connectors') return claudePack(m, opts);
  if (name === 'vercel-connect') return vercelConnectPack(m);
  return simplePack(m, name as StoreId);
}

export async function simplePack(m: Manifest, store: StoreId): Promise<Pack> {
  m = forStore(m, store);
  const problems: string[] = [];
  let md = '';
  if (store === 'cursor') {
    if (!m.repository) problems.push('repository is missing; Cursor reads plugins from a public GitHub repo');
    md = `# Cursor Marketplace: ${m.title}\n\nSubmit at cursor.com/marketplace/publish.\n\n- Repository: ${m.repository ?? 'MISSING'} (public, with a Cursor plugin manifest)\n- Name: ${m.title}\n- Description: ${m.oneLiner ?? m.description ?? 'MISSING'}\n- Website: ${m.links?.website ?? ''}\n\nEvery plugin is reviewed by hand. When it's in: \`mcplane submitted cursor\`. Review Times closes the report itself when your plugin appears in the marketplace.\n`;
  } else if (store === 'muse') {
    md = `# Muse connectors: ${m.title}\n\nSubmit at muse.ai/platform, choosing "Existing MCP".\n\n- MCP server URL: ${m.server.url}\n- Auth: ${m.server.auth === 'oauth' ? 'OAuth (PKCE)' : 'None'}\n- Name: ${m.title}\n- Description: ${m.oneLiner ?? m.description ?? 'MISSING'}\n- Privacy: ${m.links?.privacy ?? 'MISSING'}\n\nMeta onboards in waves and gives no status yet. When it's in: \`mcplane submitted muse\`.\n`;
  } else {
    throw new Error(`No pack for ${store} yet. Packs: ${PACKS.join(', ')}.`);
  }
  return { files: [{ path: `${store}.md`, content: md }], problems, todo: [] };
}

/** The long tail: directories that only take a web form. One sheet with every value to paste. */
export function directoriesPack(m: Manifest): Pack {
  const repo = m.repository?.replace(/\.git$/, '');
  const desc = m.oneLiner ?? m.description ?? m.title;
  const rows: [string, string, string][] = [
    ['MCP.Directory', 'https://mcp.directory/submit', 'Says it auto-discovers from the official registry; its form wants a GitHub repo first, so hosted servers without public code can stall.'],
    ['mcp.so', 'https://mcp.so/submit', 'Repo URL and name. Edits can return HTTP 200 with a hidden validation error (a tagline that is too long): check the public page after saving.'],
    ['MCP Market', 'https://mcpmarket.com/submit', 'GitHub URL, email, type. The free queue runs to weeks; paid lists within a day. Check where its Try Now button sends people.'],
    ['mcpservers.org', 'https://mcpservers.org/submit', 'Has a field for your Official MCP Registry name. Free takes about two weeks.'],
    ['cursor.directory', 'https://cursor.directory', 'Submit from its MCP section.'],
  ];
  const md = `# Directory forms: ${m.title}

Publish to the official MCP Registry first ("mcplane publish mcp-registry"): GitHub's registry, VS Code, PulseMCP and MCP.Directory read from it, so most of these become optional.

Values to paste:
- Name: ${m.title}
- Description: ${desc}
- Server URL: ${m.server.url}
- Repository: ${repo ?? 'none'}
- Website: ${m.links?.website ?? ''}
- Icon: ${m.icon ?? ''}
- Registry name: ${m.registry?.name ?? '(see "mcplane publish mcp-registry")'}

| Directory | Where | Notes |
|---|---|---|
${rows.map((r) => `| ${r[0]} | ${r[1]} | ${r[2]} |`).join('\n')}

After any form: a save that returned 200 is a claim. Open the public page and check the endpoint, auth and every link.

Directories send little traffic on their own; the registry, the big stores and your own docs matter more. Do these once, and don't pay to skip a queue unless a launch date depends on it.
`;
  return { files: [{ path: 'directories.md', content: md }], problems: [], todo: [] };
}

export async function writePack(pack: Pack, dir = process.cwd()): Promise<string[]> {
  await ensureLocalDir(dir);
  const out = resolve(dir, '.mcplane/packs');
  await mkdir(out, { recursive: true });
  const written: string[] = [];
  for (const f of pack.files) {
    await mkdir(dirname(resolve(out, f.path)), { recursive: true });
    await writeFile(resolve(out, f.path), f.content);
    written.push(`.mcplane/packs/${f.path}`);
  }
  return written;
}

export const _test = { appealNotes, contrast, category, toolsFor };
