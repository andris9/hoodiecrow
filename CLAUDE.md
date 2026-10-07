# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Hoodiecrow (`hoodiecrow-imap` on npm) is a scriptable, in-memory IMAP4rev1 mock server for client integration testing. Nothing touches disk: the whole mailbox tree comes from a JSON `storage` object at construction time, so every new server instance starts from a clean state. CommonJS, callback style, supports Node.js 20 and newer (`engines` in package.json; CI tests 20, 22 and 24).

## Commands

- `npm test`: ESLint, then all tests (`npm run test:unit`, which is `node --test test/*.js`).
- `npm run test:coverage`: the tests with Node's built-in coverage for `lib/` (Node >= 22.8). Fails below 94% line coverage; CI runs it on Node 24.
- Single test file: `node --test test/uid-fetch.js`. Single test case: add `--test-name-pattern="<test name>"`.
- `npm run lint`, `npm run format` / `npm run format:check` (Prettier: single quotes, 4 spaces, 160 columns). CI fails on unformatted files. `npm install` sets `core.hooksPath` to `.githooks`, whose pre-commit hook runs Prettier on staged JS.
- `npm run update`: refresh all dependencies to latest (`ncu -u`, config in `.ncurc.js`). Dependencies are pinned to exact versions.
- `npm run dovecot:start` then `npm run compare -- <scenario>`: compare hoodiecrow with Dovecot (see "Comparing with Dovecot" below).
- Run the server: `node bin/hoodiecrow.js -p 1143 --plugin=IDLE,MOVE --debug` (see `bin/help.txt`; options also come from `HOODIECROW_*` env vars, `--config`, `--storage`, `--smtpPort`). Default login is `testuser` / `testpass`.

ESLint (`eslint.config.js`) enforces `const`/`let` (no `var`), arrow callbacks, one declaration per statement, `===`, and global `'use strict'`.

## Releases

Releases are automated with release-please (`release-please-config.json`, `.release-please-manifest.json`): use Conventional Commit messages (`fix:`, `feat:`, `chore:` ...) on master, merge the release PR it opens, and `.github/workflows/release.yaml` waits for the `test.yml` run on that commit and then publishes to npm through trusted publishing (OIDC, no token). Do not bump `version` in package.json by hand.

## Strict by design

Hoodiecrow is a guardrail for developing standards compliant IMAP clients, so it follows the RFCs strictly instead of being lenient like production servers (WildDuck, Dovecot). When a client breaks a MUST or the grammar, answer BAD (or NO where the RFC says so) instead of guessing what it meant. The rules in force are listed in the README "Strict by design" section and covered by `test/conformance.js`.

Always check RFC text against the real source document at `https://www.rfc-editor.org/rfc/rfcXXXX.txt` (XXXX is the RFC number), never from memory, and cite the section in code comments and tests.

## Architecture

Almost everything lives in `lib/server.js`, which defines two classes:

- **`IMAPServer`**: holds the shared single-user storage, registered capabilities, command handlers, and the plugin extension arrays. Builds `folderCache` (path to mailbox object) via `indexFolders()` / `processMailbox()` from the namespace-keyed `storage` object (keys like `"INBOX"`, `""`, `"INBOX."`, each with `separator`, `type`, nested `folders`, `messages`). Cross-connection updates go through `server.notify()`, which emits a `notify` event that every connection listens to.
- **`IMAPConnection`**: one per socket. Parses lines and literals with `imap-handler`, queues commands (`scheduleCommand` / `processQueue`, strictly one at a time), refuses commands in the wrong state (`lib/command-states.js`, checked centrally, not per handler), refuses ambiguous pipelining (RFC 3501 5.5), tracks `state` (`"Not Authenticated"`, `"Authenticated"`, `"Selected"`) and `selectedMailbox`, and buffers notifications from other connections, flushing them before tagged responses (but not during FETCH/STORE/SEARCH). `connection.inputHandler` lets a plugin (e.g. IDLE, AUTHENTICATE) take over raw input lines.

**Commands** (`lib/commands/`): each file exports `function(connection, parsed, data, callback)`. They are lazy-loaded by `getCommandHandler()` via `require("./commands/" + command.toLowerCase())`, which is why UID variants are files with spaces in their names and must stay that way (`uid fetch.js`, `uid store.js`, ...). A handler must send a tagged response with `connection.send(response, description, parsed, data, ...extra)` and then call `callback()`, or the connection's queue stalls. Per-item FETCH/STORE/SEARCH logic is in `lib/commands/handlers/`.

**Plugins** (`lib/plugins/`): enabled via `options.plugins` (string names map to lowercase filenames, or a function). Each receives the server and extends it only through:

- `registerCapability(name, availabilityFn)`, `setCommandHandler` / `getCommandHandler` (wrap the existing handler to override a built-in command)
- `server.fetchHandlers`, `searchHandlers`, `storeHandlers` (consulted before the built-in handlers in `commands/handlers/`), `fetchFilters`
- `server.messageHandlers` (run on every message in `processMessage`), `connectionHandlers` (run on new connections), `outputHandlers` (can mutate or suppress any outgoing response via `response.skipResponse`; the `description` string passed to `send` is how they identify responses)

Plugins must stay self-contained: if a plugin is not loaded, no trace of it should remain (e.g. messages get no MODSEQ without CONDSTORE). Plugin names are validated and deduplicated by `lib/load-plugins.js`, and ENABLE and CONDSTORE work in any load order. A plugin command that is not in `lib/command-states.js` can pass its allowed states as the third argument of `setCommandHandler`.

Other modules: `mimeparser.js`, `bodystructure.js`, `envelope.js`, `addressparser.js` produce BODYSTRUCTURE/ENVELOPE data from raw messages; `hoodiecrowSMTPServer.js` is an optional SMTP listener (built on `smtp-server`) that appends incoming mail to INBOX; `cert/` holds the self-signed localhost cert used for STARTTLS and `secureConnection`.

## Tests

Tests use `node:test` and `node:assert`. The usual pattern (`test/*.js`): inside a `describe` block, `const ctx = setupServer(() => ({ plugins, storage }))` (from `test/helpers/`) registers hooks that start a fresh server on a random port before every test and close it afterwards. `ctx.run(cmds, resp => ...)` replays IMAP command strings (binary strings) through `lib/mock-client.js`, which behaves like a compliant client: it waits for the tagged response before the next command, sends literal data only after the `+` continuation, sends the next list entry as continuation data when the server asks for one (DONE, SASL responses), and closes the connection after the last command. Tests assert on the full response transcript, preferably with line anchored regexes (`/^A3 NO \[TRYCREATE\]/m`). `ctx.server` is the live server for inspecting state. Because ports are random, test files run in parallel. Keep helpers out of the top level of `test/`, since every `test/*.js` file runs as a test file.

Test layers:

- protocol tests per command or plugin (`test/<command>.js`), table driven strictness checks in `test/conformance.js`
- multi-session behaviour (EXPUNGE timing, flag updates, IDLE, `\Recent`) in `test/sessions.js`, using `openSession()` from `test/helpers/session.js` for interleaved connections
- a real client end to end in `test/imapflow.js` (ImapFlow, all plugins and none)
- MIME fidelity and golden BODYSTRUCTURE/ENVELOPE wire forms (checked against Dovecot) in `test/mime-fidelity.js` with fixtures in `test/fixtures/mime/`
- parser level tests of the MIME code in `test/mime.js`

Every transcript from `ctx.run` and `openSession` goes through `test/helpers/validate-responses.js` before the test sees it: CRLF framing and literals, the RFC 3501 section 9 shape of tagged, untagged and `+` responses (status text is required, no 8-bit outside literals, nz-numbers for FETCH/EXPUNGE, FETCH lists in pairs), and ImapFlow's response parser. A failure there means hoodiecrow sent something a compliant client can not parse, so fix the server rather than the check. `test/fuzz.js` replays mutated commands under the same guardrail; on failure it prints `FUZZ_SEED`, the iteration and the input, and `FUZZ_SEED=<n> FUZZ_ITERATIONS=<n> node --test test/fuzz.js` reproduces or widens a run.

## Comparing with Dovecot

`compare/` holds a development aid, not a test suite. It replays the same IMAP commands against hoodiecrow and a real Dovecot 2.4 server and shows where the responses differ. Use it when building or fixing a feature, to see what RFC compliant input and output look like in practice. Dovecot is the most spec compliant server around, but it has its own bugs, quirks and extensions. Treat a difference as a hint to check the RFC (fetched from rfc-editor.org), not as proof that hoodiecrow is wrong, and do not copy Dovecot behavior that the RFC does not require.

- `npm run dovecot:start` / `npm run dovecot:stop` (`compare/dovecot.sh`, also `status`, `restart`, `logs`) manage a long-running Docker container `hoodiecrow-dovecot` (image `dovecot/dovecot:2.4.4`) with plain IMAP on `127.0.0.1:32143`. `compare/dovecot.conf` is mounted as a drop-in. It allows cleartext login, turns off FTS so SEARCH is plain substring matching, and stops auto-creating special-use mailboxes. Overrides: `HOODIECROW_DOVECOT_IMAGE`, `HOODIECROW_DOVECOT_PLATFORM` (forcing `linux/amd64` on Apple Silicon does not work), `HOODIECROW_DOVECOT_PORT` (also read by compare.js), `HOODIECROW_DOVECOT_HOST`.
- `npm run compare -- compare/scenarios/fetch.txt`, or `node compare/compare.js -c 'SELECT INBOX' -c 'FETCH 1 BODYSTRUCTURE'`. `--plugin IDLE,MOVE` loads hoodiecrow plugins, `--target hoodiecrow|dovecot` runs one side only, and `--json` gives machine readable output (handy for Claude); `--help` lists all options.
- Every run starts an in-process hoodiecrow on a random port and logs into Dovecot as a brand-new user (static passdb, password `pass`). That user is seeded from the same storage JSON through a hidden setup connection: CREATE, SUBSCRIBE, and APPEND with flags and internaldate. Only personal namespaces with `/` as separator are seeded, `\Recent` is dropped, and a warning is shown if Dovecot assigns different UIDs than the storage specifies.
- Scenario files (`compare/scenarios/*.txt`) hold one step per line. A plain line is a command and gets an automatic tag (`A1`, `A2`, ...). `2: CMD` runs on session 2 (sessions open and log in on first use). `> DONE` is sent verbatim with no tag and waits for the tagged response of the command left open by a continuation (IDLE, AUTHENTICATE). `!wait 500` pauses. `#` starts a comment. In commands, `\r\n` becomes CRLF and `{file:path}` / `{file+:path}` become a literal with the file's contents (path relative to the scenario file, sample messages in `compare/messages/`). `$USER` / `$PASS` expand per server, for use with `--manual-login`. Synchronizing literals wait for the `+` continuation.
- Both outputs are normalized before they are compared:
    - Dovecot's `(0.001 + 0.000 secs)` timings are removed.
    - The human readable text of OK/NO/BAD/BYE and of `+` continuations is dropped (`--keep-text` keeps it).
    - UIDVALIDITY values are masked, also inside COPYUID and APPENDUID.
    - LIST/LSUB responses and flag lists are sorted, and quoted mailbox names that are valid atoms are unquoted. `--exact` turns this sorting and unquoting off.
- Known differences that are not hoodiecrow bugs:
    - CAPABILITY lists (Dovecot advertises many extensions, and some, like IMAP4rev2 or CONDSTORE, change its output once enabled).
    - Lowercase vs uppercase BODYSTRUCTURE strings.
    - Dovecot reports INTERNALDATE in UTC.
    - Dovecot sends `* OK [CLOSED]` when switching mailboxes.
    - The first session to select a seeded mailbox sees the messages as `\Recent` in Dovecot.
    - Dovecot's IDLE notifications can arrive late, so put a `!wait 1000` after the step that triggers them.
- `test/compare.js` covers the tool's parsing, normalizing and seeding against hoodiecrow only, so `npm test` stays Docker-free.
