# mcplane

**fastlane for MCP servers.** mcplane checks your server against the reasons each store rejects submissions. It publishes wherever a store allows automation and prepares everything the form-based stores ask for. It keeps every listing in step with your live server. Run it as a CLI, in CI, or as an MCP server driven by your coding agent.

```sh
npx mcplane init --url https://mcp.example.com/mcp
npx mcplane preflight
```

No terminal handy? Paste your URL at [reviewtimes.fyi/check](https://reviewtimes.fyi/check).

```
✗ DNS does not advertise Encrypted ClientHello [ChatGPT]
    example.com has ech= in its HTTPS record
    Turn ECH off for this domain. TLS-inspecting review proxies reset ECH handshakes: three ChatGPT
    rejections traced back to this, with nothing in the server's logs.
✗ Every tool has a human-readable title [Claude connectors, Claude plugins]
    search_docs, fetch_page
    Add "title" (or annotations.title) to each tool. Anthropic rejects connectors without them.
! Reviewers can reach your sign-in page
    https://accounts.example.com/sign-in: Cloudflare challenge (cf-mitigated: challenge)
    A bot challenge or a 403 on the sign-in chain leaves the OAuth window blank for reviewers, who sign
    in from data-centre networks. Exempt the authorization endpoint, consent page and sign-in hosts …
✓ 15 checks passed (--verbose to list them)

2 blocking, 1 to review.
```

## Why

An MCP server now has a dozen places to be listed: ChatGPT, Claude, Cursor, Grok, Muse, Vercel Connect, the official MCP Registry, Docker, Smithery and the directories that read from them. Each has its own form, its own rules and its own idea of what an update is. Most rejections are for the same few mechanical things, and each one costs you days in the queue. With one app that's annoying. With seventeen you stop shipping.

iOS had the same problem in 2014. fastlane fixed it by putting your metadata in the repo, checking it before Apple could reject it, and turning every release into one command. mcplane does that for agent-era stores.

An agent with a browser could fill in a form. It can't tell you that your DNS will make ChatGPT's reviewer time out, that ChatGPT counts overwriting a page as destructive, or which of your seventeen listings went stale on Tuesday. That's the part mcplane does.

## Use it from your agent

mcplane is itself an MCP server, so the agent in your repo can do the work:

```sh
claude mcp add mcplane -- npx -y mcplane mcp          # Claude Code
codex mcp add mcplane -- npx -y mcplane mcp           # Codex
```

Cursor, VS Code and others: add a stdio server with command `npx` and args `["-y", "mcplane", "mcp"]`.

Then run the **onboard** prompt (`/mcp__mcplane__onboard` in Claude Code). The agent creates `mcplane.json` and reads your code. It writes the listing copy and the review test cases (ChatGPT wants exactly 5 positive and 3 negative), runs preflight and fixes what it can. The **ship** prompt takes it from there: check, pack, publish, and a short list of what's left for you.

Tools: `preflight`, `drift`, `pack`, `publish`, `record_submission`, `record_decision`, `submission_status`, `install_links`, `listings`, `init`, `fleet`. Every tool takes an optional `project` folder, so one mcplane serves all your apps. Annotations are honest: `publish` and `record_*` are marked open-world, and `publish` does nothing without `confirm: true`.

## Many apps

```sh
npx mcplane fleet --root ~/Projects
```

```
✓ Review Times             preflight clean · listed on mcp-registry, glama, chatgpt
✗ Invoice Bot              2 blocking · waiting on claude-connectors · listed on mcp-registry
✗ Weather Pro              1 store update needed · listed on mcp-registry, claude-connectors · 1 listing fix
    chatgpt: Listing text changed (description)
    claude-connectors: listing doesn't show: forecast_hourly (ask the review team to resync)

3 projects, 2 need attention.
```

`mcplane fleet run <command>` runs any command in every project, e.g. `mcplane fleet run publish mcp-registry --yes`.

## What it does per store

| Store | How mcplane gets you there | Keeping it current |
|---|---|---|
| Official MCP Registry | **Publishes**: writes `server.json`, runs `mcp-publisher`, signs in with GitHub OIDC in Actions. Glama and PulseMCP import from it; GitHub's MCP gallery (VS Code) syncs it after a one-time manual onboarding | Versions can't change: bump, or a prerelease like `1.2.0-1` for listing-only edits. mcplane checks what's already published |
| Grok plugins | **Publishes**: opens the pull request to `xai-org/plugin-marketplace`, validated with xAI's own scripts | Opens a pin-bump PR when xAI's daily bump lags |
| ChatGPT | **Builds the plugin ZIP** the portal uploads since DevDay: `plugin.json` (Agent Plugins format) with listing, icons, 5+3 tests, demo video, release notes and translations, plus `mcp.json` and your Agent Skills. Checked against the Agent Plugins 1.0.0 schema and OpenAI's submission rules | Tool changes, hints included, roll out after OpenAI's scans. Listing changes need a new ZIP and review, and drift says when |
| Claude connectors | **Prepares** every field of the directory form | Tool changes are live on deploy; listing edits (tool names included) are reviewed |
| Claude plugins | **Prepares** and checks the plugin repo | The portal tracks your branch; drift tells you a new version is waiting for review |
| Cursor | **Prepares** and checks the plugin repo | Pinned to the commit first added; drift flags when you've moved on |
| Muse | **Prepares** the form | Flags changes |
| Vercel Connect | **Checks** your OAuth discovery documents against Vercel's Required, Recommended and Optional tiers, and **prepares** Submit a Service: every field, the OAuth method as Connect will discover it, and the token test each OAuth method needs | Listing edits go back through review (Edit and Resubmit); tools aren't listed, so they can change freely |
| awesome-remote-mcp-servers | The three-line entry with your Glama connector badge and auth marker, ready for the PR | |
| Cline, Glama, LobeHub, Smithery, Docker, awesome-mcp-servers | The prefilled issue, `glama.json`, CLI command or entry | |
| mcp.so, MCP Market, mcpservers.org, cursor.directory | `mcplane pack directories`: one sheet with every value to paste | |

**What stays with you, and why.** The ChatGPT and Claude portals have no submission API. Neither do most directories. They ask you to make statements about policy, data use and testing that only you can make. mcplane gets you to the final click with every field filled and every known rejection checked. It never signs in for you, never ticks attestations and never gets around a bot check. If your agent has browser tools, the **ship** prompt offers to fill the form from the pack while you make the statements and press submit.

## Preflight

Checks come from real rejections, most of them ours:

- **Server**: `initialize`, `tools/list` and `ping` work. An OAuth server that initializes without a token also lists its tools without one (the half-way state leaves a new ChatGPT connector stuck on "no actions available"). Unknown methods return `-32601` (OpenAI's tool scan probes `server/discover` and gives up on a crash). The URL works with a trailing slash. CORS preflight answers. Automated clients aren't blocked by a bot filter. A TLS 1.2 client connects. DNS doesn't advertise Encrypted ClientHello, which review proxies reset without a trace in your logs.
- **OAuth**: unauthenticated calls get `401` with `resource_metadata`. Protected-resource and authorization-server metadata resolve, and PKCE S256 is supported. With `--register`, Dynamic Client Registration is tested, including the `cursor://` and other native redirect schemes that locked out every desktop client for us.
- **Sign-in chain**: plain GETs, the way a reviewer's browser goes: the authorization endpoint, the sign-in page it sends people to, and the identity-provider hosts that page loads. A bot challenge (`cf-mitigated: challenge`) or a 403 anywhere on it is flagged: every MCP check can pass while reviewers never reach your sign-in page. Nothing signs in and no client is registered, so an authorization server that wants a registered client stops the walk at its error page: name your sign-in pages in `server.signIn` (or `--sign-in <url>`) and they're checked too. A pass from your own network proves less than one from a cloud VM or CI.
- **Tools**: every tool has a title and explicit `readOnlyHint`, `destructiveHint` and `openWorldHint`, and the hints are consistent. Tools declare `outputSchema`. Descriptions don't instruct the model. Writes aren't authorised by a token passed through the chat (Anthropic rejected exactly that). Hints follow OpenAI's current definitions: `openWorldHint` for public or open-ended destinations (read-only web search included; connectivity alone doesn't decide it), `destructiveHint` for messages that can't be unsent and for overwriting, revoking access or deleting. No catch-all request tools, no tool names over 64 characters, no sensitive inputs, no upgrade or pricing copy.
- **Listing**: the icon is square and at least 512px behind a direct link (PNG, JPEG, WebP or SVG, measured from the bytes), and `/favicon.ico` resolves. The privacy policy covers collection, retention and user controls. Support is a web page. Name, subtitle, one-liner, description and starter prompts fit each store's limits, including the 1,024 characters the ChatGPT package allows for its root description. Every test case uses tools the live server actually has. The ChatGPT domain challenge is served.
- **Plugin repo**: public, on GitHub, with `.claude-plugin/plugin.json`, and no root `SKILL.md` shadowing the plugin's skills. Grok plugins come from an organisation.
- **Vercel Connect**: what its [For Service Providers](https://vercel.com/docs/connect/providers) page asks for, read from your discovery documents alone (nothing is registered). Required items block: metadata served as JSON (at the path-suffixed form when the issuer has a path), `token_endpoint`, `grant_types_supported`, and OAuth and OpenID Connect documents that agree. Recommended items warn: DCR or CIMD so Connect can create the client, a `token_endpoint_auth_methods_supported` it can use, PKCE S256, refresh tokens. Optional ones are notes: protected-resource metadata, `revocation_endpoint`, `scopes_supported`. What needs a real token (`expires_in`, refresh rotation, the `https://connect.vercel.com/callback` redirect) is on the list of things to check yourself.
- **ARD**: whether your domain publishes an [Agentic Resource Discovery](https://agenticresourcediscovery.org/spec/) manifest at `/.well-known/ard.json`, whether it's valid, whether it lists this server, and whether Lighthouse 13.5 (which still reads the older `/.well-known/ai-catalog.json`) accepts it.

`--json` for machines; exit code 1 when something blocks. A check at level `info` is a note: it never blocks and isn't counted as something to review.

Preflight also lists what no script can see and that has still cost real submissions. For example: a reviewer account a stranger can actually use (not your Google login, email already confirmed, no 2FA), and a safe target for write tools so reviewers don't post to a real timeline.

## Readiness for MCP 2026-07-28

The [2026-07-28 revision](https://modelcontextprotocol.io/specification/2026-07-28/changelog) drops the `initialize` handshake for per-request metadata and `server/discover`, requires `Mcp-Method` and `Mcp-Name` headers, and deprecates Dynamic Client Registration for Client ID Metadata Documents. Preflight reports how your server meets it in its own section. These checks never block: a warning means a 2026-07-28 client would fail against you today, a note means something deprecated or optional.

```
Readiness for MCP 2026-07-28 (never blocking)
  i Speaks MCP 2026-07-28
      legacy only: server/discover got HTTP 200, JSON-RPC -32601 Method not found: server/discover
  ! An initialize that offers 2026-07-28 is negotiated down
      initialize answered with "2026-07-28"
      2026-07-28 has no initialize handshake, so answering one with it tells the client you speak something you don't. …
  i CORS allows the Mcp-Method and Mcp-Name headers
      Access-Control-Allow-Headers: content-type, mcp-protocol-version, mcp-session-id, authorization
```

- **Era**: a 2026-07-28 `server/discover` gets a `DiscoverResult` (modern), a JSON-RPC error or a 4xx (legacy, and clients that speak both fall back to `initialize`), or a crash (a warning).
- **Negotiation**: an `initialize` offering `2026-07-28` is answered with a version you implement, not echoed back.
- **Headers**: requests carrying `Mcp-Method` and `Mcp-Name` work, and your CORS preflight allows them.
- **Authorization**: the metadata's `issuer` matches the URL it was fetched from (2026-07-28 clients must refuse it otherwise), `client_id_metadata_document_supported`, and RFC 9207 `authorization_response_iss_parameter_supported`.
- **MCP Events**: whether `events/list` answers. Events is a [draft](https://github.com/modelcontextprotocol/experimental-ext-triggers-events) from the Triggers and Events Working Group, not part of 2026-07-28, so this is only ever a note.

Servers behind sign-in need `--token` for the probes; the authorization checks run from the discovery documents either way.

## ARD manifest

`mcplane pack ard` writes `.mcplane/packs/ard/ard.json`: one entry for your server (`application/mcp-server-card+json`, pointing at your server card when you serve one), with representative queries from your prompts and tests and capabilities from your tool names. It validates against [ARD v0.91](https://agenticresourcediscovery.org/spec/) and against the older schema [Lighthouse 13.5](https://github.com/GoogleChrome/lighthouse/blob/v13.5.0/core/audits/agentic/ard-schema.js) audits. Serve it at `/.well-known/ard.json`, and either at `/.well-known/ai-catalog.json` too or from an `Agentmap:` line in robots.txt, which Lighthouse reads first. ARD is a proposal, so treat it as cheap insurance rather than a requirement.

## Plugin evals

If a Claude Code plugin ships your server, `mcplane pack claude-eval` turns your review tests into a suite for [`claude plugin eval`](https://code.claude.com/docs/en/plugin-evals), which scores the plugin against a no-plugin baseline. Each positive test becomes a case graded on the reply, with the tools it names as indicators; each negative test a case that must not call your server. Tools answer from mocks built from your live `tools/list`, so a run needs no network or sign-in and writes nothing. The plugin and server names come from the plugin repo (or `claudePlugin` in mcplane.json).

Copy `.mcplane/packs/claude-eval/evals/` into the plugin repo, then gate pull requests on it:

```yaml
# .github/workflows/plugin-eval.yml, in the plugin repo
on: [pull_request]
jobs:
  eval:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm install -g @anthropic-ai/claude-code
      - run: claude plugin eval . --trust-plugin --json results.json --threshold 0.8 --model claude-sonnet-5 --judge-model claude-haiku-4-5 --no-publish --max-cost-usd 5
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

It exits 1 when a case scores under the threshold or a case file doesn't load. Every run and every llm grader is a model call on your account.

## Where you're listed

```sh
mcplane listings
```

```
✗ Official MCP Registry        listed
    latest is v1.0.0, mcplane.json says v1.0.1
✓ Glama                        listed  (Imported from the registry. Claim it with glama.json so the score badge is yours.)
✗ Claude connectors            listed  (tier: community)
    listing doesn't show: forecast_hourly (ask the review team to resync)
· Cursor Marketplace           missing
? ChatGPT                      unknown  (OpenAI's directory can't be read automatically. Open your plugin page and compare.)
```

A form that returned 200 is a claim; the public record is the result. `listings` reads every store with an open record and compares it with your live server and `mcplane.json`:
- MCP Registry: versions, status, endpoint.
- Claude: the connectors directory feed, including the tool inventory synced at submission, which you can't edit yourself; and the community plugin mirror.
- Cursor and Grok.
- Glama's registry import.
- Both awesome lists and Docker's catalog.
- Vercel Connect's directory, from the agent-readable copy of [vercel.com/connect/browse](https://vercel.com/connect/browse) (it has no feed; if that copy stops parsing, mcplane says so and sends you to the page).

Coverage decays quietly, so run it on a schedule (`--ci` exits 1 on a mismatch). `fleet` runs it for every project.

## ChatGPT's plugin ZIP

Since DevDay (September 2026) ChatGPT takes a plugin ZIP. `mcplane pack chatgpt` builds it from `mcplane.json`: `plugin.json` in the Agent Plugins format, with listing, icons, the 5 positive and 3 negative test cases, demo video, release notes and translations, plus `mcp.json` and any Agent Skills you bundle. It checks the package first: `plugin.json` and `mcp.json` against the [Agent Plugins 1.0.0](https://agent-plugins.org) JSON Schemas, then OpenAI's submission rules: name and description lengths (1,024 characters for the root description), category, the four https URLs, at most 3 starter prompts, square icons of 48 to 4096 px in any of PNG, JPEG, WebP or SVG, brand-colour contrast.

```json
"chatgpt": {
  "demoVideo": "https://example.com/demo.mp4",
  "releaseNotes": "Adds hourly forecasts.",
  "capabilities": ["Search forecasts", "Compare cities"],
  "brandColor": "#2357C6",
  "logo": "assets/logo.png",
  "skills": "skills"
}
```

- **Icons** can be URLs or local files (relative to `mcplane.json`), so the package builds offline. `logo` defaults to `icon`, which stays a URL for the other stores.
- **Skills**: `skills` is a folder of skill folders, or a list of them, each with a `SKILL.md`. They go in the ZIP under `skills/` with their scripts, executable bits kept. mcplane checks what clients and OpenAI refuse: a `name` that doesn't match its folder, a description over 1,024 characters, front matter YAML can't read, a script the `SKILL.md` runs but the folder doesn't hold. Hidden files stay out. Skills are scanned at upload; `"skills": []` ships the server alone.
- **Behind sign-in**: the ZIP doesn't need your tool list, so `pack chatgpt` builds without `--token` and says what it couldn't check. `--tools <file>` takes a saved `tools/list` result instead.
- The ZIP is reproducible: entries are dated 1980-01-01 and carry Unix modes, so the same files give the same bytes.

What stays with you: upload the ZIP, enter reviewer credentials and make the attestations. Bump `version` for every upload. Tool changes don't need a new ZIP; OpenAI's scans pick them up, and `drift` tracks extension metadata (sidebar, panels, file viewers) as part of each tool.

**Annotation rules.** OpenAI's [plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines) now ask only for explicit `readOnlyHint`, `destructiveHint` and `openWorldHint` booleans on every tool; its automated review checks them, and you appeal if it flags one you believe is right. Justifications are no longer required, so the pack no longer drafts them: any you wrote in `mcplane.json` become optional appeal notes. Writes count as destructive unless they only add (overwriting, cancelling, revoking access and irreversible sends are all destructive, and an undo button doesn't change that), and preflight warns when a write that overwrites, revokes or deletes says `destructiveHint: false`. `openWorldHint` is about where a tool reaches, not whether it calls an API. A hint change is a note in `drift`, not an action: OpenAI re-checks annotations itself, so `drift --ci` doesn't fail on one.

## Demo video

ChatGPT's review asks for a video recorded in developer mode that shows the main use cases and tools, and it goes stale whenever your tools change. `mcplane demo` records it from your positive tests, the way fastlane's `snapshot` takes screenshots:

```sh
mcplane demo --only 1,2,3
```

On a Mac with the ChatGPT desktop app, it opens ChatGPT with a local debugging port and hides the sidebar. For each test it opens a new chat, @mentions your plugin (the developer-mode one, when two share the name), types the prompt, waits for the answer and opens the summary of tool calls. ffmpeg joins the scenes behind a title card, with each test's scenario as its caption, into `.mcplane/packs/chatgpt/demo.mp4`. Upload it where a reviewer can open it without signing in and set `chatgpt.demoVideo` to its URL.

It drives ChatGPT with your account, so:
- it lists the prompts and asks before it starts (`--yes` skips that), and marks tests that call tools which write;
- it records only while a test runs, with the sidebar (your chats and name) hidden;
- tool approvals are yours to click, unless you pass `--approve`, which clicks "Allow once" (never "Always allow");
- it quits ChatGPT afterwards so the debugging port doesn't stay open (`--keep-open` leaves it running);
- the chats stay in your history, and answers can draw on your ChatGPT memory, so watch the video before you share it.

`--plugin` names the plugin as ChatGPT shows it, `--work` records in Work mode and `--out` writes somewhere else. It needs ffmpeg (`brew install ffmpeg`). It finds its way around ChatGPT by the labels on buttons, so a ChatGPT release can break it; they're all in one table at the top of `src/demo.ts`.

## Keeping listings current

Every store calls your live server, so fixes reach users on their own. What doesn't: listing text, tool names in Claude's listing, registry versions and plugins pinned to a commit. Each store has different rules for these. When you record a submission, mcplane snapshots what the store is reviewing. `mcplane drift` compares your live server and `mcplane.json` against that snapshot and tells you what each store needs.

```sh
mcplane submitted chatgpt --version 1.2.0 --app-id asdk_app_…
mcplane drift          # later, after you change things
mcplane baseline claude-connectors   # for listings that were live before you used mcplane
```

Snapshots live in `.mcplane/snapshots` and are meant to be committed, so CI can catch drift. Submissions and packs stay local (mcplane writes the `.gitignore`).

## Lanes

Like fastlane's lanes: named workflows in `mcplane.json`.

```json
"lanes": {
  "check": ["preflight", "drift --ci"],
  "release": ["preflight", "drift", "pack chatgpt", "pack claude-connectors", "publish mcp-registry --yes", "?publish grok --yes",
              "handoff: Upload the ChatGPT JSON and submit, then: mcplane submitted chatgpt"]
}
```

`mcplane release` runs the steps in order and stops at the first failure. A `?` step may fail without stopping the lane. `handoff:` steps are listed at the end as your to-do. `check`, `watch` and `release` are built in.

## CI

```yaml
# .github/workflows/mcplane.yml
on: [push]
jobs:
  stores:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: stevysmith/mcplane@v0
        with:
          command: check   # preflight + drift --ci
```

And weekly, to catch listings that went stale:

```yaml
on:
  schedule: [{ cron: '0 9 * * 1' }]
jobs:
  listings:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: stevysmith/mcplane@v0
        with:
          command: watch   # listings --ci + drift --ci
```

Publishing to the MCP Registry from CI needs no secrets for `io.github.*` names:

```yaml
  release:
    runs-on: ubuntu-latest
    permissions: { id-token: write, contents: read }
    steps:
      - uses: actions/checkout@v4
      - run: |
          curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_linux_amd64.tar.gz" | tar xz mcp-publisher
          sudo mv mcp-publisher /usr/local/bin/
      - uses: stevysmith/mcplane@v0
        with:
          command: publish mcp-registry --yes
```

For a reverse-DNS name, set an `MCP_PRIVATE_KEY` secret and mcplane signs in with `login dns`.

## Review Times

`mcplane submitted` logs an anonymous report to [Review Times](https://reviewtimes.fyi), the public tracker of how long each store takes to review. The report holds the store, dates, the kind of submission and the public listing reference that lets it close itself when your listing appears. No code, names or email. `mcplane status` shows how long each of yours has waited next to each store's typical wait. `--private` (or `share: false`) keeps it local.

## Commands

```
init --url <mcp url>          Create mcplane.json from your live server
preflight [--store <id>]      Check against every store's rejection causes (--url, --json, --verbose, --register, --token, --sign-in)
pack <store>                  Write a submission pack to .mcplane/packs (or "pack directories", "pack ard", "pack claude-eval"; --tools)
publish <store> [--yes]       Publish where the store allows it; dry run without --yes
submitted <store>             Record a submission (--date, --kind, --version, --app-id, --private)
decided <store> <outcome>     approved | rejected | withdrawn
status                        Your submissions, days waited, each store's typical wait
drift [--ci]                  What each store needs since it last saw your server
baseline <store>              Mark an existing live listing as the drift baseline
listings [--ci]               Where you're listed, and whether what went live matches
try                           Install links for every client, for you and your testers
demo                          Record ChatGPT's review video from your positive tests (macOS; --only, --approve, --out)
fleet [--root <dir>]          Every project at a glance (--quick, --json, --ci)
fleet run <command...>        Run a command in every project
lanes / <lane>                List lanes / run one
mcp                           Run as an MCP server over stdio
```

Servers behind sign-in: pass `--token` or set `MCPLANE_TOKEN` so tool checks can run. Packs also take `--tools <file>`, a saved `tools/list` result.

## Use the checks in your own code

`mcplane/core` runs anywhere with `fetch` (Workers, Deno, Bun, Node):

```ts
import { draftManifest, preflight } from 'mcplane/core';
const report = await preflight(await draftManifest('https://mcp.example.com/mcp'));
```

It's what powers [reviewtimes.fyi/check](https://reviewtimes.fyi/check). The TLS 1.2 handshake needs a raw socket, so only the CLI runs that one.

## mcplane.json

One file describes your server and its listings. [`schema.json`](schema.json) gives editors completion and validation; `mcplane init` adds the `$schema` line. [`examples/mcplane.json`](examples/mcplane.json) is a complete one, from [Review Times](https://reviewtimes.fyi)' own ChatGPT and Claude submissions.


Each store can have its own listing text, the way fastlane keeps metadata per language. Anything you leave out falls back to the shared fields:

```json
"description": "Shows how long AI app stores are taking to review submissions…",
"listing": {
  "claude-connectors": { "description": "Ask Claude before you submit (\"How long is Claude plugin review taking?\")…" }
}
```

Packs, checks, `drift` and `listings` all use the right text for each store.

Store fields with no shared equivalent have their own blocks: `chatgpt` for the plugin ZIP (including its `logo` and `skills`), `grok` for the marketplace entry, and `vercelConnect` for a REST API target (`apiBase`), default OAuth `scopes` and an `apiKey` connection method. For OAuth servers, `server.signIn` lists the sign-in pages your consent screen uses, for the sign-in chain check.

## fastlane, mapped

| fastlane | mcplane |
|---|---|
| `precheck` | `preflight` |
| `deliver` + metadata in the repo | `mcplane.json`, `pack`, `publish`; for ChatGPT, one reproducible ZIP with your skills |
| `download_metadata` | `listings`: reads what went live back and diffs it |
| `pilot` (TestFlight testers) | `try`: install links for every client |
| `snapshot` (screenshots on every device) | `demo`: the review video, recorded in ChatGPT from your tests |
| Fastfile lanes | `lanes` |
| `fastlane init` | `init`, and the **onboard** prompt that writes the listing for you |
| CI-first | `--ci` exit codes, JSON output, GitHub Action |
| `scan` (tests in CI) | `pack claude-eval`: your review tests as a `claude plugin eval` suite, scored against a no-plugin baseline |
| New: agent-driven | the whole thing is an MCP server |
| New: drift | knows what each store needs when your server changes |
| New: readiness | how your server meets the next MCP revision (2026-07-28), before clients require it |
| New: discovery | `pack ard`: the ARD manifest agents and Lighthouse look for |

## Contributing

Stores and checks are small, separate modules. To add a store: add its id to `src/types.ts`, its rules to `src/drift.ts`, a pack or publisher in `src/packs.ts` or `src/publish.ts`, and a row above. To add a check: a function in `src/checks/`, with the rejection it prevents in the `fix` text. The best contributions are rejections you've had. Open an issue with what the reviewer said.

MIT licensed.
