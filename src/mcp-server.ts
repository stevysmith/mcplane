/**
 * `mcplane mcp`: the same commands as MCP tools over stdio, so Claude Code,
 * Codex or Cursor can check, prepare and track submissions from inside the
 * repo. Every tool takes an optional project folder (default: where the
 * server was started), and fleet covers every project under a folder at once.
 */
import { access, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { drift } from './drift.js';
import { fleet } from './fleet.js';
import { pull, tryLinks } from './extras.js';
import { MANIFEST_FILE, draftManifest, loadManifest, storesOf } from './manifest.js';
import { chatgptPack, claudePack, simplePack, writePack } from './packs.js';
import { preflight } from './preflight.js';
import { publish } from './publish.js';
import { recordDecision, recordSubmitted, status } from './submissions.js';
import { STORE_NAMES, type StoreId } from './types.js';
import { VERSION } from './version.js';

const STORE = z.enum(Object.keys(STORE_NAMES) as [StoreId, ...StoreId[]]);
const reply = (data: unknown, summary?: string) => ({
  content: [{ type: 'text' as const, text: summary ? `${summary}\n\n${JSON.stringify(data, null, 2)}` : JSON.stringify(data, null, 2) }],
  structuredContent: data as Record<string, unknown>,
});
const token = () => process.env.MCPLANE_TOKEN;
const PROJECT = z.string().optional().describe('Folder holding mcplane.json. Defaults to the folder mcplane was started in.');
const dirOf = (p?: string) => resolve(p ?? process.cwd());

export async function serve(): Promise<void> {
  const server = new McpServer({ name: 'mcplane', title: 'mcplane', version: VERSION });

  server.registerTool(
    'preflight',
    {
      title: 'Check an MCP server against store review rules',
      description:
        'Checks a live MCP server, its listing links, icon and plugin repo against the known rejection causes of ChatGPT, Claude, Cursor, Grok, Muse and the MCP Registry. Returns each check with pass, warn, fail or skip, what was found and how to fix it, plus reminders that no script can verify. Uses mcplane.json, or a url for a server without one.',
      inputSchema: { project: PROJECT, url: z.string().url().optional(), stores: z.array(STORE).optional() },
      annotations: { title: 'Preflight', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project, url, stores }) => {
      const m = url ? await draftManifest(url) : await loadManifest(dirOf(project));
      const r = await preflight(m, { stores, token: token() });
      const fails = r.checks.filter((c) => c.level === 'fail').length;
      return reply(r, `${fails} blocking, ${r.checks.filter((c) => c.level === 'warn').length} to review, ${r.checks.filter((c) => c.level === 'pass').length} passed.`);
    },
  );

  server.registerTool(
    'drift',
    {
      title: 'What each store needs since your last submission',
      description:
        'Compares the live server and mcplane.json with the snapshot saved when each submission was recorded, and lists what each store needs: a new ChatGPT version, a Claude listing edit, a plugin pin bump. Stores without a snapshot are listed as missing.',
      inputSchema: { project: PROJECT, stores: z.array(STORE).optional() },
      annotations: { title: 'Drift', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project, stores }) => {
      const m = await loadManifest(dirOf(project));
      const r = await drift(m, stores?.length ? stores : storesOf(m), { token: token() }, dirOf(project));
      return reply(r, r.items.length ? `${r.items.filter((i) => i.level === 'action').length} store actions needed.` : 'No drift.');
    },
  );

  server.registerTool(
    'pack',
    {
      title: 'Write a submission pack',
      description:
        'Writes everything a store’s submission form asks for into .mcplane/packs: chatgpt-app-submission.json for ChatGPT’s import, markdown packs for claude-connectors, cursor and muse. Returns the files written and any problems to fix first.',
      inputSchema: { project: PROJECT, store: z.enum(['chatgpt', 'claude-connectors', 'cursor', 'muse']) },
      annotations: { title: 'Pack', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project, store }) => {
      const m = await loadManifest(dirOf(project));
      const pack = store === 'chatgpt' ? await chatgptPack(m, token()) : store === 'claude-connectors' ? await claudePack(m, token()) : await simplePack(m, store);
      const files = await writePack(pack, dirOf(project));
      return reply({ files, problems: pack.problems, todo: pack.todo });
    },
  );

  server.registerTool(
    'publish',
    {
      title: 'Publish to a store that allows automation',
      description:
        'mcp-registry: writes server.json and runs mcp-publisher. grok: opens a pull request to xai-org/plugin-marketplace (new listing or pin bump), validated with xAI’s scripts. Other stores return the prepared entry or command. With confirm false it returns what it would do and changes nothing.',
      inputSchema: { project: PROJECT, store: STORE, confirm: z.boolean().default(false) },
      annotations: { title: 'Publish', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ project, store, confirm }) => {
      const m = await loadManifest(dirOf(project));
      const r = await publish(m, store, { yes: confirm, dir: dirOf(project) });
      if (r.done && confirm && (store === 'mcp-registry' || store === 'grok')) {
        const rec = await recordSubmitted(m, store, { version: m.version, share: true }, dirOf(project)).catch(() => null);
        return reply({ ...r, recorded: rec?.note ?? null });
      }
      return reply(r);
    },
  );

  server.registerTool(
    'record_submission',
    {
      title: 'Record a store submission',
      description:
        'Records that the developer submitted to a store, saves a snapshot for drift, and logs an anonymous public report to Review Times (reviewtimes.fyi) so the wait counts toward the store’s public numbers. share false keeps it local.',
      inputSchema: {
        project: PROJECT,
        store: STORE,
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        kind: z.enum(['new', 'update', 'resubmission']).optional(),
        version: z.string().optional(),
        app_id: z.string().optional(),
        share: z.boolean().default(true),
      },
      annotations: { title: 'Record submission', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ project, store, date, kind, version, app_id, share }) => {
      const m = await loadManifest(dirOf(project));
      return reply(await recordSubmitted(m, store, { date, kind, version, appId: app_id, share, token: token() }, dirOf(project)));
    },
  );

  server.registerTool(
    'record_decision',
    {
      title: 'Record a store’s decision',
      description: 'Marks the latest waiting submission to a store as approved, rejected or withdrawn, and updates its Review Times report.',
      inputSchema: { project: PROJECT, store: STORE, outcome: z.enum(['approved', 'rejected', 'withdrawn']), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() },
      annotations: { title: 'Record decision', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ project, store, outcome, date }) => reply(await recordDecision(store, outcome, date, dirOf(project))),
  );

  server.registerTool(
    'submission_status',
    {
      title: 'Your submissions and how long they’ve waited',
      description: 'Every recorded submission with days waited, refreshed from Review Times (which closes reports itself when a listing appears), and each store’s typical wait right now.',
      inputSchema: { project: PROJECT },
      annotations: { title: 'Status', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project }) => reply({ submissions: await status(dirOf(project)) }),
  );

  server.registerTool(
    'install_links',
    {
      title: 'Install links for every client',
      description: 'Install commands and links for Claude Code, Cursor, VS Code, Claude and ChatGPT developer mode, for testing before and after listing.',
      inputSchema: { project: PROJECT },
      annotations: { title: 'Try', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project }) => reply({ links: tryLinks(await loadManifest(dirOf(project))) }),
  );

  server.registerTool(
    'pull_listings',
    {
      title: 'Compare live listings with mcplane.json',
      description: 'Reads the store listings that have an open feed (Claude directory, Cursor marketplace) and returns fields that differ from mcplane.json.',
      inputSchema: { project: PROJECT },
      annotations: { title: 'Pull', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project }) => reply({ listings: await pull(await loadManifest(dirOf(project))) }),
  );

  server.registerTool(
    'init',
    {
      title: 'Create mcplane.json',
      description: 'Writes a starting mcplane.json from what the live server and its domain reveal (name, auth, privacy, support, terms and icon URLs). Refuses to overwrite an existing file.',
      inputSchema: { project: PROJECT, url: z.string().url() },
      annotations: { title: 'Init', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project, url }) => {
      const file = join(dirOf(project), MANIFEST_FILE);
      if (await access(file).then(() => true, () => false)) return reply({ error: `${file} already exists` });
      const m = await draftManifest(url);
      await writeFile(file, JSON.stringify(m, null, 2) + '\n');
      return reply({ written: file, manifest: m }, 'Fill in subtitle, oneLiner, description and tests, then run preflight.');
    },
  );

  server.registerTool(
    'fleet',
    {
      title: 'Every project at a glance',
      description:
        'Finds every mcplane.json under a folder (three levels down) and returns, per project: blocking preflight checks, store updates needed since the last submission, reviews waiting and stores it is live on. quick true skips the live checks.',
      inputSchema: { root: z.string().optional().describe('Folder to search. Defaults to where mcplane was started.'), quick: z.boolean().default(false) },
      annotations: { title: 'Fleet', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ root, quick }) => {
      const rows = await fleet(dirOf(root), { checks: !quick, token: token() });
      const bad = rows.filter((r) => r.error || r.blocking || r.driftActions?.length).length;
      return reply({ projects: rows }, `${rows.length} projects, ${bad} need attention.`);
    },
  );

  // Prompts are the agent-era "fastlane init": the agent in your repo writes the listing, you approve it.
  const say = (text: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] });

  server.registerPrompt(
    'onboard',
    {
      title: 'Get an MCP server ready for the stores',
      description: 'Creates mcplane.json, writes the listing and review tests from the code, and runs preflight.',
      argsSchema: { url: z.string().describe('The server’s public MCP URL'), project: z.string().optional().describe('Project folder, if not the current one') },
    },
    ({ url, project }) =>
      say(`Get this MCP server ready for store submission with mcplane.${project ? ` The project is in ${project}; pass it as "project" to every mcplane tool.` : ''}

1. Call mcplane's init tool with url ${url}. If mcplane.json already exists, read it instead.
2. Read the server's code and README, then fill in mcplane.json:
   - title; subtitle (30 characters max, no "AI" filler); oneLiner (one plain sentence: what it does); description (what it does, who it's for, what it can't do).
   - category (a ChatGPT category such as DEVELOPER_TOOLS or PRODUCTIVITY), stores (where it should list), repository if there's a public plugin repo, version.
   - tests: exactly 5 positive cases (scenario, a realistic user prompt, the tools it should call, the expected result) and 3 negative cases (prompts that should NOT trigger this app). Base them on real tool behaviour, not hopes.
   - justifications, only where the drafts would be wrong: one factual sentence per hint, under 200 characters.
   Write in plain language. No marketing words, no instructions to the model, no pricing or upgrade copy.
3. Call preflight. Fix what you can in the code (annotations, titles, output schemas, descriptions) and list what needs me (legal pages, icon, OAuth setup).
4. Show me the final listing text and the tests before anything is submitted.`),
  );

  server.registerPrompt(
    'ship',
    {
      title: 'Ship to the stores',
      description: 'Checks, prepares every submission, publishes where the store allows it, and lists exactly what is left for you.',
      argsSchema: { project: z.string().optional().describe('Project folder, if not the current one') },
    },
    ({ project }) =>
      say(`Ship this MCP server to its stores with mcplane.${project ? ` Pass project "${project}" to every mcplane tool.` : ''}

1. preflight. If anything is blocking, stop and fix it (or tell me what needs me).
2. drift, to see what each store needs since the last submission.
3. pack for each form-based store in mcplane.json (chatgpt, claude-connectors, cursor, muse).
4. publish with confirm false for mcp-registry and grok, show me what it would do, and on my go-ahead publish with confirm true.
5. For the form-based stores, give me one short checklist: which file to upload or paste where, and the statements only I can make. If you have browser tools, offer to fill the form fields from the pack; I tick the policy statements and press submit myself.
6. After I say I've submitted, call record_submission for each store (ChatGPT: ask me for the asdk_app_ id).`),
  );

  await server.connect(new StdioServerTransport());
}
