---
title: Running Tests
sidebar_position: 1
description: Build ImapKit from source, run the test suite under Node.js, Bun and Deno, check coverage and formatting, and understand the test layers.
---

# Running Tests

ImapKit is written in TypeScript under `src/`. Tests use the built-in Node.js test runner, and TypeScript test files run through [tsx](https://tsx.is/). Linting uses ESLint and the TypeScript compiler, formatting uses Prettier.

```bash
git clone https://github.com/postalsys/imapkit.git
cd imapkit
npm install
npm test
```

`npm install` also builds the package (the `prepare` script) and points `core.hooksPath` at `.githooks`.

## Commands

| Command                 | What it does                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm test`              | ESLint and the type check (`npm run lint`), the build, then every test. This is what to run before a commit.                               |
| `npm run test:unit`     | Every test, without lint and build: `node --import tsx --test test/*.test.ts`.                                                             |
| `npm run test:coverage` | The tests with Node's built-in coverage for `src/`. Fails below **94%** line coverage. Needs Node.js 22.8 or newer, CI runs it on Node 24. |
| `npm run test:bun`      | The suite under [Bun](https://bun.sh/).                                                                                                    |
| `npm run test:deno`     | The suite under [Deno](https://deno.com/).                                                                                                 |
| `npm run build`         | Compiles `src/` into `dist/esm` and `dist/cjs` with type declarations, and collects the plugin help text for `imapkit --help`.             |
| `npm run lint`          | ESLint and `tsc` type checking.                                                                                                            |
| `npm run format`        | Prettier on every file. `npm run format:check` only checks, CI fails on unformatted files.                                                 |

Tests import `src/` directly through tsx, so most of them do not need a build. Only `test/package.test.ts` and `test/cli.test.ts` load the built `dist/`, and they skip with "run npm run build first" when it is missing.

### A single file or test case

```bash
node --import tsx --test test/uid-fetch.test.ts
node --import tsx --test --test-name-pattern="returns server ID" test/id.test.ts
```

Test files start their servers on random ports, so the runner runs them in parallel.

### Bun and Deno

CI runs the whole suite on the latest Bun and Deno releases next to Node.js 20, 22 and 24. Deno does not pass a `done` callback to `node:test` hooks, so hooks in the tests return promises. Keep that pattern when adding hooks.

## Formatting

Prettier uses single quotes, 4 spaces and 160 columns. The pre-commit hook in `.githooks/pre-commit` formats staged files and adds them back to the commit. A staged file that also has unstaged changes is only checked, not rewritten, so the commit is aborted if it is unformatted: run `npm run format` and stage again.

## The response guardrail

Every transcript a test gets from the test helpers first goes through `test/helpers/validate-responses.ts`. It checks that a compliant client can parse everything the server sent:

- CRLF framing and literals
- the [RFC 3501](https://www.rfc-editor.org/rfc/rfc3501) section 9 shape of tagged, untagged and `+` responses: every OK, NO, BAD and BYE response carries human readable text (also untagged ones with only a response code), no 8-bit data outside literals, nz-numbers for FETCH and EXPUNGE, FETCH lists in pairs
- ImapFlow's response parser accepts every response

A failure there means ImapKit sent something a compliant client can not parse. Fix the server, not the check.

## The fuzz test

`test/fuzz.test.ts` mutates valid IMAP commands and replays them against a server with every plugin loaded except STARTTLS, COMPRESS, LOGINDISABLED, METADATA-SERVER and the alternatives LITERAL- and SAVELIMIT. It checks that the server answered every command once, that its output passes the response guardrail and that it still responds afterwards.

The seed is fixed by default, so CI is deterministic. On a failure the test prints `FUZZ_SEED`, the iteration and the input. Reproduce a run, or widen it with more iterations or another seed:

```bash
FUZZ_SEED=7 FUZZ_ITERATIONS=5000 node --import tsx --test test/fuzz.test.ts
```

`FUZZ_ITERATIONS` defaults to 400.

## Test layers

| Layer                      | Where                                                                                                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol tests per command | `test/<command>.test.ts` and `test/<plugin>.test.ts`                                                                                                                         |
| Strictness checks          | `test/conformance.test.ts`, table driven, one row per RFC rule (see [Strict by Design](../guides/strict-by-design.md))                                                       |
| Multiple sessions          | `test/sessions.test.ts` (EXPUNGE timing, flag updates, IDLE, `\Recent`), `test/multi-access.test.ts` (RFC 2180 scenarios)                                                    |
| RFC 2683 recommendations   | `test/implementation-recommendations.test.ts`                                                                                                                                |
| A real client end to end   | `test/imapflow.test.ts`, ImapFlow with all plugins and with none                                                                                                             |
| MIME fidelity              | `test/mime-fidelity.test.ts`, golden BODYSTRUCTURE and ENVELOPE wire forms checked against Dovecot, fixtures in `test/fixtures/mime/`                                        |
| MIME parser                | `test/mime.test.ts`                                                                                                                                                          |
| Package shape              | `test/package.test.ts`, the ES module and CommonJS exports of the built package                                                                                              |
| Compare tool               | `test/compare.test.ts`, the parsing, normalizing and seeding of [the Dovecot compare tool](./comparing-with-dovecot.md), against ImapKit only, so `npm test` needs no Docker |
| Fuzzing                    | `test/fuzz.test.ts`                                                                                                                                                          |

## Writing a test

The usual pattern uses `setupServer()` from `test/helpers/`. It registers hooks that start a fresh server on a random port before every test of the enclosing `describe` block and close it afterwards. `ctx.run(commands, callback)` replays IMAP command strings like a compliant client: it waits for each tagged response, sends literal data only after the `+` continuation, and sends the next list entry as continuation data when the server asks for one (`DONE`, SASL responses).

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { setupServer } from './helpers/index.js';

describe('XYZ', () => {
    const ctx = setupServer(() => ({ plugins: ['IDLE'], storage: { INBOX: {}, '': {} } }));

    it('refuses a missing mailbox', (t, done) => {
        ctx.run(['A1 LOGIN testuser testpass', 'A2 SELECT Nope', 'A3 LOGOUT'], resp => {
            assert.match(resp.toString(), /^A2 NO /m);
            done();
        });
    });
});
```

Assert on the full transcript, preferably with line anchored regular expressions (`/^A3 NO \[TRYCREATE\]/m`). `ctx.server` is the live server for inspecting state. For interleaved connections use `openSession()` or `useSessions()` from `test/helpers/session.ts`.

Keep helpers out of the top level of `test/`: every `test/*.test.ts` file there runs as a test file.

Changes to RFC behavior cite the section in code comments and tests, checked against the source text at `https://www.rfc-editor.org/rfc/rfcNNNN.txt`.
