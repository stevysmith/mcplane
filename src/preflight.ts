import { tls12Check } from './checks/tls.js';
import { preflight as core, type PreflightResult } from './core.js';
import type { Manifest, StoreId } from './types.js';

export type { PreflightResult } from './core.js';

/** Preflight with everything Node can check, the TLS 1.2 handshake included. */
export function preflight(m: Manifest, opts: { stores?: StoreId[]; register?: boolean; token?: string } = {}): Promise<PreflightResult> {
  return core(m, { ...opts, extraChecks: [tls12Check] });
}
