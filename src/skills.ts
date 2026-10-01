/**
 * Agent Skills for plugin packages: each skill is a folder with a SKILL.md, bundled under
 * skills/<folder>/ with its scripts and references, executable bits kept. Checked against the
 * Agent Skills spec (agentskills.io) and the skill rules in OpenAI's submission errors.
 */
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import type { ZipEntry } from './zip.js';

/** Front matter fields the Agent Skills spec defines. */
const SPEC_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DESCRIPTION_MAX = 1024;
/** Noise and bulk that never belongs in a package. */
const SKIPPED = new Set(['.DS_Store', 'Thumbs.db', 'node_modules', '.git']);

export type FrontMatter = { data: Record<string, unknown>; body: string } | { error: string };

function unquoteDouble(s: string): string {
  try {
    return JSON.parse(s.replace(/\\'/g, "'").replace(/\\\n/g, ''));
  } catch {
    return s.slice(1, -1);
  }
}

/**
 * Reads SKILL.md front matter: the YAML a skill loader sees, for the subset skills use (plain,
 * quoted and block scalars, nested maps and lists). A plain value holding ": " is an error, as in
 * YAML itself, because strict loaders refuse the whole skill over it.
 */
export function frontMatter(raw: string): FrontMatter {
  const lines = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n');
  if (lines[0].trimEnd() !== '---') return { error: 'SKILL.md must start with front matter between --- lines' };
  const close = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
  if (close < 0) return { error: 'the front matter has no closing --- line' };
  const fm = lines.slice(1, close);
  const data: Record<string, unknown> = {};
  for (let i = 0; i < fm.length; i++) {
    const line = fm[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = /^([A-Za-z0-9_-]+)\s*:(?:[ \t]+(.*))?$/.exec(line);
    if (!m) return { error: `front matter line ${i + 2} isn't "key: value": ${line.trim().slice(0, 60)}` };
    const key = m[1];
    const value = (m[2] ?? '').trim();
    const more: string[] = [];
    while (i + 1 < fm.length && (fm[i + 1].trim() === '' || /^\s/.test(fm[i + 1]))) more.push(fm[++i]);
    while (more.length && !more[more.length - 1].trim()) more.pop();
    if (/^[|>][+-]?\d*(\s+#.*)?$/.test(value)) {
      const indent = Math.min(...more.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
      const body = more.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
      data[key] = value.startsWith('|') ? body.join('\n') : body.reduce((s, l) => (!l.trim() ? `${s}\n` : s && !s.endsWith('\n') ? `${s} ${l}` : `${s}${l}`), '');
    } else if (!value && more.length) {
      const items = more.filter((l) => l.trim());
      data[key] = items.every((l) => /^\s*-\s/.test(l))
        ? items.map((l) => l.replace(/^\s*-\s+/, '').trim())
        : Object.fromEntries(items.map((l) => /^\s*([^:]+):\s*(.*)$/.exec(l)).filter(Boolean).map((r) => [r![1].trim(), r![2].trim().replace(/^(["'])(.*)\1$/, '$2')]));
    } else if (value.startsWith('"')) {
      data[key] = unquoteDouble([value, ...more.map((l) => l.trim())].join(' '));
    } else if (value.startsWith("'")) {
      data[key] = [value, ...more.map((l) => l.trim())].join(' ').slice(1, -1).replace(/''/g, "'");
    } else {
      const text = [value, ...more.map((l) => l.trim())].join(' ').replace(/\s+#.*$/, '');
      if (/:\s/.test(text)) return { error: `"${key}" holds ": " without quotes, which YAML reads as a nested key; quote the value` };
      data[key] = text;
    }
  }
  return { data, body: lines.slice(close + 1).join('\n') };
}

interface Found {
  /** Path inside the skill folder, with forward slashes. */
  inner: string;
  abs: string;
  mode: number;
}

async function walk(root: string, problems: string[], skipped: string[], at = root): Promise<Found[]> {
  const out: Found[] = [];
  for (const name of (await readdir(at)).sort()) {
    const abs = join(at, name);
    const inner = relative(root, abs).split(sep).join('/');
    if (SKIPPED.has(name)) continue;
    if (name.startsWith('.')) {
      skipped.push(inner);
      continue;
    }
    const st = await lstat(abs);
    if (st.isSymbolicLink()) problems.push(`${basename(root)}/${inner} is a symbolic link; packages can't hold one (OpenAI ignores the skill). Copy the file in instead`);
    else if (st.isDirectory()) out.push(...(await walk(root, problems, skipped, abs)));
    else if (st.isFile()) out.push({ inner, abs, mode: st.mode & 0o111 ? 0o755 : 0o644 });
  }
  return out;
}

/** Skill folders from the manifest setting: one folder of skills, or a list of skill folders. Null when the folder isn't there. */
async function skillDirs(spec: string | string[], dir: string): Promise<string[] | null> {
  if (Array.isArray(spec)) return spec.map((p) => resolve(dir, p));
  const parent = resolve(dir, spec);
  const names = await readdir(parent).catch(() => null);
  if (!names) return null;
  const dirs: string[] = [];
  for (const n of names.sort()) if (!n.startsWith('.') && !SKIPPED.has(n) && (await lstat(join(parent, n))).isDirectory()) dirs.push(join(parent, n));
  return dirs;
}

export interface SkillBundle {
  files: ZipEntry[];
  names: string[];
  problems: string[];
  todo: string[];
}

/** Reads, checks and lays out skills for skills/<folder>/ in a plugin package. */
export async function bundleSkills(spec: string | string[] | undefined, dir: string, pluginName: string): Promise<SkillBundle> {
  const out: SkillBundle = { files: [], names: [], problems: [], todo: [] };
  if (spec === undefined) return out;
  const dirs = await skillDirs(spec, dir);
  if (!dirs) {
    out.problems.push(`chatgpt.skills: ${spec} isn't a folder (paths are relative to mcplane.json)`);
    return out;
  }
  if (!dirs.length && typeof spec === 'string') out.todo.push(`chatgpt.skills: ${spec} holds no skill folders, so the package has no skills.`);
  const seen = new Map<string, string>();
  for (const root of dirs) {
    const folder = basename(root);
    const where = `skills/${folder}`;
    const st = await lstat(root).catch(() => null);
    if (!st?.isDirectory()) {
      out.problems.push(`${where}: ${relative(dir, root) || root} isn't a folder`);
      continue;
    }
    const skipped: string[] = [];
    const found = await walk(root, out.problems, skipped);
    if (skipped.length) out.todo.push(`Left out of ${where}: ${skipped.join(', ')} (hidden files never go in the package).`);
    const md = found.find((f) => f.inner === 'SKILL.md');
    if (!md) {
      out.problems.push(`${where} has no SKILL.md`);
      continue;
    }
    const raw = await readFile(md.abs, 'utf8');
    const fm = frontMatter(raw);
    if ('error' in fm) {
      out.problems.push(`${where}/SKILL.md: ${fm.error}`);
      continue;
    }
    const { name, description } = fm.data;
    if (typeof name !== 'string' || !name.trim()) out.problems.push(`${where}/SKILL.md: "name" is required`);
    else {
      if (!NAME.test(name) || name.length > 64) out.problems.push(`${where}/SKILL.md: name "${name}" must be lowercase letters, digits and single hyphens, at most 64 characters`);
      if (name !== folder) out.problems.push(`${where}/SKILL.md: name "${name}" doesn't match its folder "${folder}"; the Agent Skills spec requires a match, and strict clients skip the skill`);
      if (`${pluginName}:${name}`.length > 64) out.problems.push(`${where}: "${pluginName}:${name}" is over 64 characters, OpenAI's limit for a skill's full name`);
      if (seen.has(name)) out.problems.push(`${where}: the name "${name}" is also used by ${seen.get(name)}`);
      seen.set(name, where);
      out.names.push(name);
    }
    if (typeof description !== 'string' || !description.trim()) out.problems.push(`${where}/SKILL.md: "description" is required`);
    else if (description.trim().length > DESCRIPTION_MAX) out.problems.push(`${where}/SKILL.md: the description is ${description.trim().length} characters; the limit is ${DESCRIPTION_MAX}`);
    if (!fm.body.trim()) out.problems.push(`${where}/SKILL.md has no instructions after the front matter`);
    const extra = Object.keys(fm.data).filter((k) => !SPEC_FIELDS.has(k));
    if (extra.length) out.todo.push(`${where}/SKILL.md: ${extra.map((k) => `"${k}"`).join(', ')} ${extra.length === 1 ? "isn't" : "aren't"} in the Agent Skills spec. OpenAI ignores unknown fields, but strict clients may refuse the skill.`);
    const own = new Set(found.map((f) => f.inner));
    for (const ref of new Set([...raw.matchAll(/\bscripts\/[A-Za-z0-9._/-]*[A-Za-z0-9_-]/g)].map((r) => r[0]))) {
      if (!own.has(ref)) out.problems.push(`${where}/SKILL.md refers to ${ref}, which isn't in the skill's folder. Installed on its own, the skill can't run it`);
    }
    for (const f of found) out.files.push({ path: `${where}/${f.inner}`, data: await readFile(f.abs), mode: f.mode });
  }
  return out;
}
