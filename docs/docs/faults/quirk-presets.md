---
title: Quirk Presets
sidebar_position: 2
description: Named sets of script rules that make ImapKit behave like Apache James, Yahoo, Microsoft 365, or a server without MOVE or UIDPLUS.
---

# Quirk Presets

A quirk preset makes ImapKit behave like a known real server, so a client test reproduces that server's bug in every run, without access to the server itself. A preset is a set of [script rules](./scripted-faults.md), plugins it leaves out, or both.

```javascript
import imapkit from 'imapkit';

const server = imapkit({
    plugins: ['IDLE', 'MOVE'],
    quirks: ['james-fetchgroup', 'm365-throttle'],
    scriptSeed: 42
});
```

From the command line, `--quirk` takes a comma separated list or can be repeated, and `IMAPKIT_QUIRKS` does the same from the environment:

```bash
imapkit -p 1143 --plugin=IDLE,MOVE --quirk=no-move --quirk=m365-throttle --script-seed=5
```

## The `quirks` option

- `quirks` takes a name or a list of names. Names are case-insensitive.
- An unknown name fails the server constructor with the list of known ones: `Unknown quirk "james". Available quirks: james-fetchgroup, james-late-fetch, yahoo-quoted-sections, m365-throttle, no-uidplus, no-move`.
- The rules of the presets are added after the rules of the `script` option, in the order the presets are listed. Rules you add later with `server.script.add()` come after them. As the first matching rule handles an event, a rule of your own in `script` can take an event before a preset sees it.
- The rules of a preset are ordinary script rules: they show up in `server.script.rules`, count `hits`, emit the `script` event, and `server.script.clear()` removes them too.
- `removePlugins` of a preset keeps the plugins out even when the `plugins` option lists them, and also when another plugin requires them. With `IMAP4rev2`, `no-move` and `no-uidplus` still remove MOVE and UIDPLUS, which gives a server that [RFC 9051](https://www.rfc-editor.org/rfc/rfc9051) does not allow. Use them with IMAP4rev1 servers.

## The presets

| Quirk                   | Reproduces                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `james-fetchgroup`      | Apache James FetchGroup: only the first section asked for a part in one FETCH is answered, later ones for the same part are empty  |
| `james-late-fetch`      | Apache James: 1 in 4 FETCH responses come after the tagged OK of their command                                                     |
| `yahoo-quoted-sections` | Yahoo: short body sections (up to 100 octets without line breaks) are quoted strings instead of literals                           |
| `m365-throttle`         | Microsoft 365: 1 in 10 commands (not LOGOUT) is refused with `BAD Request is throttled. Suggested Backoff Time: 1000 milliseconds` |
| `no-uidplus`            | a server without UIDPLUS: no APPENDUID, COPYUID or UID EXPUNGE                                                                     |
| `no-move`               | a server without MOVE                                                                                                              |

The transcripts below come from real runs against ImapKit, with this message as UID 1 in INBOX:

```text
From: alice@example.com
Subject: parts
Content-Type: multipart/mixed; boundary=x

--x
Content-Type: text/plain

hello
--x
Content-Type: text/plain

second part
--x--
```

### james-fetchgroup

A client that wants the MIME headers and the body of an attachment often asks for both in one FETCH. Apache James answers only the first section it is asked for a part, and every later section of the same part comes back as an empty literal. `BODY[2.MIME] BODY[2]` gives a zero-length body, the reverse order loses the headers. Sections of different parts are both answered.

A client that trusts the server stores an empty attachment. A careful one notices the zero length where `BODYSTRUCTURE` promised more and fetches the section again on its own.

```text
C: A3 FETCH 1 (BODY.PEEK[2.MIME] BODY.PEEK[2])
S: * 1 FETCH (BODY[2.MIME] {28}
S: Content-Type: text/plain
S:
S:  BODY[2] {0}
S: )
S: A3 OK FETCH Completed
C: A4 FETCH 1 (BODY.PEEK[2] BODY.PEEK[2.MIME])
S: * 1 FETCH (BODY[2] {11}
S: second part BODY[2.MIME] {0}
S: )
S: A4 OK FETCH Completed
C: A5 FETCH 1 (BODY.PEEK[1] BODY.PEEK[2])
S: * 1 FETCH (BODY[1] {5}
S: hello BODY[2] {11}
S: second part)
S: A5 OK FETCH Completed
```

`HEADER`, `TEXT` and `MIME` belong to the part they are on: `2.MIME`, `2.HEADER` and `2` are the same part, `HEADER` and `TEXT` without a number belong to the message itself. The preset applies to `FETCH` and `UID FETCH`.

### james-late-fetch

Now and then an untagged FETCH response arrives after the tagged OK of its command, a quarter of the time on average. A client that collects FETCH data only until the tagged response misses those messages, or attributes them to the next command. The responses are held back with [`defer: 'tagged'`](./scripted-faults.md#defer), so every FETCH is still answered, some of them late. With `scriptSeed: 3`, six identical FETCH commands gave:

```text
C: A3 FETCH 1 (UID)
S: * 1 FETCH (UID 1)
S: A3 OK FETCH Completed
C: A4 FETCH 1 (UID)
S: A4 OK FETCH Completed
S: * 1 FETCH (UID 1)
C: A5 FETCH 1 (UID)
S: * 1 FETCH (UID 1)
S: A5 OK FETCH Completed
C: A6 FETCH 1 (UID)
S: A6 OK FETCH Completed
S: * 1 FETCH (UID 1)
C: A7 FETCH 1 (UID)
S: * 1 FETCH (UID 1)
S: A7 OK FETCH Completed
C: A8 FETCH 1 (UID)
S: * 1 FETCH (UID 1)
S: A8 OK FETCH Completed
```

### yahoo-quoted-sections

The value of a body section is an `nstring`, and a string is either quoted or a literal ([RFC 3501](https://www.rfc-editor.org/rfc/rfc3501) section 9). ImapKit sends sections as literals, Yahoo sends short ones as quoted strings. A client whose parser only expects a literal after `BODY[...]` breaks on the quoted form.

The preset quotes sections of up to 100 octets of printable ASCII. A section with a line break can not be a quoted string, so it stays a literal:

```text
C: A3 FETCH 1 (BODY.PEEK[1] BODY.PEEK[1.MIME])
S: * 1 FETCH (BODY[1] "hello" BODY[1.MIME] {28}
S: Content-Type: text/plain
S:
S: )
S: A3 OK FETCH Completed
```

### m365-throttle

Microsoft 365 refuses commands it is throttling with a tagged BAD. Many clients treat BAD as a protocol error of their own and give up or reconnect, where they should wait and send the command again. The preset refuses 1 in 10 commands, except LOGOUT. Any other command can be hit, LOGIN included, so the client's login code needs the retry too.

With `scriptSeed: 5` the fifth command was throttled. This run used an INBOX with two messages, the storage of the [scripted faults cookbook](./scripted-faults.md#cookbook):

```text
S: * OK ImapKit ready for rumble
C: A1 LOGIN testuser testpass
S: A1 OK User logged in
C: A2 SELECT INBOX
S: * FLAGS (\Answered \Flagged \Draft \Deleted \Seen)
S: * OK [PERMANENTFLAGS (\Answered \Flagged \Draft \Deleted \Seen \*)] Flags permitted
S: * 2 EXISTS
S: * 0 RECENT
S: * OK [UNSEEN 1] First unseen message
S: * OK [UIDVALIDITY 1] UIDs valid
S: * OK [UIDNEXT 3] Predicted next UID
S: A2 OK [READ-WRITE] Completed
C: A3 NOOP
S: A3 OK Completed
C: A4 FETCH 1 (FLAGS)
S: * 1 FETCH (FLAGS ())
S: A4 OK FETCH Completed
C: A5 FETCH 2 (FLAGS)
S: A5 BAD Request is throttled. Suggested Backoff Time: 1000 milliseconds
C: A6 FETCH 2 (FLAGS)
S: * 2 FETCH (FLAGS ())
S: A6 OK FETCH Completed
C: A7 LOGOUT
S: * BYE LOGOUT received
S: A7 OK Completed
[connection closed]
```

A throttled command did not run: a throttled LOGIN leaves the session unauthenticated, a throttled STORE changes no flags.

### no-uidplus and no-move

These presets leave plugins out. The client has to work without APPENDUID, COPYUID and UID EXPUNGE ([RFC 4315](https://www.rfc-editor.org/rfc/rfc4315)), and without MOVE ([RFC 6851](https://www.rfc-editor.org/rfc/rfc6851)), falling back to COPY, STORE `\Deleted` and EXPUNGE. With `plugins: ['IDLE', 'MOVE', 'UIDPLUS']` and `quirks: ['no-move', 'no-uidplus']`:

```text
C: A2 CAPABILITY
S: * CAPABILITY IMAP4rev1 IDLE
S: A2 OK Completed
C: A3 SELECT INBOX
...
S: A3 OK [READ-WRITE] Completed
C: A4 MOVE 1 INBOX
S: A4 BAD Invalid command MOVE
```

## Repeatable runs with scriptSeed

`james-late-fetch` and `m365-throttle` decide with [`chance`](./scripted-faults.md#matchers). The random numbers come from the `scriptSeed` option (`--script-seed`, `IMAPKIT_SCRIPT_SEED`): with the same seed and a client that sends the same commands in the same order, every run gets the same faults. Without a seed, each server picks a random one.

All `chance` rules of a server, from presets and from your own rules, draw from the same sequence, in the order the events happen. A client that sends one more command, or two sessions that race, shift which commands get hit. See [Repeatable tests](./repeatable-tests.md).

## Presets as data

The presets are exported, so you can read what they do and copy one when it does not fit:

```javascript
import { quirks } from 'imapkit';
// CommonJS: const { quirks } = require('imapkit');

console.log(Object.keys(quirks));
// [ 'james-fetchgroup', 'james-late-fetch', 'yahoo-quoted-sections', 'm365-throttle', 'no-uidplus', 'no-move' ]

console.log(quirks['james-late-fetch']);
// {
//   description: 'Apache James: now and then (1 in 4) a FETCH response comes after the tagged OK of its command',
//   rules: [ { on: 'response', command: [ 'FETCH', 'UID FETCH' ], untagged: true, chance: 0.25, defer: 'tagged' } ]
// }
```

Each preset has a `description`, and `rules` (script rules), `removePlugins` (plugin names), or both. The TypeScript type is `Quirk`.

To change a preset, copy its rules into the `script` option instead of naming it in `quirks`:

```javascript
import imapkit, { quirks } from 'imapkit';

// late FETCH responses half of the time, and only for UID FETCH
const server = imapkit({
    scriptSeed: 1,
    script: quirks['james-late-fetch'].rules.map(rule => ({ ...rule, command: 'UID FETCH', chance: 0.5 }))
});
```

## Writing your own preset

A preset is nothing more than script rules and a list of plugins, so a quirk of a server you meet in the field becomes a few lines of configuration. Keep the rules in one place and spread them into the `script` option, leaving the plugins out of `plugins` yourself:

```javascript title="test/quirks/legacy-server.js"
// a server that answers NOOP with BAD now and then, sends LIST names as literals,
// and has no IDLE
export const legacyServer = {
    rules: [
        { on: 'command', command: 'NOOP', chance: 0.2, send: '$TAG BAD Try again\r\n' },
        { on: 'response', command: 'LIST', untagged: true, literals: true }
    ],
    plugins: ['MOVE', 'UIDPLUS'] // IDLE left out
};
```

```javascript
import imapkit from 'imapkit';
import { legacyServer } from './quirks/legacy-server.js';

const server = imapkit({ plugins: legacyServer.plugins, script: legacyServer.rules, scriptSeed: 7 });
```

For the command line, write the rules as JSON (strings for `match` and `send`, no functions) and pass the file with `--script`. Rules that need `mutate`, like `james-fetchgroup` and `yahoo-quoted-sections`, work only from JavaScript.
