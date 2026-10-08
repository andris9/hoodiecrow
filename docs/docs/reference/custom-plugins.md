---
title: Custom Plugins
sidebar_position: 3
description: Write your own ImapKit plugins, with new capabilities, commands, FETCH items, SEARCH keys, output handlers and control API operations.
---

# Custom Plugins

Every IMAP extension in ImapKit is a plugin, and your own code uses the same API. A plugin is a function that gets the server when it is built:

```javascript
import imapkit from 'imapkit';

function myPlugin(server) {
    server.registerCapability('XHELLO');
}

const server = imapkit({
    // built-in plugins by name, your own as functions
    plugins: ['IDLE', myPlugin]
});
```

Plugins run once, in the constructor, before the storage is loaded. They can not be loaded or unloaded on a running server. A function listed twice is loaded once.

A plugin should stay self-contained: when it is not loaded, no trace of it remains. Keep its state on the server, the connection, mailboxes or messages, under names that do not collide with other plugins.

## Requiring other plugins

A plugin that needs another one lists the names in `requires`. They are loaded first, whatever the order of the `plugins` option:

```javascript
function myPlugin(server) {
    // ENABLE is loaded already
}
myPlugin.requires = ['ENABLE'];
```

The TypeScript type is `Plugin` from the package: `(server: IMAPServer) => void` with an optional `requires: string[]`.

## Capabilities

```javascript
server.registerCapability(name, availability);
```

`name` is the string listed in the CAPABILITY response. The optional `availability(connection)` function decides per session whether it is listed:

```javascript
// listed only before login
server.registerCapability('XAUTH', connection => connection.state === 'Not Authenticated');
```

## Commands

```javascript
server.setCommandHandler(name, handler, options);
```

`name` is the command name, `"UID XFOO"` for a UID variant. `handler(connection, parsed, data, callback)` runs the command:

| Argument     | What it is                                                                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connection` | the `IMAPConnection` of the session                                                                                                                                                    |
| `parsed`     | the command parsed by [imap-handler](https://github.com/postalsys/imap-handler): `{ tag, command, attributes }`, where `attributes` holds `{ type, value }` nodes and arrays for lists |
| `data`       | the command as a binary string                                                                                                                                                         |
| `callback`   | call it, without arguments, when the command is done                                                                                                                                   |

### The handler contract

A handler **must send a tagged response and then call `callback()`**. The connection processes commands strictly one at a time, so a handler that never calls back stalls the session.

```javascript
// an untagged response
connection.send({ tag: '*', command: 'XFOO', attributes: [42] }, 'XFOO', parsed, data);
// the tagged response: OK, NO or BAD, an optional response code, and the human readable text
connection.sendStatus(parsed, data, 'OK', 'XFOO completed');
connection.sendStatus(parsed, data, 'NO', 'No such mailbox', 'NONEXISTENT');
callback();
```

`connection.send(response, description, parsed, data, ...extra)` takes an imap-handler response object. `description` is a string that output handlers of other plugins use to recognise the response, `extra` arguments are passed on to them. `connection.sendStatus(parsed, data, command, text, code, description)` builds a status response for you, `code` is an atom (`'TRYCREATE'`) or a list for a code with arguments (`['METADATA', 'MAXSIZE', 1024]`).

The text of every OK, NO, BAD and BYE response must be non-empty, as RFC 3501 section 9 requires.

A handler that throws synchronously gets a tagged `NO [SERVERBUG] Server error: ...` sent for it, and the session stays usable. An error with `imapResponse = 'BAD'` is sent as `BAD` with its message instead.

A mailbox name in a response is sent as `{ type: 'MAILBOX', value: storageName }`, which `send` converts to the form the receiving session uses (modified UTF-7, or UTF-8 after `ENABLE UTF8=ACCEPT`).

### Command options

The server checks the options before the handler runs, so the handler only sees valid input:

| Option             | Type                  | What it does                                                                                                                                                                                                          |
| ------------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `states`           | `string[]`            | The connection states the command is valid in: `'Not Authenticated'`, `'Authenticated'`, `'Selected'`. Any state if not set. A command in another state gets `BAD`. A plain array as `options` is read as the states. |
| `noArguments`      | `boolean`             | The command is refused when it has arguments.                                                                                                                                                                         |
| `mailboxArguments` | `number[]`            | Positions of mailbox name arguments. They must be valid modified UTF-7 ([RFC 3501](https://www.rfc-editor.org/rfc/rfc3501) section 5.1.3) and reach the handler as storage names, also after `ENABLE UTF8=ACCEPT`.    |
| `astringArguments` | `number[]`            | Positions of other astring arguments (user names, identifiers). In these, in mailbox names and in search criteria an atom `NIL` reaches the handler as an atom, not as `null`.                                        |
| `searchCriteria`   | `number`              | Position where SEARCH style criteria start.                                                                                                                                                                           |
| `sequenceSet`      | `number`              | Position of an argument with message sequence numbers. With `searchCriteria`, used for the RFC 3501 section 5.5 pipelining check, and by UIDONLY.                                                                     |
| `noExpunge`        | `boolean`             | EXPUNGE responses are held back while the command runs, as for FETCH, STORE and SEARCH (RFC 3501 section 7.4.1). The notifications queued before them are still sent.                                                 |
| `literal8`         | `boolean` or `string` | The command accepts `~{n}` literals ([RFC 3516](https://www.rfc-editor.org/rfc/rfc3516)). A string names the capability that allows them.                                                                             |
| `noPipelining`     | `boolean`             | The command is refused with `BAD` when the client sent more input after it, and so are the commands sent with it (STARTTLS and COMPRESS work this way).                                                               |
| `appendMessage`    | `boolean`             | The command takes a message after its mailbox argument, like APPEND. A message literal to a missing mailbox is refused with `NO [TRYCREATE]` before it is sent.                                                       |

Without options, a command that already exists keeps its settings, so wrapping a built-in command does not change how it is checked.

`server.getCommandOptions(name)` returns the options of a command with every key set, `server.getCommandStates(name)` only its states, or `false` if any state is fine.

### Wrapping an existing command

`server.getCommandHandler(name)` returns the current handler of a command, or `false`. Keep it and call it from your own handler:

```javascript
const list = server.getCommandHandler('LIST');
server.setCommandHandler('LIST', (connection, parsed, data, callback) => {
    console.log('LIST from session %s', connection.sessionNumber);
    list(connection, parsed, data, callback);
});
```

### Run after every plugin is loaded

A plugin that wraps commands or handlers of other plugins does it once every plugin is loaded, so the load order does not matter. The server emits `pluginsLoaded` at the end of the constructor, listeners run in plugin load order:

```javascript
function readOnlyArchive(server) {
    server.once('pluginsLoaded', () => {
        const move = server.getCommandHandler('MOVE');
        if (!move) {
            return; // MOVE is not loaded
        }
        server.setCommandHandler('MOVE', (connection, parsed, data, callback) => {
            // mailbox arguments are storage names here
            if (parsed.attributes[1].value === 'Archive') {
                connection.sendStatus(parsed, data, 'NO', 'Archive is read-only', 'CANNOT');
                return callback();
            }
            move(connection, parsed, data, callback);
        });
    });
}

imapkit({ plugins: [readOnlyArchive, 'MOVE'] });
```

### Reading raw input

A command that reads the lines that follow it (IDLE waiting for `DONE`, AUTHENTICATE reading SASL responses) sets `connection.inputHandler`. The function gets complete lines without the line break. Clear it to give input back to the command parser:

```javascript
connection.write('+ idling\r\n');
connection.inputHandler = line => {
    connection.inputHandler = false;
    connection.sendStatus(parsed, data, line.toUpperCase() === 'DONE' ? 'OK' : 'BAD', 'Done');
    callback();
};
```

Raw output, like a `+` continuation request, goes through `connection.write(data)`, and `connection.end()` closes the connection once all output is written. Never write to `connection.socket` directly: a COMPRESS layer (`connection.transport`) may sit between the protocol and the socket. See [idle.ts](https://github.com/postalsys/imapkit/blob/master/src/plugins/idle.ts) for a complete example.

## Session state

UNAUTHENTICATE ([RFC 8437](https://www.rfc-editor.org/rfc/rfc8437)) returns a session to the Not Authenticated state. A plugin that keeps per-session state on the connection clears it in a reset handler:

```javascript
server.resetHandlers.push(connection => {
    connection.mySessionState = false;
});
```

`server.connectionHandlers` run on every new connection, `(connection)`, which is the place to set up per-session state or replace a per-connection method.

## Changing output

Every response `connection.send()` writes passes through `server.outputHandlers`, with the arguments of `send`: `(connection, response, description, parsed, data, ...extra)`. A handler can change the response object, or set `response.skipResponse = true` to drop it:

```javascript
server.outputHandlers.push((connection, response, description) => {
    if (response.tag === '*' && description === 'XNOTE') {
        response.skipResponse = true;
    }
});
```

Output handlers are for extensions that change valid responses. They run before the server finishes the response (response codes, mailbox names, the status text) and before the compiler, which refuses output that is not valid IMAP. To make the server send something wrong on purpose, use [script rules](../faults/scripted-faults.md), which see the final bytes.

An output handler that must see the responses after every other plugin changed them pushes itself in a `pluginsLoaded` listener.

## Message items, search keys and STATUS items

| Hook                          | Signature                                                        | What it does                                                                                                                                                                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `server.fetchHandlers[ITEM]`  | `(connection, message, query)` returns the value                 | A FETCH item. Consulted before the built-in items. A number is sent as a number, a string as a quoted string, an imap-handler node (`{ type: 'LITERAL', value }`) or an array as that node or list. Set `handler.setsSeen = true` for an item that sets `\Seen` like `BODY[]`. |
| `server.searchHandlers[KEY]`  | `(connection, message, index, ...args)` returns true for a match | A SEARCH key. Each parameter after `index` takes one string argument. An `argumentTypes(list)` method on the handler can decide the arguments itself.                                                                                                                          |
| `server.storeHandlers[ITEM]`  | `(connection, message, values, index, parsed, data)`             | A STORE item, keyed by the full item name (`+X-FOO`, `X-FOO.SILENT`).                                                                                                                                                                                                          |
| `server.statusHandlers[ITEM]` | `(connection, mailbox, status)` returns the value                | A STATUS item. Add the name to `server.allowedStatus` too, or STATUS refuses it.                                                                                                                                                                                               |
| `server.fetchFilters`         | `(connection, message, parsed, index)`                           | Returning false leaves a message out of a FETCH.                                                                                                                                                                                                                               |

A fetch handler that throws an error with `imapResponse = 'NO'` and a `code` fails the whole FETCH with `NO [code]`. FETCH sends nothing until every message is done, so a failed FETCH has no untagged output and no `\Seen` changes.

## Messages and mailboxes

| Hook                     | Signature                                  | What it does                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.messageHandlers` | `(server, message, mailbox)`               | Runs on every message when it is loaded from storage or added.                                                                                                                                                                                                                                                                                                                                 |
| `server.mailboxHandlers` | `(server, mailbox)`                        | Runs on every mailbox when it is loaded from storage or created.                                                                                                                                                                                                                                                                                                                               |
| `server.appendChecks`    | `(connection, mailbox, messages, options)` | Consulted before APPEND, REPLACE, COPY and MOVE add messages. Return nothing to allow, `{ code, text }` to fail the command with `NO [code] text`, or `{ code, text, soft: true }` for an untagged `NO` warning only. `options` is `{ move, source }` for COPY and MOVE, `{ command, replaced }` for APPEND and REPLACE. `connection` is null for `control.addMessage(..., { checks: true })`. |
| `server.copyHandlers`    | `(server, source, properties, mailbox)`    | Runs when COPY, MOVE or RENAME INBOX copies a message. Properties set on `properties` are given to the copy before the message handlers run.                                                                                                                                                                                                                                                   |
| `server.closedChecks`    | `(connection)`                             | When any returns true, SELECT and EXAMINE send `* OK [CLOSED]` when they close the selected mailbox.                                                                                                                                                                                                                                                                                           |
| `server.commandChecks`   | `(connection, parsed)`                     | Runs before any command handler. Return `{ command, code, text }` to refuse the command whatever plugin handles it (`command` defaults to `BAD`).                                                                                                                                                                                                                                              |

The server also emits `expunge` `(mailbox, messages, origin)` before sessions are told about removed messages, and `mailbox` `{ type, path, oldPath, mailbox, origin }` for CREATE, DELETE, RENAME, SUBSCRIBE and UNSUBSCRIBE. See [Server API events](./server-api.md#events).

The architecture notes in [CLAUDE.md](https://github.com/postalsys/imapkit/blob/master/CLAUDE.md) list the remaining, more specialised hooks (`rangeLimits`, `searchLimits`, `literalFilters`, `appendDataHandlers`, `notifyFilters`, the ESEARCH result option registry and the extended LIST registry) that the built-in plugins use.

## Control API operations

`server.control.register(name, fn, routes)` adds an operation to the [control API](../control-api/overview.md), so it only exists when the plugin is loaded. `server.control[name](...args)` then calls `fn`, with no session as the origin of the changes it makes. Throw an `ImapKitError` (exported by the package) with a `code` for errors, the REST API maps the codes to HTTP statuses. Registering a name that exists throws.

`routes` is an optional list of REST routes for the [REST API](../rest-api/overview.md):

| Field     | What it is                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------- |
| `method`  | `'GET'`, `'POST'`, `'PUT'` or `'DELETE'`                                                                      |
| `path`    | the URL path, `{name}` matches one URL encoded segment                                                        |
| `summary` | one line for the OpenAPI document at `GET /v1/openapi.json`                                                   |
| `handler` | `({ params, query, body })` returns the JSON response body, or `{ status, body }` for a status other than 200 |

## The connection object

The `IMAPConnection` members plugins use most:

| Member                                               | What it is                                                                                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `server`                                             | the `IMAPServer`                                                                                                                       |
| `state`                                              | `'Not Authenticated'`, `'Authenticated'`, `'Selected'` or `'Logout'`                                                                   |
| `username`                                           | the logged in user                                                                                                                     |
| `selectedMailbox`, `readOnly`                        | the selected mailbox object, and whether it was opened read-only                                                                       |
| `sessionNumber`                                      | 1 for the first connection the server accepted                                                                                         |
| `send()`, `sendStatus()`, `write()`, `end()`         | output, see [the handler contract](#the-handler-contract)                                                                              |
| `inputHandler`                                       | see [reading raw input](#reading-raw-input)                                                                                            |
| `getSessionMessages()`                               | the messages of the selected mailbox as this session sees them, including messages another session expunged that were not reported yet |
| `getMessageRange(range, isUid)`                      | resolves a sequence set argument to `[sequenceNumber, message]` pairs                                                                  |
| `getFlags(message)`                                  | the flags of a message as this session sees them                                                                                       |
| `canSetSeen()`, `canExpunge()`                       | whether FETCH may set `\Seen` and CLOSE may expunge, `!readOnly` by default. A plugin can override them per connection (ACL does)      |
| `importMailboxName(name)`, `exportMailboxName(path)` | convert between the session's mailbox name form and the storage name                                                                   |
| `describe()`                                         | the session as plain data, as `control.sessions()` lists it                                                                            |

## A complete example

The XNOTE plugin attaches a text note to a mailbox. It adds a capability, a command with options, a FETCH item, a SEARCH key, a reset handler and control API operations with a REST route:

```javascript title="xnote.js"
import { ImapKitError } from 'imapkit';

/**
 * XNOTE: attaches a free text note to a mailbox.
 *
 *   C: A1 XNOTE INBOX "call back"
 *   S: * XNOTE INBOX "call back"
 *   S: A1 OK XNOTE completed
 *
 * Also adds an X-SIZE-KB FETCH item, an X-MINKB SEARCH key and the control operations getNote/setNote.
 */
export default function xnotePlugin(server) {
    server.registerCapability('XNOTE');

    // notes live on the mailbox objects, so control.reset() drops them with the storage
    const getNote = path => {
        const mailbox = server.getMailbox(path);
        if (!mailbox) {
            throw new ImapKitError('No such mailbox ' + path, 'NONEXISTENT');
        }
        return mailbox.xnote || null;
    };

    server.setCommandHandler(
        'XNOTE',
        (connection, parsed, data, callback) => {
            const [nameArg, textArg] = parsed.attributes || [];
            const mailbox = nameArg && server.getMailbox(nameArg.value);
            if (!mailbox) {
                connection.sendStatus(parsed, data, 'NO', 'No such mailbox', 'NONEXISTENT');
                return callback();
            }
            if (textArg && textArg.value !== undefined) {
                mailbox.xnote = String(textArg.value);
                connection.notesSet = (connection.notesSet || 0) + 1;
            }
            connection.send(
                {
                    tag: '*',
                    command: 'XNOTE',
                    attributes: [{ type: 'MAILBOX', value: mailbox.path }, mailbox.xnote ? { type: 'STRING', value: mailbox.xnote } : null]
                },
                'XNOTE',
                parsed,
                data
            );
            connection.sendStatus(parsed, data, 'OK', 'XNOTE completed');
            callback();
        },
        { states: ['Authenticated', 'Selected'], mailboxArguments: [0] }
    );

    // per-session state is cleared when UNAUTHENTICATE resets the session
    server.resetHandlers.push(connection => {
        connection.notesSet = 0;
    });

    // FETCH n (X-SIZE-KB)
    server.fetchHandlers['X-SIZE-KB'] = (connection, message) => Math.ceil(message.raw.length / 1024);

    // SEARCH X-MINKB n: messages of at least n KB. The parameter after `index` makes it take one string argument
    server.searchHandlers['X-MINKB'] = (connection, message, index, kb) => Math.ceil(message.raw.length / 1024) >= Number(kb);

    // server.control.getNote(path) and server.control.setNote(path, text), plus REST routes
    server.control.register('getNote', path => ({ path, note: getNote(path) }), [
        {
            method: 'GET',
            path: '/v1/notes/{path}',
            summary: 'The note of a mailbox (XNOTE plugin)',
            handler: ({ params }) => server.control.getNote(params.path)
        }
    ]);
    server.control.register('setNote', (path, note) => {
        getNote(path);
        server.getMailbox(path).xnote = typeof note === 'string' && note ? note : undefined;
        return { path, note: getNote(path) };
    });
}
```

A session with the plugin loaded:

```text
* OK ImapKit ready for rumble
A0 XNOTE INBOX
A0 BAD XNOTE is not allowed in the Not Authenticated state
A1 LOGIN testuser testpass
A1 OK User logged in
A2 XNOTE INBOX "call back"
* XNOTE INBOX "call back"
A2 OK XNOTE completed
A3 XNOTE Nonexistent "x"
A3 NO [NONEXISTENT] No such mailbox
A4 SELECT INBOX
...
A5 FETCH 1 (X-SIZE-KB)
* 1 FETCH (X-SIZE-KB 1)
A5 OK FETCH Completed
```

### Test the plugin

`imapkit/lib/mock-client` replays commands like a compliant client and returns the transcript, which is all a plugin test needs. Run it with `node --test`:

```javascript title="xnote.test.js"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import imapkit from 'imapkit';
import mockClient from 'imapkit/lib/mock-client';
import xnotePlugin from './xnote.js';

// replays commands like a well behaved client and resolves with the transcript
const run = (port, commands) => new Promise(resolve => mockClient(port, '127.0.0.1', commands, false, resp => resolve(resp.toString('binary'))));

test('XNOTE stores a note on a mailbox', async () => {
    const server = imapkit({
        plugins: ['IDLE', xnotePlugin],
        storage: { INBOX: { messages: [{ raw: 'Subject: hi\r\n\r\nHello\r\n' }] }, '': {} }
    });
    const port = await server.start();
    try {
        const transcript = await run(port, [
            'A1 CAPABILITY',
            'A2 LOGIN testuser testpass',
            'A3 XNOTE INBOX "call back"',
            'A4 XNOTE Nonexistent "x"',
            'A5 SELECT INBOX',
            'A6 FETCH 1 (X-SIZE-KB)',
            'A7 SEARCH X-MINKB 1',
            'A8 SEARCH X-MINKB 2',
            'A9 LOGOUT'
        ]);
        assert.match(transcript, /^\* CAPABILITY .*\bXNOTE\b/m);
        assert.match(transcript, /^\* XNOTE INBOX "call back"\r$/m);
        assert.match(transcript, /^A3 OK XNOTE completed/m);
        assert.match(transcript, /^A4 NO \[NONEXISTENT\]/m);
        assert.match(transcript, /^\* 1 FETCH \(X-SIZE-KB 1\)/m);
        assert.match(transcript, /^\* SEARCH 1\r\nA7 OK/m);
        assert.match(transcript, /^\* SEARCH\r\nA8 OK/m);

        // the control operation sees the same state
        assert.deepEqual(server.control.getNote('INBOX'), { path: 'INBOX', note: 'call back' });
        assert.throws(() => server.control.getNote('Nope'), { name: 'ImapKitError', code: 'NONEXISTENT' });
    } finally {
        await server.stop();
    }
});

test('XNOTE is refused before login', async () => {
    const server = imapkit({ plugins: [xnotePlugin] });
    const port = await server.start();
    try {
        const transcript = await run(port, ['A1 XNOTE INBOX "x"', 'A2 LOGOUT']);
        assert.match(transcript, /^A1 BAD /m);
    } finally {
        await server.stop();
    }
});

test('the REST route serves the note', async () => {
    const server = imapkit({ plugins: [xnotePlugin], rest: { port: 0 } });
    await server.start();
    try {
        server.control.setNote('INBOX', 'from the control API');
        const { port } = server.restServer.address();
        const res = await fetch(`http://127.0.0.1:${port}/v1/notes/INBOX`);
        assert.deepEqual(await res.json(), { path: 'INBOX', note: 'from the control API' });
    } finally {
        await server.stop();
    }
});
```

```bash
node --test xnote.test.js
```

The built-in plugins in [src/plugins/](https://github.com/postalsys/imapkit/tree/master/src/plugins) are the best reference for anything beyond this page: [idle.ts](https://github.com/postalsys/imapkit/blob/master/src/plugins/idle.ts) for raw input, [quota.ts](https://github.com/postalsys/imapkit/blob/master/src/plugins/quota.ts) for append checks, STATUS items and control operations, [acl.ts](https://github.com/postalsys/imapkit/blob/master/src/plugins/acl.ts) for wrapping other plugins' commands on `pluginsLoaded`.
