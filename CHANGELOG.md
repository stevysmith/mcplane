# Changelog

## 0.8.0

Claude's plugin directory: its new automatic policy check (8 November 2026)
- `plugin.file-types` (blocks): from an organization Anthropic hasn't Verified, the directory refuses a version holding any file that isn't Markdown, text, JSON, YAML or a PNG, JPEG, GIF, WebP or ICO image, any file starting with `#!`, package manager files (package.json, lockfiles, .npmrc, pnpm-workspace.yaml) and text that isn't UTF-8 or holds NUL bytes ("Files outside the allowed types accepted only from Verified organizations"). A license, a README, .gitignore and the plugin's own icon may stay. The public pre-submission checklist is looser (it holds some binaries for a reviewer and allows SVG), but the portal refused Stacktree's version on these rules. Set `claudePlugin.verified` if your organization is Verified and it becomes a note.
- `plugin.credential-forward` (warning): a file that reads a credential from the user's machine (`$ACME_API_KEY` in a SKILL.md curl example, a script or plugin.json, or a key file in the home folder) and sends something to a server. The directory holds it for a reviewer (MCP_FORWARDS_CREDENTIAL_ENV), and an update that adds one the live version didn't have goes to a human instead of auto-publishing. Ask for keys with userConfig (`sensitive: true`) or use the MCP server's OAuth.
- `plugin.icon` (warning): plugin.json's icon isn't a square PNG. The directory makes its 256 px listing icon from that file; with an SVG, Stacktree's plugin got none and the portal showed the GitHub repo owner's avatar.
- These read the plugin's own folder: `claudePlugin.dir` in mcplane.json, or the folder holding mcplane.json when it has `.claude-plugin/plugin.json`. In a git checkout they read the files git would commit.
- New `pack claude-plugins`: the policy, then how a version goes live. Approved isn't live; the Overview tab's Auto-publish row can say it doesn't apply, and then every Publish button is disabled while a request waits, and a waiting request carries over to the newest Approved version. The header banner can still say a publish is waiting after the newest version was refused by policy, so read the Review tab. `drift` says the same.

Claude's connector directory: its review criteria
- `tools.no-instructions` now finds the steering the criteria reject, each from a description Stacktree rewrote: "Call this BEFORE any request…", "Then follow it", "Reach for this whenever…", "A rendered preview inside a tool is not a link", words in capitals ("say WHICH account", "RATHER THAN QUOTING NUMBERS…") and hidden characters. Naming a sibling tool to describe a workflow still passes.
- `tools.no-promotion` (warning; ChatGPT and Claude): descriptions that name other companies' AI products ("a Grok Bot page, a ChatGPT Site, a Claude artifact"). Claude's criteria reject promoting products, and OpenAI's scan held Stacktree's publish_html updates from 22 October to 5 November for the same thing. The host assistant named on its own ("so Claude can show it") and your own product don't count.
- `tools.money-crypto` now blocks for Claude connectors, which don't accept connectors that "Transfer money, cryptocurrency, or other financial assets". The fix says how Stacktree hides such tools from claude.ai only: every OAuth redirect URI on claude.ai or claude.com.
- `tools.conversation-data` (warning): an input that asks for the user's task or the conversation, as feedback tools do. The criteria ask a connector not to "collect conversation data beyond what the tool needs".
- `tools.title` now blocks for Claude connectors, whose criteria ask for a title plus readOnlyHint/destructiveHint on every tool. It stays a warning for plugins.
- Claude connectors pack: the criteria; a listing that's In review is updated in place (Update the copy reviewers see, through a custom connector in the same organization; Sync from server; Save and update submission), since withdrawing loses your place in the queue; the long In review waits reported in anthropics/claude-ai-mcp#1192; 3 to 5 PNG screenshots for a server with an MCP App; a populated reviewer account.

Muse
- `listing.muse-challenge`: `preflight --muse-token <token>` (or `muse_token` on the MCP tool) fetches `https://<MCP host>/.well-known/muse-challenge/<token>` the way Muse's Verify server step does, with no credentials and no redirects, and checks the body is exactly `muse-challenge=<token>` as plain text on HTTPS port 443.
- Muse pack: the portal at platform.muse.ai now shows three tasks: Business verification, Data processing questionnaire and Technical details, a wizard of Technical specs, Credentials, Verify server, Test and MCP listing. Verify before Test (verifying asks for the test again); the token lasts about 24 hours and Muse allows one attempt a minute. On 8 November the verifier said "We couldn't confirm what happened" three times with no request reaching the server, so check your logs before changing anything.

mcplane/core
- `toolChecks(tools, { own })` takes your own product names, so naming your product isn't counted as naming someone else's. `museChallengeCheck` is exported.

## 0.7.0

MCP Events, read the way ChatGPT reads them
- `readiness.events` now checks events through `initialize` on every server, not just the protocol era it prefers: `events` in the capabilities you answer `initialize` with, and `events/list` answering after it. A server that lists events only on 2026-07-28 requests now gets a warning. ChatGPT finds a plugin's events through `initialize`; Stacktree kept its events to 2026-07-28 requests until 22 October, passed the old check, and ChatGPT watched its published plugin with hourly checks instead. Having no events at all is still only a note.

New check
- `auth.refresh` (warning): `grant_types_supported` leaves out `refresh_token`, so every connection ends when its access token expires. Claude shows Reconnect and nothing reaches you, which is how Stacktree lost active Claude connections until September. A missing list is a note. Until now only the Vercel Connect checks looked.

ChatGPT pack
- A new version uploads through **Create draft from ZIP** on the plugin's own page.
- New Publish step: approval doesn't publish, and an update that changes only skills, listing text or release notes can be approved the moment it's submitted (Stacktree 1.3.0 and 1.3.1, 22 and 23 October; 1.2.0, with new tools, took 16 days).
- Keep the plugin installed in your own ChatGPT: OpenAI's daily MCP scans run on that connection, and uninstalling it stops them.
- MCP Events reach ChatGPT through its live connections without a new version, though the portal's MCPs tab doesn't list them.
- The no-upsell rule covers what tools return, not just descriptions; `tools.no-upsell` says it reads descriptions only.

## 0.6.0

New ChatGPT checks
- `server.widget-domain` (blocks): tools with a UI name resources (`_meta.ui.resourceUri` or `openai/outputTemplate`), and each one must set a widget domain, which OpenAI requires before you can submit a plugin with UI. Preflight now reads those resources; one that needs sign-in is skipped unless you pass `--token`. `openai/widgetDomain` and `ui.domain` both count.
- `tools.file-viewer-wording` (warning): a tool with a file entrypoint described as a command ("Opens an HTML file…"). The model then calls it with a file path and ChatGPT refuses the read ("MCP app cannot read resource outside its widget scope"), as Stacktree's viewer did on 6 October. Say the user opens the file and name the tool for content the model can read.
- `tools.sensitive-inputs`: an input called `password` that's really a passcode for something the tool makes gets the advice to call it `passcode`. ChatGPT's approval panel files `password` under "Account passwords".

ChatGPT pack
- Upload a new version from the plugin's own page (**Upload new version**, or **Upload plugin to make changes**). The Plugins page's upload area creates a second plugin even when the package name matches, which is how Stacktree ended up with two.
- Published tool changes don't arrive on cue: on 6 October a Rescan left a published plugin's tool table on its reviewed list, and a published plugin's MCP card has no Reconnect. Check the MCPs tab lists new tools before submitting test cases that use them.
- Don't fix a duplicate by deleting and uploading again: deleting can reserve the plugin's name (openai/codex#39508).

Fewer false alarms
- `tools.destructive-overwrite` skips verbs whose subject is a sibling tool ("update_site replaces a page in place" in another tool's description) and, like `tools.destructive-option`, expiry on a tool that creates. Stacktree's publish_html, which passed ChatGPT's scan, no longer warns.

README
- 2026-07-28 cache hints: a `tools/list` that differs by caller should be `cacheScope: "private"`.

## 0.5.1

New ChatGPT checks (warnings)
- `tools.destructive-option`: a tool marked non-destructive whose input schema offers a destructive option (`burn_after_read`, delete, overwrite, revoke, purge and the like), read from property names, descriptions and enum values one level deep. ChatGPT's scan flagged exactly that, and removing the option from the advertised schema cleared it. An expiry on a tool that creates something isn't flagged.
- `tools.money-crypto`: tools that move money or handle crypto wallets, signing or stablecoins. ChatGPT's submit step has you attest to neither. Prices, pricing pages and billing links aren't flagged.

Packs and drift
- ChatGPT: the tool scan's timing and spinner, what "Needs further review" means, unclear tool names, and that a rescan doesn't update a submission in review (cancel, reconnect, resubmit). `drift` says so for a snapshot still in review.
- Muse: Meta's developer portal at muse.ai/platform, its stages and three requirements, the 5 October intake questions, and per-tool Read/Write annotations drafted from your hints until the portal takes them.

## 0.5.0

New command
- `mcplane demo` (experimental): records the developer-mode demo video ChatGPT's review asks for, from your positive tests, by driving the ChatGPT desktop app on a Mac. It asks before sending any prompt, hides the sidebar, and writes the video to `.mcplane/packs/chatgpt/demo.mp4`. It finds its way by ChatGPT's button labels, so a ChatGPT release can break it.

New stores and checks
- Vercel Connect: preflight against its Required, Recommended and Optional tiers, from your discovery documents alone; `pack vercel-connect`; its directory in `listings`; drift rules. Manifests without `stores` now get these checks too, so an OAuth server with a Required gap exits 1 where it didn't before.
- Readiness for MCP 2026-07-28, in its own preflight section and never blocking: `server/discover`, `initialize` negotiated down, the `Mcp-Method` and `Mcp-Name` headers and CORS for them, issuer, CIMD, RFC 9207 `iss`, MCP Events.
- ARD: preflight reads `/.well-known/ard.json` (and the older `ai-catalog.json`) and validates it against ARD v0.91 and Lighthouse 13.5; `pack ard` writes a manifest both accept.
- `pack claude-eval`: your review tests as a `claude plugin eval` suite.
- Sign-in chain: plain GETs from the authorization endpoint to the sign-in page and the identity-provider hosts it loads, flagging bot challenges (`cf-mitigated: challenge`) and 403s. Nothing signs in and no client is registered. `server.signIn` or `--sign-in` names pages to check when the authorization server wants a registered client first.
- A new check level, `info`: a note that never blocks and isn't counted as something to review. Code that maps levels one by one needs to handle it.

OpenAI's annotation rules
- No more drafted hint justifications or 200-character warnings: OpenAI no longer asks for them. Any in `mcplane.json` become optional appeal notes.
- A new warning when a write that overwrites, revokes or deletes says `destructiveHint: false`.
- A ChatGPT hint change is a note in `drift`, so `drift --ci` no longer fails on it.

ChatGPT plugin ZIP
- Bundles Agent Skills from `chatgpt.skills`, checking names against folders, description length, front matter and scripts a skill runs but doesn't ship.
- Checks `plugin.json` and `mcp.json` against the Agent Plugins 1.0.0 JSON Schemas, and the root description against 1,024 characters (`plugin_description_too_long`, also in preflight).
- Icons can be local files (`icon`, `chatgpt.logo`, `composerIcon`, `logoDark`), and sizes are read from PNG, JPEG, WebP and SVG bytes, in preflight too.
- Builds behind sign-in without `--token`, and says what it couldn't check; `--tools <file>` takes a saved `tools/list` result.
- Entries are dated 1980-01-01 and keep Unix modes, so scripts stay executable and the same files give the same ZIP.
- The 10 KB icon warning is gone: the ZIP takes icons up to 5 MiB, and only developer mode's own upload is capped at 10 KB. An icon over 5 MiB now blocks.
