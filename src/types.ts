export type Level = 'pass' | 'warn' | 'fail' | 'skip';

export interface Check {
  id: string;
  level: Level;
  title: string;
  /** What we found. */
  detail?: string;
  /** How to fix it, when it isn't a pass. */
  fix?: string;
  /** The stores this matters for; empty means all. */
  stores?: StoreId[];
}

export type StoreId =
  | 'mcp-registry'
  | 'chatgpt'
  | 'claude-connectors'
  | 'claude-plugins'
  | 'cursor'
  | 'grok'
  | 'docker'
  | 'muse'
  | 'smithery'
  | 'glama'
  | 'cline'
  | 'lobehub'
  | 'awesome-mcp-servers';

export const STORE_NAMES: Record<StoreId, string> = {
  'mcp-registry': 'Official MCP Registry',
  chatgpt: 'ChatGPT',
  'claude-connectors': 'Claude connectors',
  'claude-plugins': 'Claude plugins',
  cursor: 'Cursor Marketplace',
  grok: 'Grok plugins',
  docker: 'Docker MCP Catalog',
  muse: 'Muse connectors',
  smithery: 'Smithery',
  glama: 'Glama',
  cline: 'Cline MCP Marketplace',
  lobehub: 'LobeHub Market',
  'awesome-mcp-servers': 'awesome-mcp-servers',
};

export interface Manifest {
  $schema?: string;
  name: string;
  title: string;
  subtitle?: string;
  oneLiner?: string;
  description?: string;
  category?: string;
  server: { url: string; auth?: 'none' | 'oauth' };
  repository?: string;
  author?: { name: string; url?: string };
  links?: { website?: string; support?: string; privacy?: string; terms?: string; docs?: string };
  icon?: string;
  prompts?: string[];
  stores?: StoreId[];
  /** Review test cases: ChatGPT wants exactly 5 positive and 3 negative. */
  tests?: {
    positive?: { scenario: string; prompt: string; tools: string[]; expected: string }[];
    negative?: { scenario: string; prompt: string }[];
  };
  /** Hand-written ChatGPT hint justifications, per tool; they replace mcplane's drafts. */
  justifications?: Record<string, { readOnly?: string; openWorld?: string; destructive?: string }>;
  /** Your server's version, for the MCP Registry and your own records. */
  version?: string;
  /** MCP Registry overrides: reverse-DNS name (io.github.<owner>/<name> by default), description (100 max), file path. */
  registry?: { name?: string; description?: string; file?: string };
  /** Grok marketplace entry overrides. */
  grok?: { description?: string; category?: string; keywords?: string[]; domains?: string[] };
  /** Named workflows, run with "mcplane <lane>": each step is a command line without "mcplane". */
  lanes?: Record<string, string[]>;
  /** How reviewers get in, for servers behind sign-in. Never put the password here; say where it lives. */
  reviewerAccess?: string;
}

export interface Tool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
  outputSchema?: unknown;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}
