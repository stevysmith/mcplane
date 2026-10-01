/**
 * Agent Plugins 1.0.0, the open package format ChatGPT's portal takes: plugin.json and mcp.json
 * checked against the official JSON Schemas.
 *
 * schemas/agent-plugins-1.0.0/ holds unmodified copies of https://agent-plugins.org/schemas/1.0.0/
 * (github.com/agentplugins/agent-plugins-spec), Apache License 2.0; the licence is in the same folder.
 */
import { readFile } from 'node:fs/promises';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

export const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
export const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
/** OpenAI's limit for plugin.json's root description (plugin_description_too_long). */
export const DESCRIPTION_MAX = 1024;

/** The MCP server forms, by the "type" that selects each one. */
const SERVER_FORMS: Record<string, string> = { stdio: 'stdioServer', 'streamable-http': 'streamableHttpServer', sse: 'sseServer' };

interface Validators {
  plugin: ValidateFunction;
  mcp: ValidateFunction;
  /** One validator per server form, to explain an entry that matches none. */
  forms: Record<string, ValidateFunction>;
}

let compiled: Promise<Validators> | undefined;

function validators(): Promise<Validators> {
  compiled ??= (async () => {
    const load = async (file: string) => JSON.parse(await readFile(new URL(`../schemas/agent-plugins-1.0.0/${file}`, import.meta.url), 'utf8'));
    const [plugin, mcp] = await Promise.all([load('plugin.schema.json'), load('mcp.schema.json')]);
    const ajv = new Ajv2020({ allErrors: true, strict: true, logger: false });
    const v = { plugin: ajv.compile(plugin), mcp: ajv.compile(mcp) };
    const forms = Object.fromEntries(Object.entries(SERVER_FORMS).map(([type, def]) => [type, ajv.getSchema(`${MCP_SCHEMA}#/$defs/${def}`)!]));
    return { ...v, forms };
  })();
  return compiled;
}

/** One readable line per schema error, e.g. `plugin.json /author: "phone" isn't allowed by the Agent Plugins schema`. */
function describe(file: string, e: ErrorObject): string {
  const at = `${file}${e.instancePath ? ` ${e.instancePath}` : ''}`;
  const p = e.params as Record<string, any>;
  switch (e.keyword) {
    case 'required':
      return `${at}: "${p.missingProperty}" is required by the Agent Plugins schema`;
    case 'additionalProperties':
      return `${at}: "${p.additionalProperty}" isn't allowed by the Agent Plugins schema`;
    case 'const':
      return `${at} must be ${JSON.stringify(p.allowedValue)}`;
    case 'pattern':
      return e.instancePath === '/name' ? `${at} must be lowercase letters, digits, dots and hyphens, with no "--" or ".." (Agent Plugins schema)` : `${at} must match ${p.pattern}`;
    default:
      return `${at} ${e.message ?? 'is invalid'} (Agent Plugins schema)`;
  }
}

/**
 * Ajv reports every branch of a oneOf. An MCP server entry is checked again against the one form its
 * "type" names, so a missing url reads as one problem rather than three.
 */
function readable(file: string, errors: ErrorObject[], doc: any, forms: Validators['forms']): string[] {
  const oneOfs = errors.filter((e) => e.keyword === 'oneOf').map((e) => e.instancePath);
  const out: string[] = [];
  for (const path of oneOfs) {
    const entry = path.split('/').slice(1).reduce((v, k) => v?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
    const form = typeof entry?.type === 'string' ? forms[entry.type] : undefined;
    if (form && !form(entry)) out.push(...(form.errors ?? []).map((e) => describe(file, { ...e, instancePath: path + e.instancePath })));
    else out.push(`${file} ${path}: "type" must be stdio, streamable-http or sse (Agent Plugins schema)`);
  }
  for (const e of errors) {
    if (e.keyword === 'oneOf' || oneOfs.some((p) => e.instancePath.startsWith(p))) continue;
    out.push(describe(file, e));
  }
  return [...new Set(out)];
}

/** Every way plugin.json and mcp.json break the Agent Plugins 1.0.0 schemas; empty when both pass. */
export async function schemaProblems(plugin: unknown, mcp: unknown): Promise<string[]> {
  const v = await validators();
  const out: string[] = [];
  if (!v.plugin(plugin)) out.push(...readable('plugin.json', v.plugin.errors ?? [], plugin, v.forms));
  if (!v.mcp(mcp)) out.push(...readable('mcp.json', v.mcp.errors ?? [], mcp, v.forms));
  return out;
}
