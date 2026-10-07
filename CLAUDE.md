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

- **`IMAPServer`**: holds the shared single-user storage, registered capabilities, command handlers, and the plugin extension arrays. Builds `folderCache` (path to mailbox object) via `indexFolders()` / `processMailbox()` from the namespace-keyed `storage` object (keys like `"INBOX"`, `""`, `"INBOX."`, each with `separator`, `type`, nested `folders`, `messages`). Cross-connection updates go through `server.notify()`, which emits a `notify` event that every connection listens to; `server.notifyFilters` (`filter(connection, notification)`) lets a plugin keep a notification from some connections (ACL does for METADATA).
- **`IMAPConnection`**: one per socket. Parses lines and literals with `imap-handler`, queues commands (`scheduleCommand` / `processQueue`, strictly one at a time), refuses commands in the wrong state, with arguments when they take none, and mailbox name arguments that are not valid modified UTF-7 (options from `lib/command-states.js` or `setCommandHandler`, checked centrally in `processQueue`, not per handler), refuses ambiguous pipelining (RFC 3501 5.5), tracks `state` (`"Not Authenticated"`, `"Authenticated"`, `"Selected"`), `username` (set by LOGIN and the AUTHENTICATE plugins) and `selectedMailbox`, and buffers notifications from other connections, flushing them before tagged responses (but not during FETCH/STORE/SEARCH). `connection.inputHandler` lets a plugin (e.g. IDLE, AUTHENTICATE) take over raw input lines, and a plugin can override `connection.canSetSeen()` (FETCH sets `\Seen`) and `connection.canExpunge()` (CLOSE expunges), both `!readOnly` by default, as ACL does. All output goes through `connection.write()` (also raw `+` continuations) and `connection.end()` closes after the output is written, never `connection.socket.write/end`: `connection.transport` is an optional layer between the protocol and the socket with `write`, `receive`, `end(callback)` and `destroy`, which passes data on with `connection.writeRaw()` and `connection.onData()`, so it is always above TLS (COMPRESS uses `lib/deflate-layer.js`, which the mock client, the session helper and the compare tool share). `connection.resetSession()` returns to the Not Authenticated state (UNAUTHENTICATE, RFC 8437), `connection.discardInput()` drops unprocessed input. LITERAL+ and LITERAL- set `server.literalPlus` and `server.nonSyncLiteralLimit`.

**Commands** (`lib/commands/`): each file exports `function(connection, parsed, data, callback)`. They are lazy-loaded by `getCommandHandler()` via `require("./commands/" + command.toLowerCase())`, which is why UID variants are files with spaces in their names and must stay that way (`uid fetch.js`, `uid store.js`, ...). A handler must send a tagged response with `connection.send(response, description, parsed, data, ...extra)` and then call `callback()`, or the connection's queue stalls. Per-item FETCH/STORE/SEARCH logic is in `lib/commands/handlers/`.

**Plugins** (`lib/plugins/`): enabled via `options.plugins` (string names map to lowercase filenames, or a function). Each receives the server and extends it only through:

- `registerCapability(name, availabilityFn)`, `setCommandHandler` / `getCommandHandler` (wrap the existing handler to override a built-in command)
- `server.fetchHandlers`, `searchHandlers`, `storeHandlers`, `statusHandlers` (consulted before the built-in handlers in `commands/handlers/`), `fetchFilters`. A new STATUS item also goes into `server.allowedStatus` (the IMAP4rev2 `DELETED` item is built in but not allowed by default)
- `server.searchHandlers` keys normally take string arguments (one per handler param after `connection, message, index`); a handler with an `argumentTypes(list)` method decides its own arguments, and a type can be a parse function that throws `badError` (see MODSEQ in `condstore.js`). The untagged SEARCH response passes the search result `{ list, numbers, keys }` as `extra`, which is how ESEARCH replaces it and CONDSTORE adds `(MODSEQ n)` (the ESEARCH response passes the same object, with `list` holding only the returned messages). ESEARCH response building lives in `lib/esearch.js`, for reuse by a future IMAP4rev2 mode
- `connection.getMessageRange(range, isUid)` resolves every sequence set argument; SEARCHRES replaces it per connection (via `connectionHandlers`) to support `$`. A sequence set that does not start with a number or `*` does not count as sequence numbers for the RFC 3501 section 5.5 pipelining check
- extended LIST options: the registry from `getListExtensions(server)` in `lib/list-extensions.js` holds the selection and return options that the LIST-EXTENDED plugin accepts; SPECIAL-USE and LIST-STATUS add theirs there, in any load order
- `server.messageHandlers` (run on every message in `processMessage`), `mailboxHandlers` (run on every mailbox in `processMailbox`), `connectionHandlers` (run on new connections), `resetHandlers` (run by `connection.resetSession()`; a plugin that keeps per-session state on the connection MUST clear it here, RFC 8437 section 4.1), `outputHandlers` (can mutate or suppress any outgoing response via `response.skipResponse`; the `description` string passed to `send` is how they identify responses)
- `appendChecks` (can veto APPEND, COPY and MOVE before messages are added, through `connection.checkAppend`, e.g. QUOTA's `NO [OVERQUOTA]`), `copyHandlers` (carry properties of the source over to the copy in `server.copyMessage`, for COPY, MOVE and RENAME INBOX, before the message handlers run)

Plugins must stay self-contained: if a plugin is not loaded, no trace of it should remain (e.g. messages get no MODSEQ without CONDSTORE). Plugin names are validated and deduplicated by `lib/load-plugins.js`, and ENABLE and CONDSTORE work in any load order. The ACL plugin wraps the enforced commands (also those of other plugins, like MOVE and UID EXPUNGE) and the STORE flag handlers when the first client connects, so it works in any load order too; the owner (`aclOwner` option, default `testuser`) bypasses the enforcement. `lib/command-states.js` lists only RFC 3501 core commands; a plugin passes the options of its own commands as the third argument of `setCommandHandler(command, handler, { states, noArguments, mailboxArguments, searchCriteria, noExpunge })`: `searchCriteria` is the argument position where SEARCH style criteria start (used for the RFC 3501 5.5 sequence number check), `noExpunge` marks commands during which EXPUNGE responses are not allowed (FETCH, STORE, SEARCH, SORT, THREAD), so notifications are held back and clients may pipeline after them. Wrapping an existing command without options keeps its settings.

Other modules: `mimeparser.js`, `bodystructure.js`, `envelope.js`, `addressparser.js` produce BODYSTRUCTURE/ENVELOPE data from raw messages; `sorting.js` (collation, base subject, sent date, address and Message-ID values, and the search step) and `threading.js` (THREAD command, ORDEREDSUBJECT and REFERENCES) back the SORT, SORT=DISPLAY and THREAD=* plugins; `hoodiecrowSMTPServer.js` is an optional SMTP listener (built on `smtp-server`) that appends incoming mail to INBOX; `cert/` holds the self-signed localhost cert used for STARTTLS and `secureConnection`.

## Tests

Tests use `node:test` and `node:assert`. The usual pattern (`test/*.js`): inside a `describe` block, `const ctx = setupServer(() => ({ plugins, storage }))` (from `test/helpers/`) registers hooks that start a fresh server on a random port before every test and close it afterwards. `ctx.run(cmds, resp => ...)` replays IMAP command strings (binary strings) through `lib/mock-client.js` (response and literal framing shared with the test helpers and `compare/` lives in `lib/framing.js`), which behaves like a compliant client: it waits for the tagged response before the next command, sends literal data only after the `+` continuation, sends the next list entry as continuation data when the server asks for one (DONE, SASL responses), and closes the connection after the last command. Tests assert on the full response transcript, preferably with line anchored regexes (`/^A3 NO \[TRYCREATE\]/m`). `ctx.server` is the live server for inspecting state. Because ports are random, test files run in parallel. Keep helpers out of the top level of `test/`, since every `test/*.js` file runs as a test file.

Test layers:

- protocol tests per command or plugin (`test/<command>.js`), table driven strictness checks in `test/conformance.js`
- multi-session behaviour (EXPUNGE timing, flag updates, IDLE, `\Recent`) in `test/sessions.js`, using `openSession()` from `test/helpers/session.js` for interleaved connections
- a real client end to end in `test/imapflow.js` (ImapFlow, all plugins and none)
- MIME fidelity and golden BODYSTRUCTURE/ENVELOPE wire forms (checked against Dovecot) in `test/mime-fidelity.js` with fixtures in `test/fixtures/mime/`
- parser level tests of the MIME code in `test/mime.js`

Every transcript from `ctx.run` and `openSession` goes through `test/helpers/validate-responses.js` before the test sees it: CRLF framing and literals, the RFC 3501 section 9 shape of tagged, untagged and `+` responses (status text is required, so every OK/NO/BAD/BYE response, including untagged ones with only a response code, must carry human readable text; no 8-bit outside literals, nz-numbers for FETCH/EXPUNGE, FETCH lists in pairs), and ImapFlow's response parser. A failure there means hoodiecrow sent something a compliant client can not parse, so fix the server rather than the check. `test/fuzz.js` replays mutated commands under the same guardrail; on failure it prints `FUZZ_SEED`, the iteration and the input, and `FUZZ_SEED=<n> FUZZ_ITERATIONS=<n> node --test test/fuzz.js` reproduces or widens a run.

## Comparing with Dovecot

`compare/` holds a development aid, not a test suite. It replays the same IMAP commands against hoodiecrow and a real Dovecot 2.4 server and shows where the responses differ. Use it when building or fixing a feature, to see what RFC compliant input and output look like in practice. Dovecot is the most spec compliant server around, but it has its own bugs, quirks and extensions. Treat a difference as a hint to check the RFC (fetched from rfc-editor.org), not as proof that hoodiecrow is wrong, and do not copy Dovecot behavior that the RFC does not require.

- `npm run dovecot:start` / `npm run dovecot:stop` (`compare/dovecot.sh`, also `status`, `restart`, `logs`) manage a long-running Docker container `hoodiecrow-dovecot` (image `dovecot/dovecot:2.4.4`) with plain IMAP on `127.0.0.1:32143`. `compare/dovecot.conf` is mounted as a drop-in. It allows cleartext login, turns off FTS so SEARCH is plain substring matching, stops auto-creating special-use mailboxes, and turns on QUOTA (count driver, 10M and 1000 messages), APPENDLIMIT (5M), ACL (vfile) and METADATA for comparison. Overrides: `HOODIECROW_DOVECOT_IMAGE`, `HOODIECROW_DOVECOT_PLATFORM` (forcing `linux/amd64` on Apple Silicon does not work), `HOODIECROW_DOVECOT_PORT` (also read by compare.js), `HOODIECROW_DOVECOT_HOST`.
- The compare tool speaks COMPRESS=DEFLATE: after a tagged OK to `COMPRESS DEFLATE` a session compresses and the output is compared decompressed (`compare/scenarios/compress.txt`).
- `npm run compare -- compare/scenarios/fetch.txt`, or `node compare/compare.js -c 'SELECT INBOX' -c 'FETCH 1 BODYSTRUCTURE'`. `--plugin IDLE,MOVE` loads hoodiecrow plugins, `--target hoodiecrow|dovecot` runs one side only, and `--json` gives machine readable output (handy for Claude); `--help` lists all options.
- Every run starts an in-process hoodiecrow on a random port and logs into Dovecot as a brand-new user (static passdb, password `pass`). That user is seeded from the same storage JSON through a hidden setup connection: CREATE, SUBSCRIBE, and APPEND with flags and internaldate. Only personal namespaces with `/` as separator are seeded, `\Recent` is dropped, and a warning is shown if Dovecot assigns different UIDs than the storage specifies.
- Scenario files (`compare/scenarios/*.txt`) hold one step per line. A plain line is a command and gets an automatic tag (`A1`, `A2`, ...). `2: CMD` runs on session 2 (sessions open and log in on first use). `> DONE` is sent verbatim with no tag and waits for the tagged response of the command left open by a continuation (IDLE, AUTHENTICATE). `!wait 500` pauses. `#` starts a comment. In commands, `\r\n` becomes CRLF and `{file:path}` / `{file+:path}` become a literal with the file's contents (path relative to the scenario file, sample messages in `compare/messages/`). `compare/scenarios/sort-thread.txt` runs against `compare/storage-sort-thread.json` (see the comment at its top), messages with tricky subjects, dates, addresses and references. `$USER` / `$PASS` expand per server, for use with `--manual-login`. Synchronizing literals wait for the `+` continuation.
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
    - MODSEQ and HIGHESTMODSEQ values, Dovecot assigns its own mod-sequences when the user is seeded.
    - Extended LIST: hoodiecrow always sends `\HasChildren`/`\HasNoChildren`, and sends STATUS items in the requested order. Dovecot omits `CHILDINFO` for a mailbox that matches the selection criteria itself (RFC 5258 section 3.5 asks for it), accepts an empty pattern list `LIST "" ()` and `(SPECIAL-USE RECURSIVEMATCH)` (both break the RFC 5258 / RFC 6154 grammar), and takes the last of two different `STATUS` return options.
    - PREVIEW text can differ for HTML and multipart messages: Dovecot keeps the HTML `<title>`, puts a space for inline tags, drops unknown entities, and also uses attachments and other text/* types. Dovecot also accepts `PREVIEW.PEEK` (not in RFC 8970) and drops the connection on `PREVIEW (LAZY LAZY)`, which the grammar allows.
    - METADATA: Dovecot sends every value as a literal, lists DEPTH results in its own order, accepts `()` as an empty entry or option list, atoms as values and `/shared` in SETMETADATA, refuses server annotations with `[CANNOT]`, has no `/private/specialuse`, sends no unsolicited METADATA responses, and moves instead of copies the annotations of INBOX on RENAME (RFC 5464 section 4.1 says copy).
    - SORT and THREAD: Dovecot accepts charsets other than US-ASCII and UTF-8, `REVERSE REVERSE`, a literal charset and a quoted threading algorithm, which hoodiecrow refuses per RFC 5256 section 5. Dovecot sends `* THREAD ` with a trailing space when nothing matches, against the thread-data grammar.
    - Sent dates (RFC 5256 section 2.2): for a Date header with an invalid or missing time Dovecot uses the internal date, hoodiecrow uses 00:00:00 of that date, and Dovecot reads a zone like `+2360` as an offset where hoodiecrow uses UTC.
    - Dovecot's quota limits come from its config (STORAGE 10240, MESSAGE 1000), it refuses SETQUOTA and puts every mailbox under its quota root. Hoodiecrow has no limits unless the `quota` option sets them, and only INBOX and the personal namespaces belong to its quota root.
    - Dovecot does not support OBJECTID.
    - COMPRESS: Dovecot answers `NO [COMPRESSIONACTIVE]` to a second COMPRESS and `NO` to an unknown mechanism, RFC 4978 section 3 lists both as BAD (hoodiecrow sends `BAD [COMPRESSIONACTIVE]`). Dovecot advertises COMPRESS=DEFLATE only after login.
    - ACL: Dovecot lists rights in another order, names the compare user instead of `testuser` as the owner in GETACL, answers MYRIGHTS for mailboxes that do not exist and ignores extra MYRIGHTS arguments, and silently ignores STORE and EXPUNGE in a mailbox that is READ-ONLY because of the ACL. Dovecot lets the owner change its own rights (except `a`), hoodiecrow answers `NO [CANNOT]`. Dovecot sends MYRIGHTS twice for `RETURN (MYRIGHTS MYRIGHTS)` (RFC 5258 section 3 counts a repeated option once).
- `test/compare.js` covers the tool's parsing, normalizing and seeding against hoodiecrow only, so `npm test` stays Docker-free.
