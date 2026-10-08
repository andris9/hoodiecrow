---
title: Migrating from 4.x
sidebar_position: 4
description: The breaking changes of ImapKit 5.0.0 (XTOYBIRD removed, smtp-server optional), how XTOYBIRD commands map to the control API, the new features worth adopting, and the hoodiecrow-imap rename.
---

# Migrating from 4.x

ImapKit 5.0.0 has two breaking changes:

1. The XTOYBIRD plugin is removed. The IMAP port carries IMAP traffic only, test control moved to the [control API](../control-api/overview.md) and the [REST API](../rest-api/overview.md).
2. `smtp-server` is an optional peer dependency. Install it yourself if you use SMTP.

Everything else (the options, the plugins, the storage format, the IMAP behavior) carries over, with one thing to watch: the `storage` option is now [validated](#storage-fixtures-are-validated), so a fixture with a typo that 4.x silently accepted fails in 5.0.

## XTOYBIRD is removed

Loading `XTOYBIRD` now fails the server constructor:

```text
Error: XTOYBIRD was removed in 5.0.0, use the control API (server.control.snapshot(), server.control.addUser() ...) instead, see the README
```

Remove it from `plugins` (or `--plugin`, `IMAPKIT_PLUGINS`) and replace each command with its control API method:

| XTOYBIRD command                     | Control API                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| `XTOYBIRD STORAGE`                   | `server.control.snapshot()`                                                                  |
| `XTOYBIRD SERVER`                    | `server.control.listMailboxes()`, `server.control.listUsers()`                               |
| `XTOYBIRD CONNECTION`                | `server.control.sessions()`                                                                  |
| `XTOYBIRD USERADD "user" "password"` | `server.control.addUser('user', { password })`, or `updateUser()` for an existing user       |
| `XTOYBIRD USERDEL "user"`            | `server.control.deleteUser('user')`                                                          |
| `XTOYBIRD SHUTDOWN`                  | `await server.control.shutdown()`, stops accepting connections and waits for the last client |

`XTOYBIRD USERADD` added or updated a user. `addUser()` only adds, and throws an `ImapKitError` with the code `ALREADYEXISTS` for a user that exists, use `updateUser()` to change a password.

```text title="Before (4.x): commands on an extra IMAP connection, after LOGIN"
C: A1 XTOYBIRD USERADD "otheruser" "secret"
C: A2 XTOYBIRD STORAGE
```

```javascript title="After (5.0)"
server.control.addUser('otheruser', { password: 'secret' });
const storage = server.control.snapshot(); // the storage in the shape of the storage option
```

If your tests are not written in JavaScript and talked to XTOYBIRD over IMAP, use the [REST API](../rest-api/endpoints.md) instead. Start the server with `--rest-port`, and every control API method is an HTTP endpoint:

| XTOYBIRD command      | REST API                                 |
| --------------------- | ---------------------------------------- |
| `XTOYBIRD STORAGE`    | `GET /v1/snapshot`                       |
| `XTOYBIRD SERVER`     | `GET /v1/mailboxes`, `GET /v1/users`     |
| `XTOYBIRD CONNECTION` | `GET /v1/sessions`                       |
| `XTOYBIRD USERADD`    | `POST /v1/users`, `PUT /v1/users/{name}` |
| `XTOYBIRD USERDEL`    | `DELETE /v1/users/{name}`                |
| `XTOYBIRD SHUTDOWN`   | `POST /v1/shutdown`                      |

```bash
imapkit -p 1143 --rest-port=8143
curl http://127.0.0.1:8143/v1/snapshot
```

## smtp-server is an optional peer dependency

In 4.x `smtp-server` was installed with ImapKit. In 5.0 it is an optional peer dependency, so a project that does not use SMTP does not download it. If you use `--smtpPort` (also `--smtp-port`, `IMAPKIT_SMTPPORT`) or the new `smtp` option, install it next to ImapKit:

```bash
npm install --save-dev smtp-server
# or, for a global install of the command
npm install -g imapkit smtp-server
```

Without it, starting the SMTP server fails with an error that says so: `server.start()` rejects with `The smtp option needs the smtp-server package, install it with: npm install smtp-server (...)`, and the `imapkit` command prints `Failed to start ImapKit: ...` and exits.

The IMAP server itself never needs `smtp-server`.

## Storage fixtures are validated

5.0 checks the `storage` option when the server is built. A key that looks like a typo of a known one, or a value of the wrong type, now throws:

```text
Error: Invalid storage at "INBOX".messages[2]: unknown key "flag", did you mean "flags"?
```

In 4.x such a key was ignored, and the test ran against a mailbox without the data you meant to give it. If an upgraded test suite fails here, the fixture had a bug: fix the key. Keys that do not look like typos of known ones are still allowed, plugins keep their own data that way. See [Repeatable tests](../faults/repeatable-tests.md#storage-validation-catches-fixture-typos).

## New in 5.0, worth adopting

These are additions, nothing breaks if you ignore them, but most of them replace workarounds that 4.x tests needed.

### Promise based start and stop

`server.start(port, host)` resolves with the port, a free one when `port` is not given, and `server.stop()` closes the server and every session. `listen()` and `close()` still work.

```javascript
const server = imapkit({ plugins: ['IDLE'] });
const port = await server.start(); // no more hard-coded ports, test files can run in parallel
// ...
await server.stop();
```

With the `smtp` option (`imapkit({ smtp: { port, host } })`), `start()` also starts the SMTP server, and `server.smtpServer` is that server. With the `rest` option it starts the REST API.

### The control API

`server.control` changes the server from the test without an IMAP session, and every connected client sees the change the way it would see a change by another session (`EXISTS`, `EXPUNGE`, unsolicited `FETCH`, `BYE`):

```javascript
const { uid } = server.control.addMessage('INBOX', { raw: 'Subject: hello\r\n\r\nHi!\r\n', flags: ['\\Seen'] });
server.control.setFlags('INBOX', [uid], ['\\Flagged'], 'add');
server.control.expungeMessages('INBOX', [uid]);
```

Two items from the "ideas for future XTOYBIRD commands" list of the 4.x README exist now: `resetUidValidity()` changes the UIDVALIDITY of a mailbox at runtime, and `reset()` restores the server to its initial state. See [Control API](../control-api/overview.md), [UIDVALIDITY](../control-api/uidvalidity.md) and, for ACL, QUOTA, METADATA, SPECIAL-USE and OBJECTID data, [Plugin operations](../control-api/plugin-operations.md).

### Events instead of polling

The server emits `session` (open, login, select, unselect, logout, waiting, close), `command` (a tagged response went out), `mailbox`, `expunge` and `flags` events. A test can wait for "the client is idling" before it adds a message:

```javascript
const idling = new Promise(resolve => server.on('session', event => event.type === 'waiting' && event.command === 'IDLE' && resolve(event)));
await idling;
server.control.addMessage('INBOX', { raw: message }); // the idling client gets * n EXISTS right away
```

See [Events](../control-api/events.md). The REST API streams the same events as Server-Sent Events, see [Event stream](../rest-api/event-stream.md).

### More script rule features

Script rules arrived in 4.2 and 4.3. 5.0 adds:

- the `quiet` event, for unsolicited output between commands and an autologout during IDLE
- `chance` and the `scriptSeed` option, for faults on a random but repeatable share of the events
- `chunkDelay: 0` or `'tick'`, which splits output into separate TCP segments without a wall clock delay
- [quirk presets](../faults/quirk-presets.md) (`quirks` option, `--quirk`) for Apache James, Yahoo and Microsoft 365 behavior, and servers without MOVE or UIDPLUS
- script rules at runtime over REST (`/v1/script/rules`)

See [Scripted faults](../faults/scripted-faults.md).

### Repeatable runs

The `now` option fixes the clock for the dates the server sets itself (INTERNALDATE of a message without one, SAVEDATE), `scriptSeed` the random faults, and `resetUidValidity(path, { uids: 'shuffle', seed })` the order of shuffled UIDs. The package exports `validateStorage()` and the JSON Schema `storageSchema` for fixture tooling. See [Repeatable tests](../faults/repeatable-tests.md).

## Coming from hoodiecrow-imap

ImapKit was published as [`hoodiecrow-imap`](https://www.npmjs.com/package/hoodiecrow-imap) up to version 3.3.1, and renamed in 4.0.0. To migrate from Hoodiecrow:

- install `imapkit` instead of `hoodiecrow-imap`, and use `require('imapkit')` (or `import imapkit from 'imapkit'`)
- the command is `imapkit`, and its environment variables start with `IMAPKIT_` instead of `HOODIECROW_`
- the server greeting and the SMTP banner say ImapKit, so update tests that match the greeting text

The API, plugins and storage format did not change with the rename. Then follow the 5.0 steps above, as XTOYBIRD, which 4.x still had, is gone now.
