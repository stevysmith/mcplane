# Changelog

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
