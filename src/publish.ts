/**
 * Publishing where a store allows it. Dry run by default: it shows exactly
 * what it will do, and only acts with --yes.
 *
 *   mcp-registry   writes server.json and runs mcp-publisher
 *   grok           a complete pull request to xai-org/plugin-marketplace:
 *                  entry pinned to your repo's HEAD, index regenerated and
 *                  validated with xAI's own scripts (new listing or pin bump)
 *   the rest       the exact entry or command, ready to use
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { repoHead } from './drift.js';
import type { Manifest, StoreId } from './types.js';

export interface PublishResult {
  store: StoreId;
  done: boolean;
  lines: string[];
  url?: string;
}

const run = (cmd: string, args: string[], cwd?: string) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const has = (cmd: string) => {
  try {
    run('which', [cmd]);
    return true;
  } catch {
    return false;
  }
};

function ghRepo(m: Manifest): { owner: string; repo: string } | null {
  const g = m.repository?.match(/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?$/);
  return g ? { owner: g[1], repo: g[2] } : null;
}

/* ---------------- MCP Registry ---------------- */

/** Shortens at a word boundary, so a limit never cuts a word in half. */
const fit = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n + 1).replace(/[\s,;:]+\S*$/, '').replace(/[\s,;:]+$/, ''));

export function registryName(m: Manifest): string {
  if (m.registry?.name) return m.registry.name;
  const gh = ghRepo(m);
  if (gh) return `io.github.${gh.owner}/${m.name}`;
  const host = new URL(m.links?.website ?? m.server.url).hostname.replace(/^www\./, '');
  return `${host.split('.').reverse().join('.')}/${m.name}`;
}

export function serverJson(m: Manifest) {
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    name: registryName(m),
    title: m.title,
    description: fit(m.registry?.description ?? m.oneLiner ?? m.subtitle ?? m.title, 100),
    ...(m.links?.website ? { websiteUrl: m.links.website } : {}),
    ...(m.repository ? { repository: { url: m.repository.replace(/\.git$/, ''), source: 'github' } } : {}),
    version: m.version ?? '1.0.0',
    remotes: [{ type: 'streamable-http', url: m.server.url }],
  };
}

async function publishRegistry(m: Manifest, yes: boolean, dir: string): Promise<PublishResult> {
  const json = serverJson(m);
  const file = m.registry?.file ?? 'server.json';
  const lines: string[] = [];
  const long = (m.registry?.description ?? m.oneLiner ?? '').length > 100;
  if (long) lines.push('Description trimmed to 100 characters, the registry’s limit. Set registry.description in mcplane.json to choose the words.');
  const ns = json.name.split('/')[0];
  const auth = ns.startsWith('io.github.') ? `mcp-publisher login github` : `mcp-publisher login dns --domain ${ns.split('.').reverse().join('.')} --private-key <key>  (after adding the TXT record it prints)`;
  if (!yes) {
    return { store: 'mcp-registry', done: false, lines: [...lines, `Would write ${file}:`, JSON.stringify(json, null, 2), '', 'Then: mcp-publisher validate && mcp-publisher publish', `Log in first if needed: ${auth}`, 'Run again with --yes to do it.'] };
  }
  writeFileSync(resolve(dir, file), JSON.stringify(json, null, 2) + '\n');
  if (!has('mcp-publisher')) return { store: 'mcp-registry', done: false, lines: [...lines, `Wrote ${file}. Install mcp-publisher (brew install mcp-publisher), then: ${auth} && mcp-publisher publish`] };
  try {
    run('mcp-publisher', ['validate', file], dir);
    const out = run('mcp-publisher', ['publish', file], dir);
    return { store: 'mcp-registry', done: true, lines: [...lines, `Wrote ${file} and published ${json.name} v${json.version}.`, out], url: `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(json.name)}` };
  } catch (e) {
    const err = String((e as { stderr?: string }).stderr ?? (e as Error).message);
    return { store: 'mcp-registry', done: false, lines: [...lines, `Wrote ${file}, but publishing failed:`, err.trim(), /auth|login|token|401|403/i.test(err) ? `Log in: ${auth}` : ''] };
  }
}

/* ---------------- Grok (xai-org/plugin-marketplace) ---------------- */

const GROK = 'xai-org/plugin-marketplace';

function grokEntry(m: Manifest, sha: string) {
  const gh = ghRepo(m)!;
  const host = new URL(m.links?.website ?? m.server.url).hostname.replace(/^www\./, '');
  return {
    name: m.name,
    description: m.grok?.description ?? m.oneLiner ?? m.description ?? m.title,
    category: m.grok?.category ?? 'development',
    source: { source: 'url', url: `https://github.com/${gh.owner}/${gh.repo}.git`, sha },
    ...(m.links?.website ? { homepage: m.links.website } : {}),
    keywords: m.grok?.keywords ?? [m.name, m.title.toLowerCase()],
    domains: m.grok?.domains ?? [host],
  };
}

/** Adds or re-pins our entry without reformatting the rest of the file. */
function editMarketplace(text: string, entry: ReturnType<typeof grokEntry>): { text: string; mode: 'add' | 'bump' | 'same' } {
  const data = JSON.parse(text) as { plugins: { name: string; source?: { sha?: string } }[] };
  const existing = data.plugins.find((p) => p.name === entry.name);
  if (existing) {
    const old = existing.source?.sha;
    if (!old || old === entry.source.sha) return { text, mode: 'same' };
    return { text: text.replace(old, entry.source.sha), mode: 'bump' };
  }
  const block = JSON.stringify(entry, null, 2)
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
  const end = text.lastIndexOf('}\n  ]');
  if (end < 0) throw new Error('Couldn’t find the end of the plugins list in marketplace.json.');
  return { text: `${text.slice(0, end + 1)},\n${block}${text.slice(end + 1)}`, mode: 'add' };
}

async function publishGrok(m: Manifest, yes: boolean): Promise<PublishResult> {
  const gh = ghRepo(m);
  if (!gh) return { store: 'grok', done: false, lines: ['Grok plugins come from a public GitHub repository. Set "repository" in mcplane.json.'] };
  const sha = await repoHead(m.repository);
  if (!sha) return { store: 'grok', done: false, lines: [`Couldn't read the latest commit of ${m.repository}. Is it public?`] };
  const entry = grokEntry(m, sha);
  if (!yes) {
    return {
      store: 'grok',
      done: false,
      lines: [
        `Would open a pull request to ${GROK} with this entry (pinned to ${sha.slice(0, 7)}), or bump the pin if ${m.name} is already listed:`,
        JSON.stringify(entry, null, 2),
        '',
        'Steps: fork, branch, edit .grok-plugin/marketplace.json, run scripts/generate-plugin-index.py and scripts/validate-catalog.py (xAI’s CI checks), push, open the PR.',
        'Needs: gh (logged in), git, python3. Run again with --yes to do it.',
      ],
    };
  }
  for (const tool of ['gh', 'git', 'python3']) if (!has(tool)) return { store: 'grok', done: false, lines: [`${tool} is required for this. Install it and try again.`] };
  const me = run('gh', ['api', 'user', '--jq', '.login']);
  try {
    run('gh', ['repo', 'fork', GROK, '--clone=false']);
  } catch {
    // Already forked.
  }
  const dir = mkdtempSync(join(tmpdir(), 'mcplane-grok-'));
  run('git', ['clone', '--depth', '50', `https://github.com/${GROK}.git`, dir]);
  const branch = `mcplane/${m.name}-${sha.slice(0, 7)}`;
  run('git', ['checkout', '-b', branch], dir);
  const file = join(dir, '.grok-plugin/marketplace.json');
  const edit = editMarketplace(readFileSync(file, 'utf8'), entry);
  if (edit.mode === 'same') return { store: 'grok', done: true, lines: [`${m.name} is already listed and pinned to ${sha.slice(0, 7)}. Nothing to do.`] };
  writeFileSync(file, edit.text);
  run('python3', ['scripts/generate-plugin-index.py'], dir);
  run('python3', ['scripts/validate-catalog.py'], dir);
  run('python3', ['scripts/generate-plugin-index.py', '--check'], dir);
  const title = edit.mode === 'add' ? `Add ${m.name} plugin` : `Bump ${m.name} to ${sha.slice(0, 7)}`;
  run('git', ['add', '.grok-plugin'], dir);
  run('git', ['-c', 'user.name=mcplane', '-c', `user.email=${me}@users.noreply.github.com`, 'commit', '-m', title], dir);
  run('git', ['remote', 'add', 'fork', `https://github.com/${me}/plugin-marketplace.git`], dir);
  run('git', ['push', 'fork', branch], dir);
  const body = [
    edit.mode === 'add' ? `Adds **${m.title}**: ${entry.description}` : `Re-pins **${m.name}** to ${sha}.`,
    '',
    `- Source: https://github.com/${gh.owner}/${gh.repo} at \`${sha}\``,
    ...(m.links?.website ? [`- Homepage: ${m.links.website}`] : []),
    '- `validate-catalog.py` and `generate-plugin-index.py --check` pass locally.',
  ].join('\n');
  const url = run('gh', ['pr', 'create', '--repo', GROK, '--head', `${me}:${branch}`, '--title', title, '--body', body]);
  return { store: 'grok', done: true, lines: [`Opened ${url}`], url };
}

/* ---------------- Prepared, not automated ---------------- */

function prepared(m: Manifest, store: StoreId): PublishResult {
  const gh = ghRepo(m);
  const desc = m.oneLiner ?? m.subtitle ?? m.title;
  if (store === 'awesome-mcp-servers') {
    const link = gh ? `[${gh.owner}/${gh.repo}](https://github.com/${gh.owner}/${gh.repo})` : `[${m.title}](${m.links?.website ?? m.server.url})`;
    return {
      store,
      done: false,
      lines: [
        'Add this line to the right category in punkpeye/awesome-mcp-servers README.md (☁️ marks a hosted server), then open a pull request:',
        `- ${link} ☁️ - ${desc}`,
        'Keep categories alphabetical and follow their legend; PRs that don’t are the ones that wait.',
      ],
    };
  }
  if (store === 'smithery') {
    return { store, done: false, lines: [`Publish at https://smithery.ai/new with your server URL: ${m.server.url}`, 'Smithery also has a CLI ("smithery mcp publish") if you prefer the terminal.'] };
  }
  if (store === 'docker') {
    return {
      store,
      done: false,
      lines: ['Docker’s catalog takes a pull request to docker/mcp-registry adding servers/<name>/server.yaml. Follow its CONTRIBUTING guide; mcplane has your name, description and links ready in mcplane.json.'],
    };
  }
  return { store, done: false, lines: [`${store} is submitted through a form. Run "mcplane pack ${store}" for everything it asks.`] };
}

export async function publish(m: Manifest, store: StoreId, opts: { yes?: boolean; dir?: string } = {}): Promise<PublishResult> {
  if (store === 'mcp-registry') return publishRegistry(m, !!opts.yes, opts.dir ?? process.cwd());
  if (store === 'grok') return publishGrok(m, !!opts.yes);
  return prepared(m, store);
}

export const _test = { editMarketplace, grokEntry };
