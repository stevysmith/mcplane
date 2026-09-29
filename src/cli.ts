#!/usr/bin/env node
import { writeFile, access } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { MANIFEST_FILE, draftManifest, loadManifest } from './manifest.js';
import { VERSION } from './version.js';
import { preflight } from './preflight.js';
import { printPreflight } from './report.js';
import { STORE_NAMES, type Manifest, type StoreId } from './types.js';
import { recordDecision, recordSubmitted, status } from './submissions.js';
import { chatgptPack, claudePack, simplePack, writePack } from './packs.js';
import { drift, printDrift, takeSnapshot } from './drift.js';
import { publish } from './publish.js';
import { lanes, pull, runLane, tryLinks } from './extras.js';
import { fleet, fleetRun, printFleet } from './fleet.js';

const HELP = `mcplane: fastlane for MCP servers

Usage
  mcplane init --url <mcp url>        Create mcplane.json from your live server
  mcplane preflight [--store <id>]... Check against every store's rejection causes
      --url <mcp url>                 Check a server without a manifest
      --json                          Machine-readable output (exit 1 on blockers)
      --verbose                       List passing checks too
      --register                      Also test OAuth client registration (writes test clients)
      --token <token>                 Access token for servers behind sign-in (or MCPLANE_TOKEN)
  mcplane submitted <store>           Record a submission and log it to Review Times
      --date YYYY-MM-DD --kind new|update|resubmission --version x.y.z
      --app-id asdk_app_...           ChatGPT: your app id, so its draft date is checked
      --private                       Keep it local; don't log to Review Times
  mcplane decided <store> approved|rejected|withdrawn [--date YYYY-MM-DD]
  mcplane status                      Every submission, how long it's waited, and the store's typical wait
  mcplane pack <store>                Write a submission pack to .mcplane/packs (chatgpt, claude-connectors, cursor, muse)
  mcplane drift [--store <id>]...     What changed since each store saw your server, and what each needs
      --ci                            Exit 1 when a store needs a new version or an edit
  mcplane baseline <store> [--version x.y.z]   Record a listing that's already live as the drift baseline
  mcplane publish <store> [--yes]     Publish where the store allows it (mcp-registry, grok); dry run without --yes
  mcplane try                         Install links for every client, for you and your testers
  mcplane pull                        Compare your live public listings with mcplane.json
  mcplane lanes                       List lanes; run one with "mcplane <lane>" (built in: check, release)
  mcplane fleet [--root <dir>]        Every project under a folder: blockers, store updates needed, reviews waiting
      --quick                         Skip the live checks; just submissions
  mcplane fleet run <command...>      Run any mcplane command in every project (e.g. fleet run publish mcp-registry --yes)
  mcplane mcp                         Run as an MCP server over stdio (claude mcp add mcplane -- npx -y mcplane mcp)

Stores: ${Object.keys(STORE_NAMES).join(', ')}
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  // Everything after "fleet run" belongs to the command being run, so it's passed through untouched.
  if (cmd === 'fleet' && rest[0] === 'run') {
    const i = rest.indexOf('--root');
    const root = i > 0 ? rest[i + 1] : process.cwd();
    const args = i > 0 ? [...rest.slice(1, i), ...rest.slice(i + 2)] : rest.slice(1);
    if (!args.length) throw new Error('Which command? e.g. mcplane fleet run preflight');
    process.exitCode = await fleetRun(root, args);
    return;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      url: { type: 'string' },
      store: { type: 'string', multiple: true },
      json: { type: 'boolean' },
      verbose: { type: 'boolean' },
      register: { type: 'boolean' },
      token: { type: 'string' },
      date: { type: 'string' },
      kind: { type: 'string' },
      version: { type: 'string' },
      'app-id': { type: 'string' },
      private: { type: 'boolean' },
      ci: { type: 'boolean' },
      root: { type: 'string' },
      quick: { type: 'boolean' },
      yes: { type: 'boolean' },
    },
    allowPositionals: true,
  });
  const asStore = (v: string | undefined): StoreId => {
    if (!v || !(v in STORE_NAMES)) throw new Error(`Which store? One of: ${Object.keys(STORE_NAMES).join(', ')}`);
    return v as StoreId;
  };

  if (cmd === 'mcp') {
    const { serve } = await import('./mcp-server.js');
    await serve();
    return;
  }
  if (cmd === '--version' || cmd === '-v') {
    console.log(VERSION);
    return;
  }

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return;
  }

  if (cmd === 'init') {
    if (!values.url) throw new Error('mcplane init needs --url <your MCP server URL>');
    const exists = await access(MANIFEST_FILE).then(() => true, () => false);
    if (exists) throw new Error(`${MANIFEST_FILE} already exists.`);
    const m = await draftManifest(values.url);
    await writeFile(MANIFEST_FILE, JSON.stringify(m, null, 2) + '\n');
    console.log(`Wrote ${MANIFEST_FILE}. Fill in the blanks, then run "mcplane preflight".`);
    return;
  }

  if (cmd === 'preflight') {
    const m = values.url ? await draftManifest(values.url) : await loadManifest();
    const stores = (values.store ?? []) as StoreId[];
    for (const s of stores) if (!(s in STORE_NAMES)) throw new Error(`Unknown store "${s}". Stores: ${Object.keys(STORE_NAMES).join(', ')}`);
    const r = await preflight(m, { stores, register: values.register, token: values.token ?? process.env.MCPLANE_TOKEN });
    if (values.json) console.log(JSON.stringify(r, null, 2));
    else printPreflight(r, { verbose: values.verbose });
    process.exitCode = r.checks.some((c) => c.level === 'fail') ? 1 : 0;
    return;
  }

  if (cmd === 'submitted') {
    const m = await loadManifest();
    const store = asStore(positionals[0]);
    const kind = (values.kind ?? 'new') as 'new' | 'update' | 'resubmission';
    const { submission, note } = await recordSubmitted(m, store, { date: values.date, kind, version: values.version, appId: values['app-id'], share: !values.private, token: values.token ?? process.env.MCPLANE_TOKEN });
    console.log(`Recorded: ${STORE_NAMES[store]}, submitted ${submission.submittedOn}${submission.version ? ` (v${submission.version})` : ''}.`);
    console.log(note);
    return;
  }

  if (cmd === 'decided') {
    const store = asStore(positionals[0]);
    const outcome = positionals[1] as 'approved' | 'rejected' | 'withdrawn';
    if (!['approved', 'rejected', 'withdrawn'].includes(outcome)) throw new Error('Say how it went: approved, rejected or withdrawn.');
    const s = await recordDecision(store, outcome, values.date);
    console.log(`${STORE_NAMES[store]}: ${outcome} on ${s.decidedOn}, ${Math.round((Date.parse(s.decidedOn!) - Date.parse(s.submittedOn)) / 86_400_000)} days after submitting.`);
    return;
  }

  if (cmd === 'pack') {
    const m = await loadManifest();
    const store = asStore(positionals[0]);
    const token = values.token ?? process.env.MCPLANE_TOKEN;
    const pack = store === 'chatgpt' ? await chatgptPack(m, token) : store === 'claude-connectors' ? await claudePack(m, token) : await simplePack(m, store);
    const written = await writePack(pack);
    console.log(`Wrote ${written.join(', ')}`);
    if (pack.problems.length) {
      console.log('\nFix before submitting:');
      for (const p of pack.problems) console.log(`  ✗ ${p}`);
    }
    if (pack.todo.length) {
      console.log('\nThen:');
      for (const t of pack.todo) console.log(`  • ${t}`);
    }
    process.exitCode = pack.problems.length ? 1 : 0;
    return;
  }

  if (cmd === 'baseline') {
    const m = await loadManifest();
    const store = asStore(positionals[0]);
    const snap = await takeSnapshot(m, store, { version: values.version, state: 'live', token: values.token ?? process.env.MCPLANE_TOKEN });
    console.log(`Baseline for ${STORE_NAMES[store]}: ${snap.tools.length} tools${snap.repoSha ? `, repo at ${snap.repoSha.slice(0, 7)}` : ''}. "mcplane drift" now compares against this.`);
    return;
  }

  if (cmd === 'drift') {
    const m = await loadManifest();
    const stores = ((values.store as string[] | undefined)?.length ? values.store : m.stores ?? Object.keys(STORE_NAMES)) as StoreId[];
    const r = await drift(m, stores, { token: values.token ?? process.env.MCPLANE_TOKEN });
    if (values.json) console.log(JSON.stringify(r, null, 2));
    else printDrift(r);
    if (values.ci && r.items.some((i) => i.level === 'action')) process.exitCode = 1;
    return;
  }

  if (cmd === 'status') {
    const rows = await status();
    if (!rows.length) {
      console.log('No submissions recorded yet. After you submit, run "mcplane submitted <store>".');
      return;
    }
    if (values.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    for (const r of rows) {
      const s = r.submission;
      const state = s.status === 'waiting' ? `waiting ${r.days} day${r.days === 1 ? '' : 's'}` : `${s.status} after ${r.days} day${r.days === 1 ? '' : 's'}`;
      console.log(`${STORE_NAMES[s.store].padEnd(22)} ${s.submittedOn}  ${state}${s.version ? `  v${s.version}` : ''}`);
      if (r.typical && s.status === 'waiting') console.log(`${''.padEnd(22)} Store right now: ${r.typical}`);
    }
    return;
  }

  if (cmd === 'publish') {
    const m = await loadManifest();
    const store = asStore(positionals[0]);
    const r = await publish(m, store, { yes: values.yes });
    for (const l of r.lines) if (l) console.log(l);
    if (r.done && values.yes && (store === 'mcp-registry' || store === 'grok')) {
      const { note } = await recordSubmitted(m, store, { version: m.version, share: true }).catch(() => ({ note: '' }));
      if (note) console.log(note);
    }
    return;
  }

  if (cmd === 'fleet') {
    const rows = await fleet(values.root ?? process.cwd(), { checks: !values.quick, token: values.token ?? process.env.MCPLANE_TOKEN });
    if (values.json) console.log(JSON.stringify(rows, null, 2));
    else printFleet(rows);
    if (values.ci && rows.some((r) => r.error || r.blocking || r.driftActions?.length)) process.exitCode = 1;
    return;
  }

  if (cmd === 'try') {
    const m = await loadManifest();
    for (const t of tryLinks(m)) console.log(`${t.client.padEnd(22)} ${t.how}`);
    return;
  }

  if (cmd === 'pull') {
    const m = await loadManifest();
    const diffs = await pull(m);
    if (values.json) {
      console.log(JSON.stringify(diffs, null, 2));
      return;
    }
    for (const d of diffs) {
      if (!d.found) console.log(`${d.store}: not listed yet.`);
      else if (!d.fields.length) console.log(`${d.store}: matches mcplane.json.`);
      else {
        console.log(`${d.store}: live listing differs${d.url ? ` (${d.url})` : ''}`);
        for (const f of d.fields) console.log(`  ${f.field}\n    live:  ${f.live.slice(0, 160)}\n    yours: ${f.yours.slice(0, 160)}`);
      }
    }
    return;
  }

  const m = await loadManifest().catch(() => null);
  const all = m ? lanes(m) : lanes({ name: '', title: '', server: { url: '' } });
  if (cmd === 'lanes') {
    for (const [name, steps] of Object.entries(all)) console.log(`${name}: ${steps.map((s) => (s.startsWith('handoff:') ? '(you)' : s)).join(' → ')}`);
    return;
  }
  if (all[cmd]) {
    process.exitCode = runLane(cmd, all[cmd], values.token ? ['--token', values.token] : []);
    return;
  }

  throw new Error(`Unknown command "${cmd}". Run "mcplane help".`);
}

main().catch((e) => {
  console.error(`mcplane: ${(e as Error).message}`);
  process.exitCode = 2;
});
