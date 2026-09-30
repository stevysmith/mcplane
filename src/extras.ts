/**
 * The fastlane ideas, for agent-era stores:
 *   lanes  named workflows in mcplane.json ("mcplane release")
 *   try    install links for every client, like pilot for TestFlight testers
 */
import { spawnSync } from 'node:child_process';
import type { Manifest } from './types.js';

/* ---------------- lanes ---------------- */

export const DEFAULT_LANES: Record<string, string[]> = {
  // Fast checks for CI on every push or deploy.
  check: ['preflight', 'drift --ci'],
  // On a schedule: listings that went stale or never appeared.
  watch: ['listings --ci', 'drift --ci'],
  // Everything for a release: checks, packs, the stores that can be automated, then your hand-offs.
  release: [
    'preflight',
    'drift',
    'pack chatgpt',
    'pack claude-connectors',
    'publish mcp-registry',
    'publish grok',
    'handoff: Upload the ZIP in .mcplane/packs/chatgpt/ at platform.openai.com/plugins, add reviewer credentials and hint justifications (see chatgpt.md), make the attestations and submit. Then: mcplane submitted chatgpt --app-id <asdk_app_…>',
    'handoff: Paste .mcplane/packs/claude-connectors.md into claude.ai/directory/manage/new, make the compliance statements yourself and submit. Then: mcplane submitted claude-connectors',
  ],
};

export function lanes(m: Manifest): Record<string, string[]> {
  return { ...DEFAULT_LANES, ...(m.lanes ?? {}) };
}

/**
 * Runs a lane step by step. A step that fails stops the lane unless it starts
 * with "?" (optional). "handoff:" steps are what only a person can do: policy
 * statements, the final submit. They're collected and shown at the end.
 */
export function runLane(name: string, steps: string[], passthrough: string[]): number {
  const handoffs: string[] = [];
  const me = process.argv[1];
  for (const raw of steps) {
    if (raw.startsWith('handoff:')) {
      handoffs.push(raw.slice(8).trim());
      continue;
    }
    const optional = raw.startsWith('?');
    const step = optional ? raw.slice(1).trim() : raw.trim();
    console.log(`\n▸ mcplane ${step}`);
    const r = spawnSync(process.execPath, [...process.execArgv, me, ...step.split(/\s+/), ...passthrough], { stdio: 'inherit' });
    if (r.status !== 0 && !optional) {
      console.log(`\nLane "${name}" stopped at "${step}". Fix that, then run "mcplane ${name}" again.`);
      return r.status ?? 1;
    }
  }
  if (handoffs.length) {
    console.log('\nYour turn (only you can do these):');
    handoffs.forEach((h, i) => console.log(`  ${i + 1}. ${h}`));
  }
  console.log(`\nLane "${name}" done.`);
  return 0;
}

/* ---------------- try ---------------- */

export function tryLinks(m: Manifest): { client: string; how: string }[] {
  const name = m.name;
  const url = m.server.url;
  const cursorConfig = Buffer.from(JSON.stringify({ url })).toString('base64');
  const vscode = encodeURIComponent(JSON.stringify({ name, type: 'http', url }));
  return [
    { client: 'Claude Code', how: `claude mcp add --transport http ${name} ${url}` },
    { client: 'Cursor', how: `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${cursorConfig}` },
    { client: 'VS Code', how: `vscode:mcp/install?${vscode}` },
    { client: 'Claude (web, desktop)', how: `Settings → Connectors → Add custom connector → ${url}` },
    { client: 'ChatGPT', how: `Turn on developer mode (Settings → Apps → Advanced), then Plugins → Add → Create MCP App → ${url}${m.server.auth === 'oauth' ? ' (OAuth)' : ' (No authentication)'}` },
  ];
}
