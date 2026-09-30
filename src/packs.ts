/**
 * Submission packs: everything a store asks for, checked against its limits.
 * ChatGPT gets the plugin ZIP its portal uploads; the rest get a markdown pack
 * to paste from.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ensureLocalDir } from './manifest.js';
import { forStore } from './draft.js';
import { McpClient } from './mcp-client.js';
import { zip } from './zip.js';
import type { Manifest, StoreId, Tool } from './types.js';

const MAX_JUSTIFICATION = 200; // the ChatGPT form cuts longer ones without warning

export interface Pack {
  files: { path: string; content: string | Uint8Array }[];
  problems: string[];
  todo: string[];
}

async function listTools(m: Manifest, token?: string): Promise<Tool[]> {
  const c = new McpClient(m.server.url, token ? { authorization: `Bearer ${token}` } : {});
  const init = await c.initialize();
  if (init.status >= 400) throw new Error(`Couldn't read tools from ${m.server.url} (HTTP ${init.status})${m.server.auth === 'oauth' ? '; pass --token' : ''}.`);
  const r = await c.request('tools/list');
  return (r.body?.result?.tools ?? []) as Tool[];
}

const firstSentence = (s = '') => (s.match(/^[^.!?]+[.!?]/)?.[0] ?? s).trim();

const VERBS = /^(add|create|get|fetch|list|search|find|update|edit|delete|remove|send|post|publish|mark|set|run|check|look|read|write|upload|download|report|record|submit|start|stop|cancel|return|generate|compare|show|save|share|move|copy|open|close|resolve|restore)\b/i;
/** "Add the user's…" → "adds the user's…"; leaves non-verb openings alone. */
function thirdPerson(s: string): string | null {
  const m = s.match(VERBS);
  if (!m) return null;
  const w = m[1].toLowerCase();
  const conj = /(s|sh|ch|x|z)$/.test(w) ? `${w}es` : /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`;
  return conj + s.slice(m[1].length);
}
const possessive = (name: string) => (name.endsWith('s') ? `${name}'` : `${name}'s`);
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…`);
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** One-sentence drafts from the declared hints and the tool's own description. Review them: they are a start, not an answer. */
function justify(t: Tool, product: string, own?: { readOnly?: string; openWorld?: string; destructive?: string }) {
  const a = t.annotations ?? {};
  const sentence = firstSentence(t.description).replace(/\.$/, '');
  const verb = thirdPerson(sentence);
  const what = verb ? `it ${verb}` : `the tool: ${lower(sentence)}`;
  return {
    read_only_justification: clip(own?.readOnly ?? (a.readOnlyHint ? 'Only looks up and returns data; it does not create, change or delete anything.' : `Writes data: ${what}.`), MAX_JUSTIFICATION),
    open_world_justification: clip(
      own?.openWorld ?? (a.openWorldHint ? `Can change public or third-party state: ${what}.` : `Works only within ${possessive(product)} own service; it does not post, publish or send anything elsewhere.`),
      MAX_JUSTIFICATION,
    ),
    destructive_justification: clip(
      own?.destructive ??
      (a.destructiveHint ? `Can delete or overwrite data: it ${what}.` : a.readOnlyHint ? 'Read-only, so it cannot delete or overwrite anything.' : 'Only adds or updates the user’s own data; it never deletes or overwrites existing records.'),
      MAX_JUSTIFICATION,
    ),
  };
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

/** Downloads an icon and checks it against the package rules: square, 48 to 4096 px, 5 MiB, PNG/JPEG/WebP/SVG. */
async function fetchIcon(url: string, label: string, problems: string[]): Promise<{ data: Uint8Array; ext: string } | null> {
  const res = await fetch(url, { headers: { 'user-agent': 'mcplane' } }).catch(() => null);
  if (!res?.ok) {
    problems.push(`${label} ${url} didn't load (HTTP ${res?.status ?? 'error'})`);
    return null;
  }
  const type = res.headers.get('content-type') ?? '';
  const data = new Uint8Array(await res.arrayBuffer());
  const ext = type.includes('svg') || url.endsWith('.svg') ? 'svg' : type.includes('jpeg') || /\.jpe?g$/.test(url) ? 'jpg' : type.includes('webp') || url.endsWith('.webp') ? 'webp' : 'png';
  if (data.length > 5 * 1024 * 1024) problems.push(`${label} is ${(data.length / 1048576).toFixed(1)} MiB; the limit is 5 MiB`);
  if (ext === 'png' && data[0] === 0x89) {
    const v = new DataView(data.buffer, data.byteOffset);
    const [w, h] = [v.getUint32(16), v.getUint32(20)];
    if (w !== h) problems.push(`${label} is ${w}×${h}; it must be square`);
    else if (w < 48 || w > 4096) problems.push(`${label} is ${w} px; it must be 48 to 4096 px`);
  }
  return { data, ext };
}

/**
 * ChatGPT: the plugin ZIP the portal takes since DevDay (27 Sep 2026). plugin.json in the
 * Agent Plugins format carries the listing, the 5+3 test cases, demo video, release notes
 * and translations; mcp.json points at the server; icons are bundled. Reviewer credentials,
 * hint justifications and the policy attestations stay in the dashboard.
 */
export async function chatgptPack(m: Manifest, token?: string): Promise<Pack> {
  m = forStore(m, 'chatgpt');
  const g = m.chatgpt ?? {};
  const tools = await listTools(m, token);
  const problems: string[] = [];
  const todo: string[] = [];
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
  need(g.demoVideo, 'chatgpt.demoVideo is missing: a reviewer-accessible video URL showing the main use cases (required for review)');
  need(g.releaseNotes, 'chatgpt.releaseNotes is missing (required for review)');

  const missingHints = tools.filter((t) => ['readOnlyHint', 'openWorldHint', 'destructiveHint'].some((h) => typeof (t.annotations as any)?.[h] !== 'boolean'));
  for (const t of missingHints) problems.push(`${t.name} doesn't set all three hints; ChatGPT treats that as a blocker`);
  for (const [name, j] of Object.entries(m.justifications ?? {})) for (const [k, v] of Object.entries(j)) if (v && v.length > MAX_JUSTIFICATION) problems.push(`justifications.${name}.${k} is ${v.length} characters; ChatGPT cuts at ${MAX_JUSTIFICATION}`);

  const pos = m.tests?.positive ?? [];
  const neg = m.tests?.negative ?? [];
  const names = new Set(tools.map((t) => t.name));
  if (pos.length !== 5) problems.push(`tests.positive has ${pos.length}; ChatGPT needs exactly 5`);
  if (neg.length !== 3) problems.push(`tests.negative has ${neg.length}; ChatGPT needs exactly 3`);
  for (const p of pos) for (const n of p.tools) if (!names.has(n)) problems.push(`test "${p.scenario}" names a tool the server doesn't have: ${n}`);
  const covered = new Set(pos.flatMap((p) => p.tools));
  for (const t of tools) if (!covered.has(t.name)) todo.push(`No positive test uses ${t.name}. Reviewers check every tool.`);

  // Icons, bundled into the package.
  const assets: { path: string; data: Uint8Array }[] = [];
  const icon = async (url: string | undefined, file: string, label: string) => {
    if (!url) return undefined;
    const got = await fetchIcon(url, label, problems);
    if (!got) return undefined;
    const path = `assets/${file}.${got.ext}`;
    assets.push({ path, data: got.data });
    return `./${path}`;
  };
  need(m.icon, 'icon is missing: a direct URL to a square image, 48 to 4096 px');
  const logo = await icon(m.icon, 'logo', 'icon');
  const composerIcon = (await icon(g.composerIcon, 'composer-icon', 'chatgpt.composerIcon')) ?? logo;
  const logoDark = await icon(g.logoDark, 'logo-dark', 'chatgpt.logoDark');

  const plugin = {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: m.name,
    version: m.version ?? '1.0.0',
    description: m.oneLiner ?? m.subtitle ?? m.title,
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
  const mcp = { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { [m.name]: { type: 'streamable-http', url: m.server.url } } };
  const pkg = zip([
    { path: 'plugin.json', data: JSON.stringify(plugin, null, 2) + '\n' },
    { path: 'mcp.json', data: JSON.stringify(mcp, null, 2) + '\n' },
    ...assets,
  ]);
  const zipName = `${m.name}-${m.version ?? '1.0.0'}.zip`;

  // Justifications still go in the dashboard, one per hint, per tool.
  const justified = tools
    .map((t) => {
      const j = justify(t, m.title, m.justifications?.[t.name]);
      const a = t.annotations ?? {};
      return `### ${t.name}\n- readOnlyHint ${!!a.readOnlyHint}: ${j.read_only_justification}\n- openWorldHint ${!!a.openWorldHint}: ${j.open_world_justification}\n- destructiveHint ${!!a.destructiveHint}: ${j.destructive_justification}`;
    })
    .join('\n\n');
  const drafted = tools.filter((t) => !m.justifications?.[t.name]).map((t) => t.name);
  if (drafted.length) todo.push(`Read the drafted justifications for ${drafted.join(', ')} in chatgpt.md. Once they say exactly what each tool changes, save them under "justifications" in mcplane.json.`);

  const steps = `# ChatGPT submission: ${m.title} ${m.version ?? ''}

## 1. Upload the package
platform.openai.com/plugins → **Upload new or existing plugin** → choose your verified developer identity → upload \`${zipName}\`.
It fills the listing, icons, test cases, demo video, release notes and translations. To change any of them later, edit mcplane.json, bump "version" and run \`mcplane pack chatgpt\` again.

## 2. Resolve findings
Open **Metadata & Skills** and **MCPs**, wait for the checks, fix anything listed (Copy issues is handy), and upload again if the package changes.
Domain verification: serve the token it gives you as plain text at ${new URL(m.server.url).origin}/.well-known/openai-apps-challenge, and keep it there.

## 3. What only you can enter
- **Review details:** reviewer credentials${m.server.auth === 'oauth' ? ` (${m.reviewerAccess ?? 'an email-and-password account with no 2FA, SMS or email confirmation, seeded for every test case'})` : ' (none needed: no sign-in)'}. Credentials never go in the ZIP.
- **Hint justifications**, one per value on every tool (200 characters each, cut without warning):

${justified}

- **Submit for review** and the policy attestations.

## Traps
- One review can be active per plugin. To replace a package in review, cancel the review first.
- "Submit for review" can show nothing for a while; confirm the status on the Plugins page.
- Tool changes don't need a new package: OpenAI's scans pick them up. Listing changes do.

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

export async function claudePack(m: Manifest, token?: string): Promise<Pack> {
  m = forStore(m, 'claude-connectors');
  const tools = await listTools(m, token);
  const problems: string[] = [];
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
Every tool needs a title and explicit hints. Current tools: ${tools.map((t) => t.name).join(', ')}.

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
- Read / write: ${readWrite(tools)}

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
  return { files: [{ path: 'claude-connectors.md', content: md }], problems, todo: [] };
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
    throw new Error(`No pack for ${store} yet. Packs: chatgpt, claude-connectors, cursor, muse.`);
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

export const _test = { thirdPerson, justify, contrast, category };
