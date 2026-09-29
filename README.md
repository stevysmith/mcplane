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
! A small icon is available for ChatGPT's dialogs [ChatGPT]
    28 KB
    ChatGPT's icon upload in developer mode caps at 10 KB. Export an 8-bit PNG.
✓ 15 checks passed (--verbose to list them)

2 blocking, 1 to review.
```

## Why

An MCP server now has a dozen places to be listed: ChatGPT, Claude, Cursor, Grok, Muse, the official MCP Registry, Docker, Smithery and the directories that read from them. Each has its own form, its own rules and its own idea of what an update is. Most rejections are for the same few mechanical things, and each one costs you days in the queue. With one app that's annoying. With seventeen you stop shipping.

iOS had the same problem in 2014. fastlane fixed it by putting your metadata in the repo, checking it before Apple could reject it, and turning every release into one command. mcplane does that for agent-era stores.

An agent with a browser could fill in a form. It can't tell you that your DNS will make ChatGPT's reviewer time out, that a hint needs a justification you haven't written, or which of your seventeen listings went stale on Tuesday. That's the part mcplane does.

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
    chatgpt: Hints changed: send_alert
    claude-connectors: listing doesn't show: forecast_hourly (ask the review team to resync)

3 projects, 2 need attention.
```

`mcplane fleet run <command>` runs any command in every project, e.g. `mcplane fleet run publish mcp-registry --yes`.

## What it does per store

| Store | How mcplane gets you there | Keeping it current |
|---|---|---|
| Official MCP Registry | **Publishes**: writes `server.json`, runs `mcp-publisher`, signs in with GitHub OIDC in Actions. Glama and PulseMCP import from it; GitHub's MCP gallery (VS Code) syncs it after a one-time manual onboarding | Versions can't change: bump, or a prerelease like `1.2.0-1` for listing-only edits. mcplane checks what's already published |
| Grok plugins | **Publishes**: opens the pull request to `xai-org/plugin-marketplace`, validated with xAI's own scripts | Opens a pin-bump PR when xAI's daily bump lags |
| ChatGPT | **Prepares** `chatgpt-app-submission.json` for the portal's import: listing, tools, hint justifications, 5+3 tests | Tool changes roll out after OpenAI's automated checks. Listing text and hint justifications need a new version, and drift says when |
| Claude connectors | **Prepares** every field of the directory form | Tool changes are live on deploy; listing edits (tool names included) are reviewed |
| Claude plugins | **Prepares** and checks the plugin repo | The portal tracks your branch; drift tells you a new version is waiting for review |
| Cursor | **Prepares** and checks the plugin repo | Pinned to the commit first added; drift flags when you've moved on |
| Muse | **Prepares** the form | Flags changes |
| awesome-remote-mcp-servers | The three-line entry with your Glama connector badge and auth marker, ready for the PR | |
| Cline, Glama, LobeHub, Smithery, Docker, awesome-mcp-servers | The prefilled issue, `glama.json`, CLI command or entry | |
| mcp.so, MCP Market, mcpservers.org, cursor.directory | `mcplane pack directories`: one sheet with every value to paste | |

**What stays with you, and why.** The ChatGPT and Claude portals have no submission API. Neither do most directories. They ask you to make statements about policy, data use and testing that only you can make. mcplane gets you to the final click with every field filled and every known rejection checked. It never signs in for you, never ticks attestations and never gets around a bot check. If your agent has browser tools, the **ship** prompt offers to fill the form from the pack while you make the statements and press submit.

## Preflight

Checks come from real rejections, most of them ours:

- **Server**: `initialize`, `tools/list` and `ping` work. An OAuth server that initializes without a token also lists its tools without one (the half-way state leaves a new ChatGPT connector stuck on "no actions available"). Unknown methods return `-32601` (OpenAI's tool scan probes `server/discover` and gives up on a crash). The URL works with a trailing slash. CORS preflight answers. Automated clients aren't blocked by a bot filter. A TLS 1.2 client connects. DNS doesn't advertise Encrypted ClientHello, which review proxies reset without a trace in your logs.
- **OAuth**: unauthenticated calls get `401` with `resource_metadata`. Protected-resource and authorization-server metadata resolve, and PKCE S256 is supported. With `--register`, Dynamic Client Registration is tested, including the `cursor://` and other native redirect schemes that locked out every desktop client for us.
- **Tools**: every tool has a title and explicit `readOnlyHint`, `destructiveHint` and `openWorldHint`, and the hints are consistent. Tools declare `outputSchema`. Descriptions don't instruct the model. Writes aren't authorised by a token passed through the chat (Anthropic rejected exactly that). Hints follow OpenAI's current definitions: `openWorldHint` for anything that reaches the public internet (read-only web search included), `destructiveHint` for messages that can't be unsent. No catch-all request tools, no tool names over 64 characters, no sensitive inputs, no upgrade or pricing copy.
- **Listing**: the icon is a square PNG of at least 512px behind a direct link, and `/favicon.ico` resolves. The privacy policy covers collection, retention and user controls. Support is a web page. Name, subtitle, one-liner, description and starter prompts fit each store's limits. Every test case uses tools the live server actually has. The ChatGPT domain challenge is served.
- **Plugin repo**: public, on GitHub, with `.claude-plugin/plugin.json`, and no root `SKILL.md` shadowing the plugin's skills. Grok plugins come from an organisation.

`--json` for machines; exit code 1 when something blocks.

Preflight also lists what no script can see and that has still cost real submissions. For example: a reviewer account a stranger can actually use (not your Google login, email already confirmed, no 2FA), and a safe target for write tools so reviewers don't post to a real timeline.

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

Coverage decays quietly, so run it on a schedule (`--ci` exits 1 on a mismatch). `fleet` runs it for every project.

## Keeping listings current

Every store calls your live server, so fixes reach users on their own. What doesn't: listing text, tool names in Claude's listing, ChatGPT's hint justifications, registry versions and plugins pinned to a commit. Each store has different rules for these. When you record a submission, mcplane snapshots what the store is reviewing. `mcplane drift` compares your live server and `mcplane.json` against that snapshot and tells you what each store needs.

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
preflight [--store <id>]      Check against every store's rejection causes (--url, --json, --verbose, --register, --token)
pack <store>                  Write a submission pack to .mcplane/packs (or "pack directories")
publish <store> [--yes]       Publish where the store allows it; dry run without --yes
submitted <store>             Record a submission (--date, --kind, --version, --app-id, --private)
decided <store> <outcome>     approved | rejected | withdrawn
status                        Your submissions, days waited, each store's typical wait
drift [--ci]                  What each store needs since it last saw your server
baseline <store>              Mark an existing live listing as the drift baseline
listings [--ci]               Where you're listed, and whether what went live matches
try                           Install links for every client, for you and your testers
fleet [--root <dir>]          Every project at a glance (--quick, --json, --ci)
fleet run <command...>        Run a command in every project
lanes / <lane>                List lanes / run one
mcp                           Run as an MCP server over stdio
```

Servers behind sign-in: pass `--token` or set `MCPLANE_TOKEN` so tool checks can run.

## Use the checks in your own code

`mcplane/core` runs anywhere with `fetch` (Workers, Deno, Bun, Node):

```ts
import { draftManifest, preflight } from 'mcplane/core';
const report = await preflight(await draftManifest('https://mcp.example.com/mcp'));
```

It's what powers [reviewtimes.fyi/check](https://reviewtimes.fyi/check). The TLS 1.2 handshake needs a raw socket, so only the CLI runs that one.

## mcplane.json

One file describes your server and its listings. [`schema.json`](schema.json) gives editors completion and validation; `mcplane init` adds the `$schema` line. [`examples/mcplane.json`](examples/mcplane.json) is a complete one, from [Review Times](https://reviewtimes.fyi)' own ChatGPT and Claude submissions.

## fastlane, mapped

| fastlane | mcplane |
|---|---|
| `precheck` | `preflight` |
| `deliver` + metadata in the repo | `mcplane.json`, `pack`, `publish` |
| `download_metadata` | `listings`: reads what went live back and diffs it |
| `pilot` (TestFlight testers) | `try`: install links for every client |
| Fastfile lanes | `lanes` |
| `fastlane init` | `init`, and the **onboard** prompt that writes the listing for you |
| CI-first | `--ci` exit codes, JSON output, GitHub Action |
| New: agent-driven | the whole thing is an MCP server |
| New: drift | knows what each store needs when your server changes |

## Contributing

Stores and checks are small, separate modules. To add a store: add its id to `src/types.ts`, its rules to `src/drift.ts`, a pack or publisher in `src/packs.ts` or `src/publish.ts`, and a row above. To add a check: a function in `src/checks/`, with the rejection it prevents in the `fix` text. The best contributions are rejections you've had. Open an issue with what the reviewer said.

MIT licensed.
