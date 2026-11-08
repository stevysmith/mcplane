/**
 * The Claude plugin directory's automatic "Directory policy" check (claude.ai/directory/manage, new in early
 * November 2026), run against the plugin's own folder: which files an organization Anthropic hasn't Verified may
 * ship, credentials read from the user's machine, and the icon the directory lists. Node only (it reads files).
 */
import { execFile } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { imageInfo } from '../images.js';
import type { Check, Manifest, StoreId } from '../types.js';

export const PLUGIN_CHECKLIST = 'https://claude.com/docs/plugins/pre-submission-checklist.md';
const STORES: StoreId[] = ['claude-plugins'];

export interface PluginFile {
  /** Path inside the plugin folder, with forward slashes. */
  path: string;
  data: Uint8Array;
}

/** Markdown, text, JSON, YAML, and PNG, JPEG, GIF, WebP or ICO images. */
const ALLOWED = /\.(md|markdown|txt|json|ya?ml|png|jpe?g|gif|webp|ico)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|ico)$/i;
/** A license, a README and .gitignore may stay whatever their extension, if they are UTF-8 text without #!. */
const KEPT = /^(licen[cs]e|copying|readme)(\.(md|markdown|txt|rst))?$|^\.gitignore$/i;
/** Package manager configuration, refused even when it's JSON, YAML or text. */
const PACKAGE_FILES = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', '.npmrc', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', '.pnpmfile.cjs',
  'yarn.lock', '.yarnrc', '.yarnrc.yml', 'bun.lock', 'bun.lockb', 'deno.json', 'deno.jsonc', 'deno.lock',
  'requirements.txt', 'pipfile', 'pipfile.lock', 'pyproject.toml', 'poetry.lock', 'uv.lock',
  'gemfile', 'gemfile.lock', 'go.mod', 'go.sum', 'cargo.toml', 'cargo.lock', 'composer.json', 'composer.lock',
]);
/** Noise that is never part of a committed plugin, skipped when the folder isn't a git checkout. */
const SKIPPED = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db']);

const base = (p: string) => p.split('/').pop()!;

/** The plugin folder: claudePlugin.dir, else the folder holding mcplane.json when it has .claude-plugin/plugin.json. */
export async function pluginDir(m: Manifest, dir: string): Promise<string | null> {
  const has = (d: string) => lstat(join(d, '.claude-plugin', 'plugin.json')).then((s) => s.isFile(), () => false);
  if (m.claudePlugin?.dir) {
    const d = resolve(dir, m.claudePlugin.dir);
    return (await has(d)) ? d : null;
  }
  return (await has(dir)) ? dir : null;
}

async function walk(root: string, at = root): Promise<string[]> {
  const out: string[] = [];
  for (const e of (await readdir(at, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIPPED.has(e.name)) continue;
    const abs = join(at, e.name);
    if (e.isDirectory()) out.push(...(await walk(root, abs)));
    else if (e.isFile()) out.push(relative(root, abs).split(sep).join('/'));
  }
  return out;
}

/**
 * The files the directory would see: what git tracks (plus new files it doesn't ignore) in a checkout, else
 * everything in the folder but .git, node_modules and Finder litter. Symbolic links aren't read.
 */
export async function pluginFiles(dir: string): Promise<PluginFile[]> {
  const git = await promisify(execFile)('git', ['-C', dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { maxBuffer: 64 * 1024 * 1024 })
    .then((r) => r.stdout.split('\0').filter(Boolean))
    .catch(() => []);
  const paths = git.length ? [...new Set(git)].sort() : await walk(dir);
  const files: PluginFile[] = [];
  for (const path of paths) {
    const abs = join(dir, path);
    const st = await lstat(abs).catch(() => null);
    if (!st?.isFile()) continue;
    files.push({ path, data: new Uint8Array(await readFile(abs)) });
  }
  return files;
}

/** Text the directory reads as text: valid UTF-8 with no NUL byte. */
function text(data: Uint8Array): string | null {
  if (data.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

/** Every file an unverified organization can't ship, with why. `icon` is plugin.json's icon path, which may stay. */
export function policyFindings(files: PluginFile[], icon?: string): { path: string; why: string }[] {
  const iconPath = icon && !/^[a-z]+:/i.test(icon) ? icon.replace(/^\.\//, '') : undefined;
  const out: { path: string; why: string }[] = [];
  for (const f of files) {
    const name = base(f.path);
    if (PACKAGE_FILES.has(name.toLowerCase())) {
      out.push({ path: f.path, why: 'package manager file' });
      continue;
    }
    const kept = KEPT.test(name) || f.path === iconPath;
    if (!ALLOWED.test(name) && !kept) {
      out.push({ path: f.path, why: 'not an allowed type' });
      continue;
    }
    if (IMAGE.test(name)) continue;
    if (f.data[0] === 0x23 && f.data[1] === 0x21) out.push({ path: f.path, why: 'starts with #!' });
    else if (text(f.data) === null) out.push({ path: f.path, why: 'not UTF-8 text, or holds a NUL byte' });
  }
  return out;
}

/** Environment variables whose names say credential: $ACME_API_KEY, process.env.GITHUB_TOKEN, os.getenv("DB_PASSWORD"). */
const ENV_READ = /(?:\$\{?|\$env:|process\.env\.|process\.env\[['"]|environ(?:\.get)?[[(]\s*['"]|getenv\(\s*['"]|env\.get\(\s*['"])([A-Za-z_][A-Za-z0-9_]*)/g;
const CREDENTIAL_NAME = /(^|_)(API_?KEY|KEY|TOKEN|SECRET|SECRET_KEY|PASSWORD|PASSWD|PASS|PAT|AUTH|CREDENTIALS?|PRIVATE_KEY|ACCESS_KEY)$/;
/** Values Claude Code fills from the plugin's userConfig are the recommended way, not a forward. */
const USER_CONFIG = /^CLAUDE_PLUGIN_OPTION_/;
/** Key files in the home folder: ~/.ssh/id_ed25519, ~/.aws/credentials, $HOME/.acme/token.json. */
const KEY_FILE = /(?:~|\$\{?HOME\}?|%USERPROFILE%)[/\\][^\s'"`)<>]*?(?:\.ssh|\.aws|\.netrc|\.gnupg|\.kube|\.docker[/\\]config|credential|secret|token|wallet|passw|private[_-]?key|api[_-]?key|\.pem)[^\s'"`)<>]*|\bid_(?:rsa|ed25519|ecdsa|dsa)\b/gi;
/** Sending something to a server. */
const SENDS = /\bcurl\b|\bwget\b|\bfetch\s*\(|https?:\/\/|\bInvoke-(?:WebRequest|RestMethod)\b|\brequests\.\w+\(|\baxios\b|\bhttpx\b|\burllib\b|\bAuthorization\b/i;

/** Files that read a credential from the user's machine and send something to a server, with what they read. */
export function credentialReads(files: PluginFile[]): { path: string; reads: string[] }[] {
  const out: { path: string; reads: string[] }[] = [];
  for (const f of files) {
    // CI workflows run on GitHub, not on the user's machine.
    if (IMAGE.test(f.path) || f.path.startsWith('.github/')) continue;
    const body = text(f.data);
    if (!body || !SENDS.test(body)) continue;
    const reads = new Set<string>();
    for (const m of body.matchAll(ENV_READ)) {
      const name = m[1].toUpperCase();
      if (CREDENTIAL_NAME.test(name) && !USER_CONFIG.test(name)) reads.add(m[0].startsWith('$') && !m[0].startsWith('$env:') ? `$${m[1]}` : m[1]);
    }
    for (const m of body.matchAll(KEY_FILE)) reads.add(m[0]);
    if (reads.size) out.push({ path: f.path, reads: [...reads] });
  }
  return out;
}

const list = (items: string[], max = 12) => (items.length > max ? `${items.slice(0, max).join(', ')} and ${items.length - max} more` : items.join(', '));

/** The icon check: the directory lists community plugins with a 256 px PNG it makes from plugin.json's icon. */
function iconCheck(icon: unknown, files: PluginFile[]): Check {
  const title = 'The plugin’s icon is a square PNG';
  const fix = 'Claude’s plugin directory lists community plugins with a 256 px PNG it makes from plugin.json’s "icon" (api.anthropic.com/api/directory/plugin-icons/<hash>/256.png). With an SVG icon, Stacktree’s plugin got none (the public feed’s media.icons was empty) and the portal showed the GitHub repo owner’s avatar instead (8 Nov 2026). Point "icon" at a square PNG in the plugin; 512 px worked.';
  if (typeof icon !== 'string' || !icon) return { id: 'plugin.icon', level: 'info', title, detail: 'plugin.json sets no icon', fix, stores: STORES };
  if (/^https?:\/\//i.test(icon)) {
    return /\.png(\?|#|$)/i.test(icon) ? { id: 'plugin.icon', level: 'pass', title, detail: icon, stores: STORES } : { id: 'plugin.icon', level: 'warn', title, detail: `${icon} isn't a PNG`, fix, stores: STORES };
  }
  const path = icon.replace(/^\.\//, '');
  const file = files.find((f) => f.path === path);
  if (!file) return { id: 'plugin.icon', level: 'warn', title, detail: `${icon} isn't in the plugin`, fix, stores: STORES };
  const img = imageInfo(file.data);
  const size = img.width !== undefined ? `${img.width}×${img.height}` : '';
  const kind = img.format ? img.format.toUpperCase() : path.includes('.') ? path.split('.').pop()!.toUpperCase() : 'not an image';
  if (img.format !== 'png') return { id: 'plugin.icon', level: 'warn', title, detail: `${icon} is ${kind}${size ? `, ${size}` : ''}`, fix, stores: STORES };
  if (img.width !== img.height || (img.width ?? 0) < 256) return { id: 'plugin.icon', level: 'warn', title, detail: `${icon} is ${size || 'a PNG of unknown size'}`, fix, stores: STORES };
  return { id: 'plugin.icon', level: 'pass', title, detail: `${icon}, ${size}`, stores: STORES };
}

/**
 * Checks on the plugin's own files, for Claude's plugin directory. With no plugin folder, one skip saying how to
 * point at it (only when `explicit`, so a manifest without "stores" doesn't get a line about plugins it may not have).
 */
export async function pluginChecks(m: Manifest, dir: string, opts: { explicit?: boolean } = {}): Promise<Check[]> {
  const root = await pluginDir(m, dir);
  if (!root) {
    return opts.explicit || m.claudePlugin?.dir
      ? [{ id: 'plugin.files', level: 'skip', title: 'The plugin’s files meet the Claude plugin directory’s policy', detail: m.claudePlugin?.dir ? `no .claude-plugin/plugin.json in ${m.claudePlugin.dir}` : 'no plugin folder here', fix: 'Set claudePlugin.dir in mcplane.json to the plugin’s folder (the one holding .claude-plugin/plugin.json), or run preflight there, to check the files the directory refuses.', stores: STORES }]
      : [];
  }
  const files = await pluginFiles(root);
  const manifest = files.find((f) => f.path === '.claude-plugin/plugin.json');
  let plugin: Record<string, unknown> = {};
  try {
    plugin = JSON.parse(new TextDecoder().decode(manifest?.data ?? new Uint8Array()));
  } catch {
    plugin = {};
  }
  const icon = typeof plugin.icon === 'string' ? plugin.icon : undefined;
  const where = relative(dir, root) || '.';
  const checks: Check[] = [];

  const refused = policyFindings(files, icon);
  const title = 'The plugin’s files meet the Claude plugin directory’s policy';
  const why = [...new Set(refused.map((r) => r.why))].map((w) => `${w}: ${list(refused.filter((r) => r.why === w).map((r) => r.path))}`).join('; ');
  const rules = `From an organization Anthropic hasn’t Verified, the directory’s automatic policy check refuses a version holding any file that isn’t Markdown, text, JSON, YAML or a PNG, JPEG, GIF, WebP or ICO image, any file starting with #!, any package manager file (package.json, lockfiles, .npmrc, pnpm-workspace.yaml) and text that isn’t UTF-8 or holds NUL bytes ("Files outside the allowed types accepted only from Verified organizations"). A license, a README, .gitignore and the plugin’s own icon may stay if they are UTF-8 text or an allowed image and don’t start with #!. The pre-submission checklist (${PLUGIN_CHECKLIST}) is looser (it holds some binaries for a reviewer and allows SVG), but the portal refused on these rules on 8 Nov 2026.`;
  if (!refused.length) checks.push({ id: 'plugin.file-types', level: 'pass', title, detail: `${files.length} files in ${where}`, stores: STORES });
  else if (m.claudePlugin?.verified) checks.push({ id: 'plugin.file-types', level: 'info', title, detail: why, fix: `claudePlugin.verified says your organization is Verified, which exempts it. ${rules}`, stores: STORES });
  else checks.push({ id: 'plugin.file-types', level: 'fail', title, detail: why, fix: `${rules} Ship the MCP server and Markdown skills, and move scripts and packages elsewhere (a hosted skill, npm). Verified organizations are exempt: set claudePlugin.verified if yours is.`, stores: STORES });

  const reads = credentialReads(files);
  checks.push(
    reads.length
      ? {
          id: 'plugin.credential-forward',
          level: 'warn',
          title: 'The plugin doesn’t send a credential from the user’s machine',
          detail: list(reads.map((r) => `${r.path} (${r.reads.join(', ')})`), 8),
          fix: `Reading a credential from the user’s machine (an environment variable such as $ACME_API_KEY, or a key file) and sending it to a server is "Uses a credential from the user’s machine" (MCP_FORWARDS_CREDENTIAL_ENV), which the pre-submission checklist (${PLUGIN_CHECKLIST}) holds for a reviewer. An update that adds one the live version didn’t have goes to a human instead of publishing on its own ("Update adds credential forward"). Ask for the key with userConfig in plugin.json, marked sensitive: true, or rely on the bundled MCP server’s OAuth sign-in.`,
          stores: STORES,
        }
      : { id: 'plugin.credential-forward', level: 'pass', title: 'The plugin doesn’t send a credential from the user’s machine', stores: STORES },
  );

  checks.push(iconCheck(plugin.icon, files));
  return checks;
}
