---
title: Scripted Faults
sidebar_position: 1
description: Script rules make ImapKit deviate from the protocol on purpose, so you can test how your IMAP client copes with broken, slow or unusual servers.
---

# Scripted Faults

ImapKit is strict and correct by default. Real servers are not: they answer with NO when you least expect it, cut a response in the middle of a literal, send a FETCH after the tagged OK, or drop the connection while the client is idling. Script rules let you put those faults into a test at exactly the point you want, and nowhere else.

A rule watches one kind of event (a command line from the client, a response the server is about to send, a quiet period ...), narrows it down with matchers, and says what to do instead with actions:

```javascript title="test/faults.test.js"
import imapkit from 'imapkit';

const server = imapkit({
    plugins: ['IDLE'],
    script: [
        // the first SELECT gets NO, the next ones run as usual
        { on: 'command', command: 'SELECT', times: 1, send: '$TAG NO [UNAVAILABLE] Try again later\r\n' },
        // the body of message 1 is cut short and the connection dropped
        { on: 'response', command: 'FETCH', match: /^\* 1 FETCH .*BODY\[\]/, truncate: 40 }
    ]
});
const port = await server.start();
```

Faults change only the output and the handling of the lines a rule matches. The state of the server stays consistent: a LOGIN that a rule answers with `OK` does not log the session in, and a dropped EXPUNGE response still removes the message. Script rules are for tests only, a rule can send anything at all.

## Adding and removing rules

Rules come from two places:

- the `script` server option, a rule or a list of rules, added when the server is built
- `server.script.add(rule)` or `server.script.add([rules])` at runtime, also while clients are connected

Rules are checked in the order they were added. The rules of [quirk presets](./quirk-presets.md) come right after the rules of the `script` option, and rules added later with `server.script.add()` after those.

`add()` returns a handle for a rule, or a list of handles for a list of rules:

| Handle property | Meaning                                                                           |
| --------------- | --------------------------------------------------------------------------------- |
| `id`            | the number of the rule, 1 for the first rule added to the server                  |
| `rule`          | a frozen copy of the rule, changing your object later does not change the rule    |
| `matched`       | events that matched the rule's matchers, also those before `nth` or after `times` |
| `hits`          | events the rule actually handled                                                  |
| `remove()`      | removes the rule                                                                  |

`server.script.rules` lists the handles in the order they are checked, and `server.script.clear()` removes every rule.

```javascript
const [literals, late] = server.script.add([
    // every string the grammar allows is sent as a literal
    { on: 'response', untagged: true, literals: true },
    // the FETCH response of UID 2 arrives after the tagged OK
    { on: 'response', command: 'UID FETCH', untagged: true, match: /UID 2\b/, times: 1, defer: 'tagged' }
]);

// ... run the client

assert.strictEqual(late.hits, 1);
literals.remove();
```

A list is checked as a whole before any rule of it is added: if one rule is invalid, none are added.

:::note
`server.control.reset()` restores mailboxes and users but keeps the script rules, together with their `matched` and `hits` counters. A `times: 1` rule that already fired stays used up. Call `server.script.clear()` and add the rules again when a test needs them fresh. See [Repeatable tests](./repeatable-tests.md).
:::

## Events

Every rule has an `on` key that names the event it watches:

| Event          | What it is                                                                                                                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `greeting`     | the `* OK ImapKit ready for rumble` greeting of a new connection                                                                                                                                                |
| `command`      | a complete command line from the client, with its literals. The rule acts instead of the parser and the command handler, so it also matches lines that do not parse and commands that do not exist              |
| `input`        | a line read by a command that takes over the input: `DONE` of IDLE, or a SASL response of AUTHENTICATE                                                                                                          |
| `response`     | every response the server sends with `connection.send()`, tagged and untagged, as the exact bytes about to go out, after every plugin and the core changed the response                                         |
| `continuation` | a `+` continuation request: for a synchronizing literal, IDLE, or AUTHENTICATE                                                                                                                                  |
| `quiet`        | the session had no input and no output for `quietFor` milliseconds. Whatever the rule sends starts the next quiet time. While IDLE runs, the event belongs to the IDLE command, so `command: 'IDLE'` matches it |

Some details worth knowing:

- A `command` rule is chosen when the line arrives, so matchers like `state` see the session as it was at that moment. The rule acts when the command's turn comes, so the responses of pipelined commands stay in order.
- For a command with literals, the `command` event fires once for the whole command. Its `data` is the line with the literal data, without the final CRLF, e.g. `A1 APPEND INBOX {5}\r\nhello`.
- The name of an `AUTHENTICATE` command includes the mechanism (`AUTHENTICATE PLAIN`), and `UID` commands include the subcommand (`UID FETCH`).
- An unsolicited response (for example an EXISTS another session caused) belongs to the command that is running, or to the command that reads input, like IDLE.

## Matchers

All the matchers a rule gives have to match. The first rule that matches and is not used up handles the event, so a later rule can handle what an earlier one leaves alone.

| Matcher       | Events                     | Matches                                                                                                                                                                             |
| ------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`     | all but `greeting`         | a command name or a list of names, case-insensitive (`'FETCH'`, `['FETCH', 'UID FETCH']`)                                                                                           |
| `tag`         | all but `greeting`         | the command tag, a string matches exactly, or a RegExp                                                                                                                              |
| `description` | `response`, `continuation` | the description the server passed to `connection.send()`, or a list of them (see [Finding descriptions](#finding-descriptions))                                                     |
| `untagged`    | `response`                 | `true` for untagged responses only, `false` for tagged ones only                                                                                                                    |
| `session`     | all                        | the number of the connection, or a list of numbers, 1 for the first connection the server accepted                                                                                  |
| `state`       | all                        | the session state, `'Not Authenticated'`, `'Authenticated'` or `'Selected'`, or a list of them                                                                                      |
| `user`        | all                        | the name of the authenticated user                                                                                                                                                  |
| `mailbox`     | all                        | the path of the selected mailbox (`'INBOX'`, `'Archive'`)                                                                                                                           |
| `match`       | all                        | a RegExp, or a string with a regular expression, tested against the event `data`: the command line, the input line, or the output bytes. Global and sticky flags are dropped        |
| `when`        | all                        | a function that gets the [event context](#the-event-context) and returns true to match                                                                                              |
| `nth`         | all                        | the rule fires from the nth matching event on (default 1)                                                                                                                           |
| `times`       | all                        | the rule fires this many times at most, then lets later rules handle the event                                                                                                      |
| `chance`      | all                        | the rule fires on a matching event with this probability, a number from 0 to 1. The random numbers come from the `scriptSeed` option, see [Repeatable tests](./repeatable-tests.md) |
| `quietFor`    | `quiet` (required there)   | milliseconds without input or output, a positive integer                                                                                                                            |

The counting matchers work in this order: an event that passes every other matcher counts toward `matched`, then `nth` and `times` decide whether the rule may fire, and only then is a random number drawn for `chance`. `when` runs last among the other matchers, so it sees only events that passed them.

## Actions

Actions say what happens instead of the usual behavior. A rule needs at least one action.

| Action       | Events                                                     | Effect                                                                                                                                                                                                                                 |
| ------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send`       | all                                                        | output events: bytes sent instead of the output. `command` and `input`: bytes sent instead of processing the line. `quiet`: bytes sent when the time is up                                                                             |
| `run`        | `command`, `input`                                         | process the line as usual after `send`, to add output before the real response                                                                                                                                                         |
| `drop`       | `greeting`, `command`, `input`, `response`, `continuation` | output events: send nothing. `command` and `input`: ignore the line, the client gets no answer                                                                                                                                         |
| `mutate`     | `response`, `continuation`                                 | `(response, context)` gets a copy of the response object before it is compiled, and changes it or returns another one                                                                                                                  |
| `literals`   | `response`                                                 | sends every string of the response that the grammar allows as a literal                                                                                                                                                                |
| `defer`      | `response`                                                 | holds an untagged response back: `'tagged'` sends it right after the tagged response of its command, `'next'` with the answer to the next command, before its first response                                                           |
| `before`     | `greeting`, `response`, `continuation`                     | bytes sent before the output                                                                                                                                                                                                           |
| `after`      | `greeting`, `response`, `continuation`                     | bytes sent after the output                                                                                                                                                                                                            |
| `delay`      | `greeting`, `command`, `response`, `continuation`          | milliseconds to wait. Output: before it goes out, and all later output waits behind it. Command: before the rule acts or the command runs, and later commands wait too                                                                 |
| `chunk`      | all                                                        | write the bytes in pieces of this many octets                                                                                                                                                                                          |
| `chunkDelay` | all, needs `chunk`                                         | milliseconds between the pieces, default 10. `0` or `'tick'` sends each piece on its own event loop turn, so the pieces leave as separate TCP segments without a wall clock delay                                                      |
| `truncate`   | all                                                        | send only this many octets of the bytes, then close the connection                                                                                                                                                                     |
| `close`      | all                                                        | close the connection after the bytes are sent. `'reset'` destroys the socket instead (a TCP RST where the runtime supports it), 20 ms after the bytes so the RST does not overtake them. Input that arrives meanwhile is not processed |

### Bytes: strings, Buffers and functions

`send`, `before` and `after` take a string, a Buffer, or a function that gets the [event context](#the-event-context) and returns a string or a Buffer.

- Nothing is added: a response needs its own `\r\n`.
- `$TAG` in a string is replaced with the tag of the command, or `*` when the event has no tag (the greeting, unsolicited responses).
- A string is a binary string, one character per octet, like everywhere in ImapKit. If it contains a character above U+00FF, the whole string is sent as UTF-8 instead. So `'caf\xc3\xa9'` and `'café ✓'` both arrive as valid UTF-8, while `'café'` alone (all characters below U+0100) arrives as the single octet `0xE9` for `é`.
- A Buffer is sent as it is, `$TAG` is not replaced in it.

### mutate

`mutate` works on the response object (`{ tag, command, attributes }`) instead of bytes, so the result is still valid IMAP as far as the compiler can tell. The object is a copy: a notification that goes to several sessions changes only for the session the rule matched.

```javascript
// every SELECT reports 5 messages, whatever the mailbox holds
server.script.add({
    on: 'response',
    command: 'SELECT',
    match: /EXISTS/,
    mutate: response => {
        response.attributes[0] = 5;
    }
});
```

If the changed response does not compile, a tagged response is sent as `NO [SERVERBUG] Failed to compile response` and an untagged one is dropped. Use `send` for output that is not valid IMAP. Continuation requests have a response object only when a plugin sends them with `connection.send()` (the error challenges of XOAUTH2 and OAUTHBEARER), for other continuations `mutate` does nothing.

### literals

`literals: true` turns every string of a response into a literal wherever the grammar allows one (string, nstring and astring in [RFC 9051](https://www.rfc-editor.org/rfc/rfc9051) section 9). This is valid IMAP that many clients still get wrong. Positions that take only a quoted string stay quoted:

- the hierarchy delimiter of LIST, LSUB and NAMESPACE
- CHILDINFO values ([RFC 5258](https://www.rfc-editor.org/rfc/rfc5258) section 6)
- INTERNALDATE and SAVEDATE
- the media types `"TEXT"` and `"MESSAGE" "RFC822"` (or `"GLOBAL"`) in a body structure

Atoms, numbers, NIL, response codes and human readable text stay as they are. `literals` works together with `mutate`, after it.

### defer

`defer` needs `untagged: true`, since a tagged response ends its command and there is nothing to hold it back for. `send`, `before` and `after` change the held output. `drop`, `delay`, `chunk`, `truncate` and `close` can not be combined with it.

A response that does not belong to a command (one that arrives during IDLE belongs to IDLE) is held for the next tagged response or command. Held responses are dropped when the connection closes.

### Rules for commands and input lines

- `send` replaces the processing of the line. Add `run: true` to process the line as usual after the bytes.
- A rule with only `delay` (and `run`) delays the line and then processes it as usual.
- `chunk` and `truncate` need `send`, since a command or input line has no output of its own to cut.
- `drop` can not be combined with `send` or `run`, and `run` can not be combined with `close` or `truncate`.

## The event context

`when`, `mutate` and the function form of `send`, `before` and `after` get the event context:

| Field         | Value                                                                              |
| ------------- | ---------------------------------------------------------------------------------- |
| `event`       | the event name                                                                     |
| `connection`  | the `IMAPConnection` of the session                                                |
| `session`     | the connection number, 1 for the first one                                         |
| `state`       | the session state                                                                  |
| `user`        | the authenticated user, or null                                                    |
| `mailbox`     | the path of the selected mailbox, or null                                          |
| `tag`         | the tag of the command the event belongs to, or null                               |
| `command`     | the upper case name of that command (`'UID FETCH'`), or null                       |
| `data`        | the command or input line, or the bytes about to be sent, as a binary string       |
| `description` | `response` and `continuation`: the description passed to `connection.send()`       |
| `response`    | `response` (and `continuation` sent with `connection.send()`): the response object |
| `quiet`       | `quiet`: milliseconds without input or output                                      |

```javascript
server.script.add({
    on: 'response',
    command: 'NOOP',
    untagged: false,
    send: context => context.tag + ' OK Žluťoučký\r\n' // characters above U+00FF, sent as UTF-8
});
```

### Finding descriptions

The `description` matcher compares the name the server gives each response internally. To see them, add a rule whose `when` logs the context and returns false. It never fires, so it changes nothing (`after: ''` is only there because a rule needs an action):

```javascript
server.script.add([
    {
        on: 'response',
        when: ctx => (console.log(ctx.command, ctx.description, JSON.stringify(ctx.data)), false),
        after: ''
    },
    { on: 'continuation', when: ctx => (console.log(ctx.command, ctx.description), false), after: '' }
]);
```

For a LOGIN, SELECT, FETCH, IDLE and LOGOUT this printed:

```text
LOGIN LOGIN SUCCESS "A1 OK User logged in\r\n"
SELECT SELECT FLAGS "* FLAGS (\\Answered \\Flagged \\Draft \\Deleted \\Seen)\r\n"
SELECT SELECT PERMANENTFLAGS "* OK [PERMANENTFLAGS ..."
SELECT SELECT EXISTS "* 1 EXISTS\r\n"
SELECT SELECT RECENT "* 0 RECENT\r\n"
SELECT SELECT UNSEEN "* OK [UNSEEN 1] First unseen message\r\n"
SELECT SELECT UIDVALIDITY "* OK [UIDVALIDITY 1] UIDs valid\r\n"
SELECT SELECT UIDNEXT "* OK [UIDNEXT 2] Predicted next UID\r\n"
SELECT SELECT "A2 OK [READ-WRITE] Completed\r\n"
FETCH FETCH "* 1 FETCH (FLAGS ())\r\n"
FETCH FETCH "A3 OK FETCH Completed\r\n"
IDLE IDLE
IDLE IDLE "A4 OK IDLE terminated\r\n"
LOGOUT LOGOUT UNTAGGED "* BYE LOGOUT received\r\n"
LOGOUT LOGOUT COMPLETED "A5 OK Completed\r\n"
```

The continuation requests are `LITERAL`, `IDLE`, `AUTHENTICATE PLAIN` and `AUTHENTICATE OAUTHBEARER`, and the error challenges `AUTHENTICATE XOAUTH2 FAILED` and `AUTHENTICATE OAUTHBEARER CHALLENGE`.

## The `script` event

The server emits a `script` event every time a rule fires, with `{ rule, event, session, tag, command }`:

```javascript
server.on('script', ({ rule, event, session, tag, command }) => {
    console.log('rule fired', event, session, tag, command);
});
```

The [REST event stream](../rest-api/event-stream.md) carries it too (`GET /v1/events?types=script`):

```text
event: script
data: {"rule":{"on":"command","command":"NOOP","times":1,"send":"$TAG NO [UNAVAILABLE] Not now\r\n"},"event":"command","session":3,"tag":"A1","command":"NOOP"}
```

## JSON rules: the command line and the REST API

The `imapkit` command reads rules as JSON from `--script=<path>` (or the `IMAPKIT_SCRIPT` environment variable), or from `script` in the `--config` file. In JSON, `match` is a string with a regular expression and `send`, `before` and `after` are strings. Functions (`when`, `mutate`, and function values of `send`) work only from JavaScript.

```json title="faults.json"
[
    { "on": "greeting", "send": "* BYE Too many connections\r\n", "close": true, "times": 1 },
    { "on": "response", "command": "FETCH", "untagged": true, "send": "* 1 FETCH (BODY[] {100}\r\nshort", "close": true }
]
```

```bash
imapkit -p 1143 --rest-port=8143 --script=faults.json
```

The first connection is turned away, the second one gets a literal that announces 100 octets and delivers 5:

```text
S: * BYE Too many connections
[connection closed]
```

```text
S: * OK ImapKit ready for rumble
C: A1 LOGIN testuser testpass
S: A1 OK User logged in
C: A2 SELECT INBOX
S: * FLAGS (\Answered \Flagged \Draft \Deleted \Seen)
S: * OK [PERMANENTFLAGS (\Answered \Flagged \Draft \Deleted \Seen \*)] Flags permitted
S: * 1 EXISTS
S: * 0 RECENT
S: * OK [UNSEEN 1] First unseen message
S: * OK [UIDVALIDITY 1] UIDs valid
S: * OK [UIDNEXT 2] Predicted next UID
S: A2 OK [READ-WRITE] Completed
C: A3 FETCH 1 BODY[]
S: * 1 FETCH (BODY[] {100}
S: short   [no CRLF]
[connection closed]
```

With the [REST API](../rest-api/endpoints.md) on, rules in the same JSON form can be listed, added and removed at runtime, without a restart:

| Endpoint                       | Does                                                                |
| ------------------------------ | ------------------------------------------------------------------- |
| `GET /v1/script/rules`         | lists the rules as `{ id, rule, matched, hits }`                    |
| `POST /v1/script/rules`        | adds a rule or a list of rules, answers `201` with the same shape   |
| `DELETE /v1/script/rules`      | removes every rule                                                  |
| `DELETE /v1/script/rules/{id}` | removes one rule, `404` with `NONEXISTENT` if there is no such rule |

```bash
curl -X POST http://127.0.0.1:8143/v1/script/rules \
     -H 'Content-Type: application/json' \
     -d '{"on":"command","command":"NOOP","times":1,"send":"$TAG NO [UNAVAILABLE] Not now\r\n"}'
```

```json
{ "id": 3, "rule": { "on": "command", "command": "NOOP", "times": 1, "send": "$TAG NO [UNAVAILABLE] Not now\r\n" }, "matched": 0, "hits": 0 }
```

An invalid rule is answered with `400`:

```json
{ "error": { "code": "INVALID", "message": "Unknown script rule option \"comand\"" } }
```

## Validation

Rules are checked when they are added. A mistake throws a `TypeError` right away (or fails the server constructor, for the `script` option), so a typo can not turn into a rule that silently never fires:

| Rule                                                               | Error                                                                                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `{ on: 'response', command: 'FETCH', untagged: true, dorp: true }` | `Unknown script rule option "dorp"`                                                                                      |
| `{ on: 'greeting', command: 'LOGIN', drop: true }`                 | `Script rule option "command" can not be used with "on": "greeting"`                                                     |
| `{ on: 'response', command: 'FETCH' }`                             | `A script rule needs an action (mutate, literals, defer, send, before, after, run, drop, delay, chunk, truncate, close)` |
| `{ on: 'response', defer: 'tagged' }`                              | `Script rule option "defer" needs "untagged": true`                                                                      |
| `{ on: 'quiet', send: 'x' }`                                       | `A quiet rule needs "quietFor", a positive number of milliseconds`                                                       |
| `{ on: 'command', chunk: 5 }`                                      | `Script rule options "chunk" and "truncate" need "send" with "on": "command"`                                            |
| `{ on: 'response', match: '(', drop: true }`                       | `Script rule option "match" is not a valid regular expression: Invalid regular expression: /(/: Unterminated group`      |
| `{ on: 'response', chance: 2, drop: true }`                        | `Script rule option "chance" must be a number from 0 to 1`                                                               |

Other checks: `nth`, `times` and `chunk` must be positive integers, `delay`, `chunkDelay` and `truncate` non-negative integers (`chunkDelay` may also be `'tick'`), `chunkDelay` needs `chunk`, `close` is `true`, `false` or `'reset'`, `defer` is `'tagged'` or `'next'`, and `literals` is `true` or `false`.

## Cookbook

Every transcript below comes from a real run against ImapKit, read with a raw socket client. `C:` lines are what the client sent, `S:` lines what the server sent, `[no CRLF]` marks output that ends in the middle of a line. The examples use this storage:

```javascript
const storage = {
    INBOX: {
        messages: [
            { uid: 1, raw: 'From: alice@example.com\r\nSubject: hello\r\n\r\nHello world!\r\n' },
            { uid: 2, raw: 'From: bob@example.com\r\nSubject: again\r\n\r\nSecond message\r\n' }
        ]
    }
};
```

### NO on the first SELECT

Does the client retry, or give up and report the mailbox as broken? `times: 1` makes the second SELECT run as usual. `UNAVAILABLE` is a response code of [RFC 5530](https://www.rfc-editor.org/rfc/rfc5530).

```javascript
{ on: 'command', command: 'SELECT', times: 1, send: '$TAG NO [UNAVAILABLE] Try again later\r\n' }
```

```text
S: * OK ImapKit ready for rumble
C: A1 LOGIN testuser testpass
S: A1 OK User logged in
C: A2 SELECT INBOX
S: A2 NO [UNAVAILABLE] Try again later
C: A3 SELECT INBOX
S: * FLAGS (\Answered \Flagged \Draft \Deleted \Seen)
S: * OK [PERMANENTFLAGS (\Answered \Flagged \Draft \Deleted \Seen \*)] Flags permitted
S: * 2 EXISTS
S: * 0 RECENT
S: * OK [UNSEEN 1] First unseen message
S: * OK [UIDVALIDITY 1] UIDs valid
S: * OK [UIDNEXT 3] Predicted next UID
S: A3 OK [READ-WRITE] Completed
C: A4 LOGOUT
S: * BYE LOGOUT received
S: A4 OK Completed
[connection closed]
```

### A FETCH body cut in the middle of a literal

The literal announces 57 octets, the connection closes after 16 of them. The client must report an error, not store a partial message.

```javascript
{ on: 'response', command: 'FETCH', match: /^\* 1 FETCH .*BODY\[\]/, truncate: 40 }
```

```text
C: A3 FETCH 1 BODY.PEEK[]
S: * 1 FETCH (BODY[] {57}
S: From: alice@exam   [no CRLF]
[connection closed]
```

### A FETCH response after the tagged OK

Some servers now and then send an untagged FETCH after the tagged OK of its command. A client that collects FETCH data only until the tagged response loses the message.

```javascript
{ on: 'response', command: 'UID FETCH', untagged: true, match: /UID 2\b/, times: 1, defer: 'tagged' }
```

```text
C: A3 UID FETCH 1:2 (FLAGS)
S: * 1 FETCH (FLAGS () UID 1)
S: A3 OK UID FETCH Completed
S: * 2 FETCH (FLAGS () UID 2)
C: A4 LOGOUT
S: * BYE LOGOUT received
S: A4 OK Completed
[connection closed]
```

With `defer: 'next'` the held response goes out with the answer to the next command instead:

```javascript
{ on: 'response', command: 'FETCH', untagged: true, match: /^\* 2 FETCH/, defer: 'next' }
```

```text
C: A3 FETCH 1:2 (FLAGS)
S: * 1 FETCH (FLAGS ())
S: A3 OK FETCH Completed
C: A4 NOOP
S: * 2 FETCH (FLAGS ())
S: A4 OK Completed
C: A5 LOGOUT
S: * BYE LOGOUT received
S: A5 OK Completed
[connection closed]
```

### Literals everywhere

Valid IMAP that trips up clients which expect quoted strings. The LIST delimiter stays quoted, as the grammar requires.

```javascript
{ on: 'response', untagged: true, literals: true }
```

```text
S: * OK ImapKit ready for rumble
C: A1 LOGIN testuser testpass
S: A1 OK User logged in
C: A2 LIST "" "*"
S: * LIST (\HasNoChildren) "/" {5}
S: INBOX
S: A2 OK Completed
C: A3 SELECT INBOX
S: * FLAGS (\Answered \Flagged \Draft \Deleted \Seen)
S: * OK [PERMANENTFLAGS (\Answered \Flagged \Draft \Deleted \Seen \*)] Flags permitted
S: * 2 EXISTS
S: * 0 RECENT
S: * OK [UNSEEN 1] First unseen message
S: * OK [UIDVALIDITY 1] UIDs valid
S: * OK [UIDNEXT 3] Predicted next UID
S: A3 OK [READ-WRITE] Completed
C: A4 FETCH 1 (ENVELOPE)
S: * 1 FETCH (ENVELOPE (NIL {5}
S: hello ((NIL NIL {5}
S: alice {11}
S: example.com)) ((NIL NIL {5}
S: alice {11}
S: example.com)) ((NIL NIL {5}
S: alice {11}
S: example.com)) NIL NIL NIL NIL NIL))
S: A4 OK FETCH Completed
C: A5 LOGOUT
S: * BYE LOGOUT received
S: A5 OK Completed
[connection closed]
```

### Output split into pieces

A client that assumes one read holds one response, or a whole literal, breaks when the output arrives in small pieces. Here the FETCH response leaves in 16 octet pieces, 50 ms apart. The times are measured from the moment the command was sent:

```javascript
{ on: 'response', command: 'FETCH', untagged: true, chunk: 16, chunkDelay: 50 }
```

```text
   1 ms  "* 1 FETCH (BODY["
  51 ms  "HEADER.FIELDS (S"
 101 ms  "UBJECT)] {18}\r\nS"
 152 ms  "ubject: hello\r\n\r"
 202 ms  "\n)\r\n"
 202 ms  "A3 OK FETCH Completed\r\n"
```

The tagged OK waited behind the pieces, all later output keeps its order. With `chunkDelay: 'tick'` (or `0`) the pieces go out on separate event loop turns without a wall clock delay. On loopback the receiver may still merge a few of them into one read:

```text
   0 ms  "* 1 FETCH (BODY[HEADER.FIELDS (S"
   0 ms  "UBJECT)] {18}\r\nS"
   0 ms  "ubject: hello\r\n\r"
   0 ms  "\n)\r\n"
   0 ms  "A3 OK FETCH Completed\r\n"
```

### Autologout during IDLE

[RFC 3501](https://www.rfc-editor.org/rfc/rfc3501) section 5.4 allows an inactivity autologout of at least 30 minutes, and section 7.1.5 shows the `BYE` it announces. A client that idles must re-issue IDLE before that, and handle the BYE when it comes. A real test would use `quietFor: 1800000`, this run uses 2 seconds:

```javascript
{ on: 'quiet', command: 'IDLE', quietFor: 2000, send: '* BYE Autologout; idle for too long\r\n', close: true }
```

```text
C: A3 IDLE
S: + idling
S: * BYE Autologout; idle for too long
[connection closed]
```

The connection closed 2003 ms after IDLE was sent.

### An ALERT between commands

Unsolicited output while no command is in progress ([RFC 3501](https://www.rfc-editor.org/rfc/rfc3501) section 5.3):

```javascript
{ on: 'quiet', state: 'Selected', quietFor: 500, times: 1, send: '* OK [ALERT] System shutdown in 10 minutes\r\n' }
```

```text
C: A2 SELECT INBOX
S: * FLAGS (\Answered \Flagged \Draft \Deleted \Seen)
S: * OK [PERMANENTFLAGS (\Answered \Flagged \Draft \Deleted \Seen \*)] Flags permitted
S: * 2 EXISTS
S: * 0 RECENT
S: * OK [UNSEEN 1] First unseen message
S: * OK [UIDVALIDITY 1] UIDs valid
S: * OK [UIDNEXT 3] Predicted next UID
S: A2 OK [READ-WRITE] Completed
S: * OK [ALERT] System shutdown in 10 minutes
C: A3 NOOP
S: A3 OK Completed
```

When several quiet rules wait for different times, a rule that does not match lets the session wait on for the next longer `quietFor`.

### Random throttling

`chance` makes a rule fire on some matching events only. With `scriptSeed` the same client gets the same answers in every run. With seed 42 and a chance of 0.3, NOOPs 5 and 7 were refused:

```javascript
const server = imapkit({
    scriptSeed: 42,
    script: { on: 'command', command: 'NOOP', chance: 0.3, send: '$TAG NO [LIMIT] Too many commands, slow down\r\n' }
});
```

```text
C: A2 NOOP
S: A2 OK Completed
C: A3 NOOP
S: A3 OK Completed
C: A4 NOOP
S: A4 OK Completed
C: A5 NOOP
S: A5 OK Completed
C: A6 NOOP
S: A6 NO [LIMIT] Too many commands, slow down
C: A7 NOOP
S: A7 OK Completed
C: A8 NOOP
S: A8 NO [LIMIT] Too many commands, slow down
C: A9 NOOP
S: A9 OK Completed
```

The [`m365-throttle` quirk preset](./quirk-presets.md#m365-throttle) does the same for every command, with the text Microsoft 365 sends.

### A server that ignores DONE

The first `DONE` is dropped, the server keeps idling until the client sends another one. A client that waits forever for the tagged OK of IDLE hangs here, a careful one times out.

```javascript
{ on: 'input', command: 'IDLE', match: /^DONE$/, times: 1, drop: true }
```

```text
C: A3 IDLE
S: + idling
C: DONE
C: DONE
S: A3 OK IDLE terminated
```

### An unexpected EXISTS before a tagged response

`before` adds output in front of a response. Here every NOOP reports a third message that does not exist, a client must not fetch it blindly.

```javascript
{ on: 'response', command: 'NOOP', untagged: false, before: '* 3 EXISTS\r\n' }
```

```text
C: A3 NOOP
S: * 3 EXISTS
S: A3 OK Completed
```

### A connection reset

`close: 'reset'` destroys the socket, the client sees `ECONNRESET` instead of an orderly close:

```javascript
{ on: 'command', command: 'FETCH', close: 'reset' }
```

```text
C: A3 FETCH 1:* (FLAGS)
[connection closed with ECONNRESET]
```

Bun and Deno may close such a connection without a RST.
