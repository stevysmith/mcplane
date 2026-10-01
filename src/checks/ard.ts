/**
 * Agentic Resource Discovery (ARD v0.91, a proposal dated 26 Aug 2026): a manifest of entries at
 * /.well-known/ard.json that tells agents and registries what a domain offers, MCP servers included.
 * The predecessor path was /.well-known/ai-catalog.json, and that is what Lighthouse 13.5's
 * ard-schema audit still reads (after a robots.txt Agentmap line or a rel="ai-catalog" link), with
 * a port of the ARD conformance tester and the older ai-catalog schema: specVersion "1.0" required,
 * nothing but specVersion, host and entries at the top level.
 *
 * Spec:       https://agenticresourcediscovery.org/spec/ (https://github.com/ards-project/ard-spec, spec/ard.md)
 * Lighthouse: https://github.com/GoogleChrome/lighthouse/blob/v13.5.0/core/audits/agentic/ard-schema.js
 */
import type { Check, Manifest } from '../types.js';

export const ARD_PATH = '/.well-known/ard.json';
export const LEGACY_PATH = '/.well-known/ai-catalog.json';
export const MCP_CARD_TYPE = 'application/mcp-server-card+json';
/** spec/schemas/ard-entry.schema.json: urn:air:<publisher>:<namespace>:<name>. */
const URN = /^urn:air:[a-zA-Z0-9.-]+(:[a-zA-Z0-9._-]+)+$/;
/** The types Lighthouse 13.5 calls standard; others get a low-severity warning there. */
const STANDARD_TYPES = [
  'application/ai-catalog+json',
  'application/agent-card+json',
  'application/a2a-agent-card+json',
  MCP_CARD_TYPE,
  'application/agent-skills+zip',
  'application/agent-skills+gzip',
  'text/markdown; profile="urn:air:agent-skills"',
  'application/ai-registry',
  'application/ai-registry+json',
];
/** The ai-catalog schema allows only these in host. */
const HOST_KEYS = ['displayName', 'identifier', 'documentationUrl', 'logoUrl', 'trustManifest'];

export interface ArdIssues {
  /** Against ARD v0.91: the entry schema and its required terms. */
  errors: string[];
  /** Soft: representativeQueries outside 2 to 5, types Lighthouse doesn't know. */
  warnings: string[];
  /** What only Lighthouse 13.5 rejects, from its stricter ai-catalog schema. */
  lighthouse: string[];
}

export function validateArd(doc: unknown): ArdIssues {
  const out: ArdIssues = { errors: [], warnings: [], lighthouse: [] };
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ...out, errors: ['not a JSON object'] };
  const d = doc as Record<string, any>;
  if (!Array.isArray(d.entries)) out.errors.push(d.entries === undefined ? 'no "entries" array' : '"entries" is not an array');
  if (d.specVersion !== '1.0') out.lighthouse.push(d.specVersion === undefined ? 'no specVersion' : `specVersion "${d.specVersion}"`);
  const extra = Object.keys(d).filter((k) => !['specVersion', 'host', 'entries'].includes(k));
  if (extra.length) out.lighthouse.push(`top-level ${extra.join(', ')}`);
  if (d.host !== undefined) {
    if (!d.host || typeof d.host !== 'object' || !d.host.displayName) out.lighthouse.push('host has no displayName');
    const hostExtra = Object.keys(d.host ?? {}).filter((k) => !HOST_KEYS.includes(k));
    if (hostExtra.length) out.lighthouse.push(`host.${hostExtra.join(', host.')}`);
  }
  (Array.isArray(d.entries) ? d.entries : []).forEach((e: any, i: number) => {
    const label = e?.displayName || e?.identifier || `entry ${i + 1}`;
    if (!e || typeof e !== 'object') {
      out.errors.push(`${label}: not an object`);
      return;
    }
    if (!e.identifier) out.errors.push(`${label}: no identifier`);
    else if (!URN.test(e.identifier)) out.errors.push(`${label}: identifier "${e.identifier}" isn't urn:air:<publisher>:<namespace>:<name>`);
    if (!e.displayName) out.errors.push(`${label}: no displayName`);
    if (!e.type) out.errors.push(`${label}: no type`);
    else if (!STANDARD_TYPES.includes(e.type)) out.warnings.push(`${label}: Lighthouse doesn't know type "${e.type}"`);
    if ((e.url !== undefined) === (e.data !== undefined)) out.errors.push(`${label}: needs exactly one of url and data`);
    const q = e.representativeQueries;
    if (q === undefined) out.warnings.push(`${label}: no representativeQueries`);
    else if (!Array.isArray(q) || q.some((x: unknown) => typeof x !== 'string')) out.errors.push(`${label}: representativeQueries must be strings`);
    else if (q.length < 2 || q.length > 5) out.warnings.push(`${label}: ${q.length} representativeQueries`);
    if (e.trustManifest !== undefined && !e.trustManifest?.identity) out.errors.push(`${label}: trustManifest has no identity`);
  });
  return out;
}

const bare = (u?: string) => (u ?? '').replace(/\/+$/, '').toLowerCase();
/** The last two labels of a hostname: enough to tell api.example.com and example.com are one site. */
const site = (u: string) => {
  try {
    return new URL(u).hostname.split('.').slice(-2).join('.');
  } catch {
    return '';
  }
};

/** An entry that points at this MCP server: its URL, a server card on the same site (often the apex, beside api.), or inline data naming the URL. */
export function describesServer(e: any, serverUrl: string): boolean {
  if (!e || typeof e !== 'object') return false;
  if (bare(e.url) === bare(serverUrl)) return true;
  if (typeof e.url === 'string' && e.type === MCP_CARD_TYPE) return site(e.url) === site(serverUrl);
  return e.data !== undefined && JSON.stringify(e.data).includes(serverUrl);
}

export interface ArdFetched {
  origin: string;
  ard: unknown;
  legacy: unknown;
  /** The robots.txt Agentmap URL, if any, and what it served. */
  agentmap?: { url: string; doc: unknown };
}

/** The checks, from what was fetched. undefined means nothing usable was there. */
export function ardFindings(serverUrl: string, f: ArdFetched): Check[] {
  const checks: Check[] = [];
  const found = f.ard ?? f.legacy;
  const where = `${f.origin}${f.ard !== undefined ? ARD_PATH : LEGACY_PATH}`;
  checks.push(
    f.ard !== undefined
      ? { id: 'ard.path', level: 'pass', title: 'The ARD manifest is at /.well-known/ard.json', detail: where }
      : {
          id: 'ard.path',
          level: 'warn',
          title: 'The ARD manifest is at /.well-known/ard.json',
          detail: `only at ${where}, the predecessor path`,
          fix: `ARD v0.91 consumers must read ${ARD_PATH} and needn't read ai-catalog.json. Serve the same file at both while Lighthouse 13.5 still reads ai-catalog.json.`,
        },
  );
  const v = validateArd(found);
  const entries: any[] = Array.isArray((found as any)?.entries) ? (found as any).entries : [];
  checks.push(
    v.errors.length
      ? {
          id: 'ard.manifest',
          level: 'warn',
          title: 'The ARD manifest is valid',
          detail: v.errors.slice(0, 4).join('; ') + (v.errors.length > 4 ? `; ${v.errors.length - 4} more` : ''),
          fix: 'Each entry needs identifier (urn:air:<publisher>:<namespace>:<name>), displayName, type and exactly one of url or data (ARD v0.91 §4.2). "mcplane pack ard" writes a valid one.',
        }
      : { id: 'ard.manifest', level: 'pass', title: 'The ARD manifest is valid', detail: `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}${v.warnings.length ? `; ${v.warnings.join('; ')}` : ''}` },
  );
  // Lighthouse reads the Agentmap target, else ai-catalog.json (a rel="ai-catalog" link in the page also counts; not read here).
  const lhUrl = f.agentmap?.url ?? (f.legacy !== undefined ? `${f.origin}${LEGACY_PATH}` : null);
  const lhDoc = f.agentmap ? f.agentmap.doc : f.legacy;
  if (!lhUrl) {
    checks.push({
      id: 'ard.lighthouse',
      level: 'info',
      title: 'Lighthouse 13.5 can find the ARD manifest',
      detail: `no robots.txt Agentmap line and nothing at ${LEGACY_PATH}`,
      fix: `Add "Agentmap: ${where}" to robots.txt. Lighthouse 13.5 reads an Agentmap line, a rel="ai-catalog" link or ${LEGACY_PATH}, and otherwise marks its ARD audit not applicable.`,
    });
  } else {
    const lh = validateArd(lhDoc);
    const bad = lhDoc === undefined ? [`nothing usable at ${lhUrl}`] : [...lh.errors, ...lh.lighthouse];
    checks.push(
      bad.length
        ? {
            id: 'ard.lighthouse',
            level: 'warn',
            title: 'Lighthouse 13.5 accepts the ARD manifest',
            detail: `${lhUrl}: ${bad.slice(0, 4).join('; ')}`,
            fix: 'Lighthouse validates against the older ai-catalog schema: specVersion "1.0", nothing but specVersion, host and entries at the top level, and host limited to displayName, identifier, documentationUrl, logoUrl and trustManifest. ARD v0.91 ignores extra top-level members, so meeting both costs nothing.',
          }
        : { id: 'ard.lighthouse', level: 'pass', title: 'Lighthouse 13.5 accepts the ARD manifest', detail: lhUrl },
    );
  }
  const mine = entries.find((e) => describesServer(e, serverUrl));
  checks.push(
    mine
      ? { id: 'ard.entry', level: 'pass', title: 'The ARD manifest lists this MCP server', detail: mine.identifier }
      : { id: 'ard.entry', level: 'info', title: 'The ARD manifest lists this MCP server', detail: `no entry points at ${serverUrl} or its server card`, fix: `Add an entry with type ${MCP_CARD_TYPE}. "mcplane pack ard" writes one.` },
  );
  return checks;
}

const getJson = async (url: string): Promise<unknown> => {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'mcplane' }, redirect: 'follow', signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!r?.ok) return undefined;
  try {
    return JSON.parse(await r.text()) ?? undefined;
  } catch {
    // A catch-all page that answers every path with HTML isn't a manifest.
    return undefined;
  }
};

/** Looks on the website's origin, then the MCP server's. */
export async function ardChecks(m: Manifest): Promise<Check[]> {
  const origins = [...new Set([m.links?.website, m.server.url].filter((u): u is string => !!u).map((u) => new URL(u).origin))];
  for (const origin of origins) {
    const [ard, legacy, robots] = await Promise.all([
      getJson(`${origin}${ARD_PATH}`),
      getJson(`${origin}${LEGACY_PATH}`),
      fetch(`${origin}/robots.txt`, { headers: { 'user-agent': 'mcplane' }, signal: AbortSignal.timeout(10_000) })
        .then((r) => (r.ok ? r.text() : ''))
        .catch(() => ''),
    ]);
    if (ard === undefined && legacy === undefined) continue;
    const line = robots.match(/^\s*Agentmap:\s*(\S+)/im)?.[1];
    let agentmap: ArdFetched['agentmap'];
    if (line) {
      const url = new URL(line, origin).href;
      agentmap = { url, doc: url === `${origin}${ARD_PATH}` ? ard : url === `${origin}${LEGACY_PATH}` ? legacy : await getJson(url) };
    }
    return ardFindings(m.server.url, { origin, ard, legacy, agentmap });
  }
  return [
    {
      id: 'ard.path',
      level: 'info',
      title: 'The ARD manifest is at /.well-known/ard.json',
      detail: `nothing at ${origins.map((o) => `${o}${ARD_PATH}`).join(' or ')}`,
      fix: '"mcplane pack ard" writes one. ARD (Agentic Resource Discovery, v0.91, a proposal) is how agents and registries find what a domain offers, and Lighthouse 13.5 audits it.',
    },
  ];
}

/**
 * A manifest for /.well-known/ard.json that Lighthouse 13.5 also accepts: one entry for the MCP
 * server, pointing at its server card when there is one. representativeQueries come from your
 * prompts and test cases, capabilities from your tool names.
 */
export function ardManifest(m: Manifest, o: { tools?: string[]; serverCard?: string } = {}) {
  const publisher = new URL(m.links?.website ?? m.server.url).hostname.replace(/^www\./, '');
  const queries = [...new Set([...(m.prompts ?? []), ...(m.tests?.positive ?? []).map((t) => t.prompt)].map((q) => q.trim()).filter((q) => q && q.length <= 160))].slice(0, 5);
  const tools = o.tools?.length ? o.tools : [...new Set((m.tests?.positive ?? []).flatMap((t) => t.tools))];
  const description = m.oneLiner || m.description?.split(/\n\s*\n/)[0];
  return {
    specVersion: '1.0',
    host: { displayName: m.author?.name || m.title, ...(m.links?.docs ? { documentationUrl: m.links.docs } : {}), ...(m.icon ? { logoUrl: m.icon } : {}) },
    entries: [
      {
        identifier: `urn:air:${publisher}:server:${m.name}`,
        displayName: m.title,
        type: MCP_CARD_TYPE,
        url: o.serverCard ?? m.server.url,
        ...(description ? { description } : {}),
        ...(queries.length ? { representativeQueries: queries } : {}),
        ...(tools.length ? { capabilities: tools } : {}),
        ...(m.category ? { tags: [m.category] } : {}),
        ...(m.version ? { version: m.version } : {}),
      },
    ],
  };
}
