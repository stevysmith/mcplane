import { STORE_NAMES, type Check } from './types.js';
import type { PreflightResult } from './preflight.js';

const tty = process.stdout.isTTY;
const c = (code: string, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const MARK: Record<Check['level'], string> = { pass: c('32', '✓'), warn: c('33', '!'), fail: c('31', '✗'), skip: c('90', '-'), info: c('36', 'i') };

/** Readiness for the next MCP revision gets its own section, so it never reads as a store requirement. */
const isReadiness = (x: Check) => x.id.startsWith('readiness.');

function printChecks(checks: Check[], verbose: boolean | undefined, indent = ''): void {
  for (const x of checks) {
    if (x.level === 'pass' && !verbose) continue;
    const where = x.stores?.length ? c('90', ` [${x.stores.map((s) => STORE_NAMES[s]).join(', ')}]`) : '';
    console.log(`${indent}${MARK[x.level]} ${x.title}${where}`);
    if (x.detail) console.log(c('90', `${indent}    ${x.detail}`));
    if (x.fix && x.level !== 'pass') console.log(`${indent}    ${x.fix}`);
  }
}

export function printPreflight(r: PreflightResult, opts: { verbose?: boolean } = {}): void {
  const fails = r.checks.filter((x) => x.level === 'fail');
  const warns = r.checks.filter((x) => x.level === 'warn');
  const notes = r.checks.filter((x) => x.level === 'info');
  const main = r.checks.filter((x) => !isReadiness(x));
  const ready = r.checks.filter(isReadiness);
  console.log(c('1', `Preflight for ${r.stores.map((s) => STORE_NAMES[s]).join(', ')}`));
  console.log('');
  printChecks(main, opts.verbose);
  const passed = main.filter((x) => x.level === 'pass').length;
  if (!opts.verbose && passed) console.log(c('32', `✓ ${passed} checks passed`) + c('90', ' (--verbose to list them)'));
  if (ready.length) {
    console.log('');
    console.log(c('1', 'Readiness for MCP 2026-07-28') + c('90', ' (never blocking)'));
    printChecks(ready, opts.verbose, '  ');
    const ok = ready.filter((x) => x.level === 'pass').length;
    if (!opts.verbose && ok) console.log(`  ${c('32', `✓ ${ok} ready`)}`);
  }
  if (r.reminders.length) {
    console.log('');
    console.log(c('1', 'Check these yourself'));
    for (const t of r.reminders) console.log(`  • ${t}`);
  }
  console.log('');
  const noteLine = notes.length ? `, ${notes.length} note${notes.length === 1 ? '' : 's'}` : '';
  console.log(fails.length ? c('31', `${fails.length} blocking, ${warns.length} to review${noteLine}.`) : warns.length ? c('33', `No blockers, ${warns.length} to review${noteLine}.`) : c('32', `Ready to submit${noteLine ? ` (${notes.length} note${notes.length === 1 ? '' : 's'})` : ''}.`));
}
