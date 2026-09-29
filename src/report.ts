import { STORE_NAMES, type Check } from './types.js';
import type { PreflightResult } from './preflight.js';

const tty = process.stdout.isTTY;
const c = (code: string, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const MARK: Record<Check['level'], string> = { pass: c('32', '✓'), warn: c('33', '!'), fail: c('31', '✗'), skip: c('90', '-') };

export function printPreflight(r: PreflightResult, opts: { verbose?: boolean } = {}): void {
  const fails = r.checks.filter((x) => x.level === 'fail');
  const warns = r.checks.filter((x) => x.level === 'warn');
  console.log(c('1', `Preflight for ${r.stores.map((s) => STORE_NAMES[s]).join(', ')}`));
  console.log('');
  for (const x of r.checks) {
    if (x.level === 'pass' && !opts.verbose) continue;
    const where = x.stores?.length ? c('90', ` [${x.stores.map((s) => STORE_NAMES[s]).join(', ')}]`) : '';
    console.log(`${MARK[x.level]} ${x.title}${where}`);
    if (x.detail) console.log(c('90', `    ${x.detail}`));
    if (x.fix && x.level !== 'pass') console.log(`    ${x.fix}`);
  }
  const passed = r.checks.length - fails.length - warns.length;
  if (!opts.verbose && passed) console.log(c('32', `✓ ${passed} checks passed`) + c('90', ' (--verbose to list them)'));
  if (r.reminders.length) {
    console.log('');
    console.log(c('1', 'Check these yourself'));
    for (const t of r.reminders) console.log(`  • ${t}`);
  }
  console.log('');
  console.log(fails.length ? c('31', `${fails.length} blocking, ${warns.length} to review.`) : warns.length ? c('33', `No blockers, ${warns.length} to review.`) : c('32', 'Ready to submit.'));
}
