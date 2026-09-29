/**
 * Submission packs: everything a store's form asks for, in its order, checked
 * against its limits. ChatGPT gets the chatgpt-app-submission.json its portal
 * imports (the format OpenAI's own chatgpt-app-submission skill writes); the
 * rest get a markdown pack to paste from.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ensureLocalDir } from './manifest.js';
import { McpClient } from './mcp-client.js';
import type { Manifest, StoreId, Tool } from './types.js';

const CATEGORIES = ['BUSINESS', 'COLLABORATION', 'DESIGN', 'DEVELOPER_TOOLS', 'EDUCATION', 'ENTERTAINMENT', 'FINANCE', 'FOOD', 'LIFESTYLE', 'NEWS', 'PRODUCTIVITY', 'SHOPPING', 'TRAVEL'];
const MAX_JUSTIFICATION = 200; // the ChatGPT form cuts longer ones without warning

export interface Pack {
  files: { path: string; content: string }[];
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

export async function chatgptPack(m: Manifest, token?: string): Promise<Pack> {
  const tools = await listTools(m, token);
  const problems: string[] = [];
  const todo: string[] = [];
  const category = (m.category ?? '').toUpperCase().replace(/[^A-Z]+/g, '_');
  if (!CATEGORIES.includes(category)) problems.push(`category "${m.category ?? ''}" isn't one of ChatGPT's: ${CATEGORIES.join(', ')}`);
  if ((m.subtitle ?? '').length > 30) problems.push(`subtitle is ${m.subtitle!.length} characters; the limit is 30`);
  if (!m.subtitle) problems.push('subtitle is missing (30 characters, a plain functional phrase)');

  const missingHints = tools.filter((t) => ['readOnlyHint', 'openWorldHint', 'destructiveHint'].some((h) => typeof (t.annotations as any)?.[h] !== 'boolean'));
  for (const t of missingHints) problems.push(`${t.name} doesn't set all three hints; ChatGPT treats that as a blocker`);

  const toolsOut = Object.fromEntries(
    tools.map((t) => [
      t.name,
      {
        annotations: {
          readOnlyHint: !!t.annotations?.readOnlyHint,
          openWorldHint: !!t.annotations?.openWorldHint,
          destructiveHint: !!t.annotations?.destructiveHint,
        },
        justifications: justify(t, m.title, m.justifications?.[t.name]),
      },
    ]),
  );
  const drafted = tools.filter((t) => !m.justifications?.[t.name]).map((t) => t.name);
  if (drafted.length) todo.push(`Read the drafted justifications for ${drafted.join(', ')}: they come from your hints and tool descriptions. Once they say exactly what each tool changes, save them under "justifications" in mcplane.json so every version reuses them.`);
  for (const [name, j] of Object.entries(m.justifications ?? {})) for (const [k, v] of Object.entries(j)) if (v && v.length > MAX_JUSTIFICATION) problems.push(`justifications.${name}.${k} is ${v.length} characters; ChatGPT cuts at ${MAX_JUSTIFICATION}`);

  const pos = m.tests?.positive ?? [];
  const neg = m.tests?.negative ?? [];
  const names = new Set(tools.map((t) => t.name));
  if (pos.length !== 5) problems.push(`tests.positive has ${pos.length}; ChatGPT needs exactly 5`);
  if (neg.length !== 3) problems.push(`tests.negative has ${neg.length}; ChatGPT needs exactly 3`);
  for (const p of pos) for (const n of p.tools) if (!names.has(n)) problems.push(`test "${p.scenario}" names a tool the server doesn't have: ${n}`);
  const covered = new Set(pos.flatMap((p) => p.tools));
  for (const t of tools) if (!covered.has(t.name)) todo.push(`No positive test uses ${t.name}. Reviewers check every tool.`);

  const json = {
    $schema: 'https://developers.openai.com/apps-sdk/schemas/chatgpt-app-submission.v1.json',
    schema_version: 1,
    app_info: { display_name: m.title, subtitle: m.subtitle ?? '', description: m.description ?? '', category: CATEGORIES.includes(category) ? category : 'PRODUCTIVITY' },
    tools: toolsOut,
    ...(pos.length
      ? {
          test_cases: pos.map((p) => ({ description: p.scenario, user_prompt: p.prompt, file_attachment_urls: null, tools_triggered: p.tools.join(', '), expected_output: p.expected, expected_output_url: null })),
        }
      : {}),
    ...(neg.length
      ? {
          negative_test_cases: neg.map((n) => ({ description: n.scenario, user_prompt: n.prompt, file_attachment_urls: null, tools_triggered: null, expected_output: `${m.title} should not be invoked.`, expected_output_url: null })),
        }
      : {}),
  };

  const steps = `# ChatGPT submission: ${m.title}

Upload \`chatgpt-app-submission.json\` on the Info step ("Use Codex to fill this form"): it fills app info, tool justifications and tests.

## Before you start
- A verified organisation on platform.openai.com (Settings, Organization). Start early; it can lag.
- Domain challenge: the MCP step gives you a token to serve as plain text at ${new URL(m.server.url).origin}/.well-known/openai-apps-challenge.
- A demo video recorded in ChatGPT developer mode showing the tools your tests use, hosted as an .mp4 URL.
- Icons: a directory icon (square PNG, 256 px or more) and a composer icon (48 px or more; the developer-mode dialog caps uploads at 10 KB).

## Fields the JSON doesn't cover
- Developer identity and Plugin Author: must match your verified legal or business name.
- Website: ${m.links?.website ?? 'MISSING'}
- Customer support URL (a URL, not an email): ${m.links?.support ?? 'MISSING'}
- Privacy policy: ${m.links?.privacy ?? 'MISSING'}
- Terms: ${m.links?.terms ?? 'MISSING'}
- MCP server URL: ${m.server.url} (${m.server.auth === 'oauth' ? 'OAuth' : 'No Auth'})${m.server.auth === 'oauth' ? `\n- Test credentials: ${m.reviewerAccess ?? 'MISSING: an email-and-password demo account with no 2FA, seeded for every test case'}` : ''}
- Prompts (up to 3): ${(m.prompts ?? []).slice(0, 3).map((p) => `"${p}"`).join(', ') || 'none set'}

## Traps
- Run "Scan Tools" twice if the first click shows nothing.
- Justifications over 200 characters are cut without warning.
- Typing into fields while the draft autosaves can drop characters; re-read before submitting.
- "Submit for Review" shows nothing for about 20 seconds. Confirm on the plugins list that the version reads "Review".
- One version can be in review at a time. Changing tools on a published plugin needs a new version.

When it's in: \`mcplane submitted chatgpt --app-id <asdk_app_… from the URL>\`
`;
  return {
    files: [
      { path: 'chatgpt-app-submission.json', content: JSON.stringify(json, null, 2) + '\n' },
      { path: 'chatgpt.md', content: steps },
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

export async function writePack(pack: Pack, dir = process.cwd()): Promise<string[]> {
  await ensureLocalDir(dir);
  const out = resolve(dir, '.mcplane/packs');
  await mkdir(out, { recursive: true });
  const written: string[] = [];
  for (const f of pack.files) {
    await writeFile(resolve(out, f.path), f.content);
    written.push(`.mcplane/packs/${f.path}`);
  }
  return written;
}

export const _test = { thirdPerson, justify };
