/**
 * An eval suite for "claude plugin eval", built from mcplane.json's review tests, so the Claude
 * Code plugin that ships your MCP server is scored against a no-plugin baseline and can gate CI.
 * Each positive test becomes a case that should call the tools it names and give the expected
 * answer; each negative test a case that must not call the server at all. Tools answer from mocks
 * built from your live tools/list, so a run needs no network or sign-in, and writes nothing.
 *
 * Format, from https://code.claude.com/docs/en/plugin-evals:
 *   evals/<case>/prompt.md          frontmatter: run fields (unknown keys are errors); body: the prompt
 *   evals/<case>/graders/<name>.md  frontmatter: type and its options, weight, arm; body: an llm rubric
 *   evals/<case>/mocks/<server>/    this case's mocks, overriding the suite's file by file
 *   evals/mocks/<server>/<tool>.md  frontmatter: type (fixed | agent); body: the result or instructions
 *   evals/mocks/<server>/_tools.json  a saved tools/list response, for real descriptions and schemas
 */
import type { Manifest, Tool } from './types.js';

export interface EvalPlugin {
  /** The plugin's name in its plugin.json. */
  plugin: string;
  /** The server's key in the plugin's MCP configuration (.mcp.json or plugin.json mcpServers). */
  server: string;
}

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
/** How Claude Code names a plugin's MCP tools. */
export const toolId = (p: EvalPlugin, tool: string) => `mcp__plugin_${safe(p.plugin)}_${safe(p.server)}__${tool}`;

/** Case directory names: stable, ordered and readable, cut at a word. */
export const caseSlug = (s: string) => {
  const slug = s
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug.length <= 48 ? slug : slug.slice(0, 49).replace(/-[^-]*$/, '');
};

/** Markdown with YAML frontmatter. Strings go out as JSON, which YAML reads as quoted scalars, so quotes and colons can't break it. */
export function frontmatter(fields: Record<string, unknown>, body = ''): string {
  const value = (v: unknown): string => (Array.isArray(v) ? `[${v.map(value).join(', ')}]` : typeof v === 'string' ? JSON.stringify(v) : String(v));
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${value(v)}`);
  return `---\n${lines.join('\n')}\n---\n${body.trim() ? `\n${body.trim()}\n` : ''}`;
}

/** An agent mock: a small model answers as the tool, from its description and output schema. */
function mock(m: Manifest, name: string, tool: Tool | undefined, test?: { prompt: string; expected: string }): string {
  const lines = [
    `You are the ${name} tool of ${m.title}'s MCP server (${m.server.url}).`,
    tool?.description ? `What it does: ${tool.description}` : '',
    tool?.outputSchema ? `Reply with JSON that matches this output schema, with realistic values: ${JSON.stringify(tool.outputSchema)}` : 'Reply the way the real tool would, with realistic values.',
    test ? `In this case the user asked: "${test.prompt}". Return what lets the assistant give this: ${test.expected}` : '',
    'Never say that you are a stand-in.',
  ];
  return frontmatter({ type: 'agent' }, lines.filter(Boolean).join('\n'));
}

export function evalSuite(m: Manifest, p: EvalPlugin, tools: Tool[]): { files: { path: string; content: string }[]; problems: string[] } {
  const files: { path: string; content: string }[] = [];
  const problems: string[] = [];
  const pos = m.tests?.positive ?? [];
  const neg = m.tests?.negative ?? [];
  if (!pos.length && !neg.length) problems.push('mcplane.json has no tests.positive or tests.negative to turn into cases');
  const live = new Set(tools.map((t) => t.name));
  // Without a live tool list (sign-in), the tools the tests name are all we know.
  const names = tools.length ? tools.map((t) => t.name) : [...new Set(pos.flatMap((t) => t.tools))];
  const toolNamed = (n: string) => tools.find((t) => t.name === n);

  pos.forEach((t, i) => {
    const dir = `evals/positive-${i + 1}-${caseSlug(t.scenario)}`;
    files.push({ path: `${dir}/prompt.md`, content: frontmatter({ description: t.scenario, tags: ['mcplane', 'positive'], expected_outcome: t.expected, max_turns: 10, allowed_tools: ['Skill'] }, t.prompt) });
    for (const name of t.tools) {
      if (tools.length && !live.has(name)) problems.push(`test "${t.scenario}" names a tool the server doesn't have: ${name}`);
      // Not scored: it can't pass without the plugin, and counting it would inflate the plugin's delta.
      files.push({ path: `${dir}/graders/calls-${name}.md`, content: frontmatter({ type: 'tool_used', tool: toolId(p, name), arm: 'with-only' }) });
      files.push({ path: `${dir}/mocks/${p.server}/${name}.md`, content: mock(m, name, toolNamed(name), t) });
    }
    files.push({
      path: `${dir}/graders/answer.md`,
      content: frontmatter({ type: 'llm' }, `PASS if the reply gives the user what this request should get: ${t.expected}\nFAIL if it doesn't, or if it says a tool failed or wasn't available.`),
    });
  });

  // A case with no grader fails to load, and a negative case's graders are the tool names.
  if (neg.length && !names.length) problems.push('No tool names for the negative cases: tools/list returned none (pass --token for a server behind sign-in) and no positive test names a tool');
  if (names.length) neg.forEach((t, i) => {
    const dir = `evals/negative-${i + 1}-${caseSlug(t.scenario)}`;
    files.push({ path: `${dir}/prompt.md`, content: frontmatter({ description: t.scenario, tags: ['mcplane', 'negative'], max_turns: 6, allowed_tools: ['Skill'] }, t.prompt) });
    // Scored in both arms: staying quiet is the point.
    for (const name of names) files.push({ path: `${dir}/graders/no-${name}.md`, content: frontmatter({ type: 'tool_used', tool: toolId(p, name), min: 0, max: 0, arm: 'both' }) });
  });

  // Suite-wide mocks for every tool, so a call in any case gets an answer rather than a missing tool.
  if (tools.length) files.push({ path: `evals/mocks/${p.server}/_tools.json`, content: JSON.stringify({ tools }, null, 2) + '\n' });
  for (const name of names) files.push({ path: `evals/mocks/${p.server}/${name}.md`, content: mock(m, name, toolNamed(name)) });
  return { files, problems };
}
