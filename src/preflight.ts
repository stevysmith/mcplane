import { pluginChecks } from './checks/plugin.js';
import { tls12Check } from './checks/tls.js';
import { preflight as core, type PreflightResult } from './core.js';
import type { Manifest, StoreId } from './types.js';

export type { PreflightResult } from './core.js';

/**
 * Preflight with everything Node can check: the TLS 1.2 handshake, and, given the folder holding mcplane.json,
 * the Claude plugin's own files.
 */
export async function preflight(m: Manifest, opts: { stores?: StoreId[]; register?: boolean; token?: string; dir?: string; museToken?: string } = {}): Promise<PreflightResult> {
  const r = await core(m, { ...opts, extraChecks: [tls12Check] });
  if (opts.dir !== undefined && r.stores.includes('claude-plugins')) {
    const explicit = !!(opts.stores?.includes('claude-plugins') || m.stores?.includes('claude-plugins'));
    r.checks.push(...(await pluginChecks(m, opts.dir, { explicit })));
  }
  return r;
}
