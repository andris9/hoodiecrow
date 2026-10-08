---
title: Repeatable Tests
sidebar_position: 3
description: Make every ImapKit run identical with fresh servers per test, scriptSeed for random faults, a fixed clock with the now option, seeded UID shuffles and validated storage fixtures.
---

# Repeatable Tests

A test that fails once in fifty runs is worse than no test. ImapKit keeps everything that could vary between runs under your control: the starting state, the random numbers of script rules, the clock, and the order of shuffled UIDs.

## A fresh server per test

Nothing is written to disk, and every server starts from its `storage` option. The storage is copied (with `structuredClone`) when the server is built, so one fixture object can feed any number of servers without one test's changes leaking into the next.

`server.start()` listens on a free port and resolves with it, so test files can run in parallel. `server.stop()` closes the server and every session.

```javascript title="test/sync.test.js"
import { describe, it, beforeEach, afterEach } from 'node:test';
import imapkit from 'imapkit';
import { inbox } from './fixtures/inbox.js';

describe('sync', () => {
    let server;
    let port;

    beforeEach(async () => {
        server = imapkit({ plugins: ['IDLE', 'CONDSTORE'], storage: inbox, now: Date.parse('2026-01-15T09:30:00Z'), scriptSeed: 1 });
        port = await server.start();
    });

    afterEach(() => server.stop());

    it('syncs the inbox', async () => {
        // connect the client to 127.0.0.1:port as testuser / testpass
    });
});
```

UIDVALIDITY values are not taken from the clock either: a mailbox without `uidvalidity` in the storage gets 1, and a mailbox created later gets one more than the highest value in use.

When one long running server is shared by many tests (for example the `imapkit` command, used from another language), [`server.control.reset()`](#controlreset) brings it back to the starting state between tests instead.

## scriptSeed

Script rules with [`chance`](./scripted-faults.md#matchers), and the [quirk presets](./quirk-presets.md) built on them (`james-late-fetch`, `m365-throttle`), fire on a random share of the events. The random numbers come from a seeded generator:

```javascript
const server = imapkit({
    scriptSeed: 42,
    script: { on: 'command', command: 'NOOP', chance: 0.3, send: '$TAG NO [LIMIT] Too many commands, slow down\r\n' }
});
```

The command line takes `--script-seed=42` or `IMAPKIT_SCRIPT_SEED=42`. Without a seed, every server picks a random one.

The same seed gives the same faults when the client does the same thing:

- A random number is drawn only for an event that passed every other matcher of a `chance` rule (and its `nth` and `times`). Events that no `chance` rule matches do not use up numbers.
- All `chance` rules of a server draw from one sequence, in the order the events happen. One extra command, or two sessions whose commands interleave differently, shift which events are hit. For a repeatable run, keep the client's sequence of commands fixed, and give sessions that run in parallel their own rules (the `session` matcher) or their own server.

To find a seed that hits a particular command, try seeds in a loop and keep the one that gives the run you want, then hard-code it in the test.

## The `now` option

Some dates are set by the server itself: the INTERNALDATE of a message that has none (a storage message without `internaldate`, an APPEND without a date, `control.addMessage()` without `internaldate`) and SAVEDATE. The `now` option fixes the clock for those:

- a `Date`
- a timestamp in milliseconds
- a function that returns either, called every time the server needs the time

`server.now()` returns the time the server uses, as a `Date`.

```javascript
const server = imapkit({
    plugins: ['SAVEDATE'],
    now: new Date('2026-01-15T09:30:00Z'),
    storage: { INBOX: { messages: [{ uid: 1, raw: 'Subject: from storage\r\n\r\nHi\r\n' }] } }
});

server.now(); // 2026-01-15T09:30:00.000Z
```

Run with `TZ=UTC`, the stored message and an APPEND without a date both get the fixed time:

```text
C: A2 APPEND INBOX {21}
S: + Go ahead
C: Subject: appended
C:
C:
S: A2 OK APPEND Completed
C: A3 SELECT INBOX
S: * FLAGS (\Answered \Flagged \Draft \Deleted \Seen)
S: * OK [PERMANENTFLAGS (\Answered \Flagged \Draft \Deleted \Seen \*)] Flags permitted
S: * 2 EXISTS
S: * 1 RECENT
S: * OK [UNSEEN 1] First unseen message
S: * OK [UIDVALIDITY 1] UIDs valid
S: * OK [UIDNEXT 3] Predicted next UID
S: A3 OK [READ-WRITE] Completed
C: A4 FETCH 1:2 (INTERNALDATE SAVEDATE)
S: * 1 FETCH (INTERNALDATE "15-Jan-2026 09:30:00 +0000" SAVEDATE "15-Jan-2026 09:30:00 +0000")
S: * 2 FETCH (INTERNALDATE "15-Jan-2026 09:30:00 +0000" SAVEDATE "15-Jan-2026 09:30:00 +0000")
S: A4 OK FETCH Completed
```

:::tip
The dates are formatted in the time zone of the process. The same instant is `15-Jan-2026 11:30:00 +0200` with `TZ=Europe/Tallinn`. Set `TZ=UTC` (or any fixed zone) for the test run when you compare date strings.
:::

A function gives the test a clock it can move:

```javascript
let clock = Date.parse('2026-01-15T09:30:00Z');
const server = imapkit({ now: () => clock });

server.control.addMessage('INBOX', { raw: 'Subject: a\r\n\r\n' });
clock += 60 * 60 * 1000; // one hour later
server.control.addMessage('INBOX', { raw: 'Subject: b\r\n\r\n' });

server.control.listMessages('INBOX').map(message => message.internaldate);
// [ '15-Jan-2026 09:30:00 +0000', '15-Jan-2026 10:30:00 +0000' ]
```

`now` does not change timers: [`quiet`](./scripted-faults.md#events) rules, `delay` and `chunkDelay` run on the real clock.

## Seeded UID shuffles

[`server.control.resetUidValidity()`](../control-api/uidvalidity.md) gives a mailbox a new UIDVALIDITY, and with `uids: 'shuffle'` numbers the messages 1 to n in a random order, so an old UID now points to another message. That catches a client that keeps cached UIDs without checking UIDVALIDITY. `seed` makes the order repeatable:

```javascript
const storage = { INBOX: { messages: ['a', 'b', 'c', 'd', 'e'].map((s, i) => ({ uid: i + 1, raw: 'Subject: ' + s + '\r\n\r\n' })) } };

imapkit({ storage }).control.resetUidValidity('INBOX', { uids: 'shuffle', seed: 7 });
```

Two separate servers gave the same result:

```json
{
    "uidvalidity": 2,
    "uidnext": 6,
    "uids": [
        { "uid": 1, "newUid": 4 },
        { "uid": 2, "newUid": 2 },
        { "uid": 3, "newUid": 3 },
        { "uid": 4, "newUid": 5 },
        { "uid": 5, "newUid": 1 }
    ]
}
```

The shuffle has its own generator, so it does not use up numbers of `scriptSeed`. `seed` must be an integer. The other modes, `keep`, `renumber` and `offset`, have no randomness at all.

## control.reset()

`server.control.reset()` restores the mailboxes and users of the server options and disconnects every session with `BYE`. For repeatable runs it also matters what it does with the random numbers and the script rules:

- The `scriptSeed` sequence starts again from the beginning, so the run after a reset gets the same faults as the first run.
- Script rules stay, and so do their `matched` and `hits` counters. A `times: 1` rule that fired before the reset does not fire again. Call `server.script.clear()` and add the rules again when every test needs them fresh.
- The storage is copied from the option again, so messages without `internaldate` get the time of `now` again. Without `now` they get the time of the reset.

```javascript
afterEach(() => {
    server.control.reset();
    server.script.clear();
});
```

The REST API has the same as `POST /v1/reset` (and `DELETE /v1/script/rules`), see [Testing from other languages](../guides/testing-from-other-languages.md).

## Storage validation catches fixture typos

The `storage` option is checked when the server is built. A key that looks like a typo of a known one, or a value of the wrong type, fails with the path of the problem, instead of turning into an empty mailbox and a confusing test failure:

```javascript
imapkit({ storage: { INBOX: { message: [] } } });
// Error: Invalid storage at "INBOX": unknown key "message", did you mean "messages"?

imapkit({ storage: { INBOX: { messages: [{ raw: 'x' }, { raw: 'y' }, { raw: 'Subject: x\r\n\r\n', flag: ['\\Seen'] }] } } });
// Error: Invalid storage at "INBOX".messages[2]: unknown key "flag", did you mean "flags"?

imapkit({ storage: { INBOX: { uidValidity: 5 } } });
// Error: Invalid storage at "INBOX": unknown key "uidValidity", did you mean "uidvalidity"?

imapkit({ storage: { INBOX: { uidnext: 0 } } });
// Error: Invalid storage at "INBOX".uidnext: must be an integer from 1 to 4294967295
```

A key counts as a typo when it is a known key in another case, or one edit away from a known key (for keys longer than 3 characters). Plugins keep their own data on mailboxes and messages (`acl`, `metadata`, `MODSEQ` ...), so other keys are allowed.

The package exports the check and the shape, so fixtures can be checked in a unit test of their own, or in an editor:

```javascript
import { validateStorage, storageSchema } from 'imapkit';

validateStorage(fixture); // throws the same errors as the server
storageSchema; // JSON Schema (draft 2020-12) with $defs message, mailbox and namespace
```

`server.control.snapshot()` returns the storage in the same shape, so a state reached in one test can become the fixture of another: `imapkit({ storage: server.control.snapshot() })` starts from it. See [Storage](../guides/storage.md).
