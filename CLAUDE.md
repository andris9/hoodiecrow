# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Hoodiecrow (`hoodiecrow-imap` on npm) is a scriptable, in-memory IMAP4rev1 mock server for client integration testing. Nothing touches disk: the whole mailbox tree comes from a JSON `storage` object at construction time, so every new server instance starts from a clean state. CommonJS, callback style, supports Node.js 20 and newer (`engines` in package.json; CI tests 20, 22 and 24).

## Commands

- `npm test`: ESLint, then all tests (`npm run test:unit`, which is `node --test test/*.js`).
- Single test file: `node --test test/uid-fetch.js`. Single test case: add `--test-name-pattern="<test name>"`.
- `npm run lint`, `npm run format` / `npm run format:check` (Prettier: single quotes, 4 spaces, 160 columns). CI fails on unformatted files. `npm install` sets `core.hooksPath` to `.githooks`, whose pre-commit hook runs Prettier on staged JS.
- `npm run update`: refresh all dependencies to latest (`ncu -u`, config in `.ncurc.js`). Dependencies are pinned to exact versions.
- Run the server: `node bin/hoodiecrow.js -p 1143 --plugin=IDLE,MOVE --debug` (see `bin/help.txt`; options also come from `HOODIECROW_*` env vars, `--config`, `--storage`, `--smtpPort`). Default login is `testuser` / `testpass`.

ESLint (`eslint.config.js`) enforces `const`/`let` (no `var`), arrow callbacks, one declaration per statement, `===`, and global `'use strict'`.

## Releases

Releases are automated with release-please (`release-please-config.json`, `.release-please-manifest.json`): use Conventional Commit messages (`fix:`, `feat:`, `chore:` ...) on master, merge the release PR it opens, and `.github/workflows/release.yaml` waits for the `test.yml` run on that commit and then publishes to npm through trusted publishing (OIDC, no token). Do not bump `version` in package.json by hand.

## Architecture

Almost everything lives in `lib/server.js`, which defines two classes:

- **`IMAPServer`**: holds the shared single-user storage, registered capabilities, command handlers, and the plugin extension arrays. Builds `folderCache` (path to mailbox object) via `indexFolders()` / `processMailbox()` from the namespace-keyed `storage` object (keys like `"INBOX"`, `""`, `"INBOX."`, each with `separator`, `type`, nested `folders`, `messages`). Cross-connection updates go through `server.notify()`, which emits a `notify` event that every connection listens to.
- **`IMAPConnection`**: one per socket. Parses lines and literals with `imap-handler`, queues commands (`scheduleCommand` / `processQueue`, strictly one at a time), tracks `state` (`"Not Authenticated"`, `"Authenticated"`, `"Selected"`) and `selectedMailbox`, and buffers notifications from other connections, flushing them before tagged responses (but not during FETCH/STORE/SEARCH). `connection.inputHandler` lets a plugin (e.g. IDLE, AUTHENTICATE) take over raw input lines.

**Commands** (`lib/commands/`): each file exports `function(connection, parsed, data, callback)`. They are lazy-loaded by `getCommandHandler()` via `require("./commands/" + command.toLowerCase())`, which is why UID variants are files with spaces in their names and must stay that way (`uid fetch.js`, `uid store.js`, ...). A handler must send a tagged response with `connection.send(response, description, parsed, data, ...extra)` and then call `callback()`, or the connection's queue stalls. Per-item FETCH/STORE/SEARCH logic is in `lib/commands/handlers/`.

**Plugins** (`lib/plugins/`): enabled via `options.plugins` (string names map to lowercase filenames, or a function). Each receives the server and extends it only through:

- `registerCapability(name, availabilityFn)`, `setCommandHandler` / `getCommandHandler` (wrap the existing handler to override a built-in command)
- `server.fetchHandlers`, `searchHandlers`, `storeHandlers` (consulted before the built-in handlers in `commands/handlers/`), `fetchFilters`
- `server.messageHandlers` (run on every message in `processMessage`), `connectionHandlers` (run on new connections), `outputHandlers` (can mutate or suppress any outgoing response via `response.skipResponse`; the `description` string passed to `send` is how they identify responses)

Plugins must stay self-contained: if a plugin is not loaded, no trace of it should remain (e.g. messages get no MODSEQ without CONDSTORE). Load order matters: ENABLE must come before plugins that depend on it, such as CONDSTORE.

Other modules: `mimeparser.js`, `bodystructure.js`, `envelope.js`, `addressparser.js` produce BODYSTRUCTURE/ENVELOPE data from raw messages; `hoodiecrowSMTPServer.js` is an optional SMTP listener (built on `smtp-server`) that appends incoming mail to INBOX; `cert/` holds the self-signed localhost cert used for STARTTLS and `secureConnection`.

## Tests

Tests use `node:test` and `node:assert`. The usual pattern (`test/*.js`): inside a `describe` block, `const ctx = setupServer(() => ({ plugins, storage }))` (from `test/helpers/`) registers hooks that start a fresh server on a random port before every test and close it afterwards. `ctx.run(cmds, resp => ...)` replays raw IMAP command strings through `lib/mock-client.js`, and the test asserts with substring checks on the full response transcript (e.g. `resp.indexOf('\r\n* OK [COPYUID 1 1,2 2,3]') >= 0`). `ctx.server` is the live server for inspecting state. Tests use callback style (`(t, done) => ...`). Because ports are random, test files run in parallel. Keep helpers out of the top level of `test/`, since every `test/*.js` file runs as a test file.
