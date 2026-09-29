# mcplane

fastlane for MCP servers: describe your server once, check it against every
store's known rejection causes, publish where stores allow it, prepare the
rest, and track every review.

One npm package, two faces:

- `mcplane <command>`: a CLI for people and CI.
- `mcplane mcp`: a stdio MCP server, so Claude Code, Codex or Cursor can run
  the same commands ("check my MCP server is ready for the ChatGPT directory").

Open source (MIT). Every submission it records is logged to Review Times
(reviewtimes.fyi) with its exact date, so each developer's wait makes the
public numbers better, and `mcplane status` shows how their wait compares.

## Manifest: `mcplane.json`

One file in the repo, the equivalent of fastlane's metadata folder.

```json
{
  "$schema": "https://mcplane.dev/schema.json",
  "name": "review-times",
  "title": "Review Times",
  "subtitle": "See app store review times",
  "oneLiner": "Live review times for AI app, connector and plugin stores",
  "description": "…",
  "category": "developer-tools",
  "server": { "url": "https://reviewtimes.fyi/mcp", "auth": "none" },
  "repository": "https://github.com/stevysmith/review-times-plugin",
  "author": { "name": "Yume Studios", "url": "https://reviewtimes.fyi" },
  "links": {
    "website": "https://reviewtimes.fyi",
    "support": "https://reviewtimes.fyi/support",
    "privacy": "https://reviewtimes.fyi/privacy",
    "terms": "https://reviewtimes.fyi/terms",
    "docs": "https://reviewtimes.fyi/llms.txt"
  },
  "icon": "https://reviewtimes.fyi/icon-512.png",
  "prompts": ["How long is ChatGPT plugin review taking right now?"],
  "stores": ["mcp-registry", "chatgpt", "claude-connectors", "claude-plugins", "cursor", "grok", "docker", "muse", "smithery", "awesome-mcp-servers"]
}
```

## Commands

| Command | What it does |
|---|---|
| `mcplane init` | Writes `mcplane.json`, filling what it can from the live server (`initialize`, `tools/list`) and the repo |
| `mcplane preflight [--store x]` | Runs every check against the live server, DNS, icons and links; exits non-zero on blockers (for CI) |
| `mcplane pack <store>` | Writes a submission pack: every form field for that store, length-checked, plus test cases and the order to fill them |
| `mcplane publish <store>` | Publishes where the store allows it (registry CLI, GitHub pull requests); dry run by default |
| `mcplane submitted <store> [--date]` | Records a submission you made by hand; logs it to Review Times |
| `mcplane status` | Every store: submitted when, waiting how long, and the store's typical wait from Review Times |

## Stores (v0.1)

| Store | How it's reached | mcplane can |
|---|---|---|
| Official MCP Registry | `mcp-publisher` CLI / API | generate `server.json`, publish |
| Grok plugins | PR to xai-org/plugin-marketplace | generate entry, open PR |
| Docker MCP Catalog | PR to docker/mcp-registry | generate entry, open PR |
| awesome-mcp-servers | PR to punkpeye/awesome-mcp-servers | generate line, open PR |
| Smithery | `smithery mcp publish` | print command |
| ChatGPT | platform.openai.com (accepts a submission JSON upload) | pack |
| Claude connectors / plugins | claude.ai/directory/manage/new | pack |
| Cursor | cursor.com/marketplace/publish | pack |
| Muse | muse.ai/platform | pack |

Final clicks and policy attestations always stay with the developer.

## Preflight checks (each learned from a real rejection or near miss)

Server
- `initialize`, `tools/list`, `ping` succeed over streamable HTTP.
- Unknown methods return JSON-RPC -32601 at HTTP 200, not a 500 (OpenAI's scanner probes `server/discover` and aborts on a crash).
- Notifications get 202; `/mcp/` with a trailing slash works; CORS preflight answers.
- A TLS 1.2-only client connects.
- DNS: the HTTPS record doesn't advertise ECH (TLS-inspecting review proxies reset it; three ChatGPT rejections traced to this).

Tools
- Every tool has a `title` and explicit `readOnlyHint`, `destructiveHint`, `openWorldHint` (OpenAI asks for each to be justified; Anthropic requires title + hints).
- `outputSchema` declared (OpenAI recommends; results must then carry `structuredContent`).
- Descriptions contain no instructions about model behaviour or other tools (Anthropic's policy attestation).
- No write tool that authorises by a bearer token passed through the chat (Anthropic rejected exactly this).

Listing
- Icon: a direct PNG at least 512×512; `/favicon.ico` resolves (Anthropic's fallback).
- Privacy policy reachable and covers retention and user controls (OpenAI's requirement).
- Support is a URL, not only an email (OpenAI).
- Length limits: subtitle ≤ 30 (ChatGPT), one-liner ≤ 200 (Claude), description ≤ 2000, annotation justifications ≤ 200 (ChatGPT truncates silently).
- ChatGPT domain challenge (`/.well-known/openai-apps-challenge`) present when submitting there.

Auth (when `auth` is `oauth`), from Stacktree's eight ChatGPT rounds
- An unauthenticated call gets 401 with `WWW-Authenticate` pointing at `resource_metadata`, never 403 (a 403 reads as "unable to connect").
- `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` both resolve, on the MCP host itself, and agree with each other.
- Dynamic Client Registration returns 201 for ChatGPT's redirect URIs and for native schemes (`cursor://`, `grok://`): Stacktree rejected RFC 8252 schemes and locked out every native client.
- The authorize endpoint returns a working sign-in page, not a blank page or a marketing homepage (Stacktree's reviewer registered, then stalled at sign-in because the post-sign-in redirect was empty).
- CORS preflight on `/mcp` answers 204 with the right headers.

Content policy
- No upgrade, pricing or plan copy in tool titles or descriptions: OpenAI bans in-app upsells, "including freemium upsells".
- Tools that accept free-form content (HTML, documents, messages) are disclosed in the privacy policy with what's stored and for how long (Stacktree's "sensitive data" rejection).

Reviewer access (auth servers)
- A demo account on email and password, no 2FA, seeded with data that matches every test case. Re-check the seed right before submitting: a resolved feedback item broke Stacktree's test 5.

Plugin repositories (Claude plugins, Cursor, Grok)
- Public repo; `claude plugin validate` passes; no root `SKILL.md` shadowing the plugin's own skills.
- Grok: submitted from an organisation, not a personal account ("will be questioned").

Portal traps (in every pack)
- ChatGPT's "Submit for Review" gives no feedback for about 20 seconds; confirm status on the plugins list.
- Justification fields cut at 200 characters without warning; typed input can drop characters while the draft autosaves.
- A demo video recorded in developer mode is required, and must show the tools the tests use.

## Build order

1. Scaffold, manifest loader, `preflight` (server, tools, listing checks). Test against reviewtimes.fyi and api.stacktr.ee.
2. `submitted` + `status`, logging to Review Times.
3. `pack` for ChatGPT, Claude, Cursor, Muse.
4. `publish` for the registry and the PR stores.
5. `mcp` (stdio server exposing the same commands), README, npm publish.
