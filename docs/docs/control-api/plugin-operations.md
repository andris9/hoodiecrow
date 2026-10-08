---
title: Plugin Operations
sidebar_position: 6
description: Control API operations of the ACL, QUOTA, METADATA, SPECIAL-USE and OBJECTID plugins, and how a plugin of your own adds operations, REST routes and fields.
---

# Plugin operations

Plugins add control API methods for their own data. A method exists only while its plugin is loaded, so `server.control.setAcl` is `undefined` without the ACL plugin, and its REST routes answer 404. All of them follow the rules of the [overview](./overview.md): no session as the origin, ACL does not apply, and refused arguments throw an `ImapKitError`.

| Plugin                    | Methods and fields                                                      |
| ------------------------- | ----------------------------------------------------------------------- |
| ACL                       | `getAcl()`, `setAcl()`, `deleteAcl()`                                   |
| QUOTA                     | `getQuota()`, `setQuota()`                                              |
| METADATA, METADATA-SERVER | `getMetadata()`, `setMetadata()`                                        |
| SPECIAL-USE               | `setSpecialUse()`, `specialUse` in `MailboxInfo`                        |
| OBJECTID                  | `mailboxId` in `MailboxInfo`, `emailId` and `threadId` in `MessageInfo` |

## ACL

ACLs are objects of identifier to rights string, the same form as the `acl` property in the [storage option](../guides/storage.md). See [Access control](../extensions/access-control.md) for how the rights apply to sessions. Changes take effect for the next command of every session, and emit the [`acl` event](./events.md#acl).

### getAcl(path)

```typescript
getAcl(path: string): Record<string, string>
```

Returns the ACL of a mailbox, `{}` when it has none.

### setAcl(path, identifier, rights)

```typescript
setAcl(path: string, identifier: string, rights: string): Record<string, string>
```

Sets the rights of an identifier like SETACL ([RFC 4314 section 3.1](https://www.rfc-editor.org/rfc/rfc4314#section-3.1)): `rights` replaces the identifier's rights, `+rights` adds to them, `-rights` removes from them, and an identifier left without rights is removed. Returns the new ACL.

```javascript
const server = imapkit({ plugins: ['ACL'] });
server.control.createMailbox('Shared');
server.control.setAcl('Shared', 'alice', 'lrs'); // { alice: 'lrs' }
server.control.setAcl('Shared', 'alice', '+w'); // { alice: 'lrsw' }
server.control.setAcl('Shared', 'alice', '-s'); // { alice: 'lrw' }
server.control.setAcl('Shared', 'bob', 'lr'); // { alice: 'lrw', bob: 'lr' }
server.control.setAcl('Shared', 'bob', ''); // { alice: 'lrw' }
```

**Errors:** `NONEXISTENT` for a missing mailbox, `INVALID` for an empty identifier, rights that are not a string, or rights RFC 4314 does not define (`Uppercase rights are not allowed`).

### deleteAcl(path, identifier)

```typescript
deleteAcl(path: string, identifier: string): Record<string, string>
```

Removes an identifier from the ACL like DELETEACL. Returns the new ACL.

**Errors:** `NONEXISTENT` for a missing mailbox or an identifier that is not in the ACL.

A new mailbox, from CREATE or `createMailbox()`, gets the ACL of its parent. A deleted mailbox loses its ACL, also when it stays as a `\Noselect` level. The [snapshot](./mailboxes-and-messages.md#snapshot) keeps ACLs in the storage form.

## QUOTA

There is one quota root for the user's mailboxes, named `User quota` unless the `quota.root` option says otherwise. See [Metadata and quota](../extensions/metadata-and-quota.md).

### getQuota()

```typescript
getQuota(): { root: string; limits: { STORAGE?: number; MESSAGE?: number; MAILBOX?: number }; usage: { STORAGE: number; MESSAGE: number; MAILBOX: number } }
```

Returns the quota root, its limits and the current usage. STORAGE is in units of 1024 octets, rounded up, as in GETQUOTA. A resource without a limit is not in `limits`.

```javascript
const server = imapkit({ plugins: ['QUOTA'], quota: { STORAGE: 10 } });
server.control.getQuota();
// { root: 'User quota', limits: { STORAGE: 10 }, usage: { STORAGE: 0, MESSAGE: 0, MAILBOX: 1 } }
```

### setQuota(limits)

```typescript
setQuota(limits: { STORAGE?: number; MESSAGE?: number; MAILBOX?: number }): QuotaInfo
```

Replaces all limits, like SETQUOTA ([RFC 9208 section 4.1.3](https://www.rfc-editor.org/rfc/rfc9208#section-4.1.3)): a resource that is not given has no limit afterwards, `setQuota({})` removes every limit. Resource names are case-insensitive. Returns the same object as `getQuota()`. `control.reset()` restores the limits of the `quota` option.

The new limits apply to the next APPEND, COPY, MOVE or CREATE. The control API itself ignores them unless `addMessage()` is called with `checks: true`, so a test can fill a mailbox above its quota and then check how the client handles `NO [OVERQUOTA]`:

```javascript
server.control.addMessage('INBOX', { raw: 'x'.repeat(3000) });
server.control.setQuota({ STORAGE: 100, MESSAGE: 5 });
// { root: 'User quota', limits: { STORAGE: 100, MESSAGE: 5 }, usage: { STORAGE: 3, MESSAGE: 1, MAILBOX: 2 } }
```

**Errors:** `INVALID` for an argument that is not an object, an unknown resource (`Unknown quota resource FOO, expected STORAGE, MESSAGE, MAILBOX`) or a limit that is not a non-negative integer.

## METADATA

Annotations ([RFC 5464](https://www.rfc-editor.org/rfc/rfc5464)) are objects of entry name to value. Values are UTF-8 text. The mailbox `""` stands for the server annotations. With METADATA-SERVER only the server annotations exist, the methods answer `INVALID` for any mailbox. See [Metadata and quota](../extensions/metadata-and-quota.md).

### getMetadata(path)

```typescript
getMetadata(path: string): Record<string, string>
```

Returns the stored annotations of a mailbox, or of the server for `""`.

### setMetadata(path, values)

```typescript
setMetadata(path: string, values: Record<string, string | null>): Record<string, string>
```

Sets annotations: a string sets an entry, `null` removes it. Entry names must start with `/private/` or `/shared/` and follow the RFC 5464 rules, and the limits of the plugin apply. As the operator, the control API can also set entries that clients can not, like `/shared/admin` of the server. Returns all annotations of the mailbox or server afterwards.

**What sessions see:** sessions that have sent `ENABLE METADATA` get an unsolicited METADATA response that lists the changed entries, with their next command:

```javascript
server.control.setMetadata('INBOX', { '/private/comment': 'hello', '/shared/comment': 'shared' });
// a session after ENABLE METADATA receives: * METADATA INBOX /private/comment /shared/comment
server.control.setMetadata('', { '/shared/comment': 'srv' });
// * METADATA "" /shared/comment
```

`control.reset()` restores the server annotations of the options. Deleting a mailbox drops its annotations, renaming INBOX copies them to the new mailbox.

**Errors:** `NONEXISTENT` for a missing mailbox, `INVALID` for an argument that is not an object, an entry name the RFC does not allow (`Entry name must begin with /private or /shared`), a value that is neither a string nor null, or a mailbox with METADATA-SERVER. A value over the size limit, too many annotations, or a `/private` entry when private annotations are turned off also fail with `INVALID`. A computed entry, like `/private/specialuse` of SPECIAL-USE, fails with `CANNOT`.

## SPECIAL-USE

### setSpecialUse(path, uses)

```typescript
setSpecialUse(path: string, uses: string[]): MailboxInfo
```

Replaces the special-use attributes of a mailbox ([RFC 6154](https://www.rfc-editor.org/rfc/rfc6154)): `\All`, `\Archive`, `\Drafts`, `\Flagged`, `\Junk`, `\Sent`, `\Trash` or `\Important` ([RFC 8457](https://www.rfc-editor.org/rfc/rfc8457)). Duplicates are dropped, `[]` removes them all. Returns the mailbox's `MailboxInfo`, whose `specialUse` field lists them. LIST shows them from the next command:

```javascript
server.control.setSpecialUse('Shared', ['\\Archive', '\\Archive']).specialUse;
// [ '\\Archive' ]
// LIST "" "*" now answers: * LIST (\HasNoChildren \Archive) "/" "Shared"
```

With SPECIAL-USE loaded, every `MailboxInfo` has `specialUse`, an empty array for a mailbox without attributes.

**Errors:** `NONEXISTENT` for a missing or `\Noselect` mailbox, `INVALID` for a list with an unknown attribute or an argument that is not a list.

## OBJECTID

OBJECTID ([RFC 8474](https://www.rfc-editor.org/rfc/rfc8474)) adds read-only fields, so a test can compare the ids a client stores with the server's:

| Field       | In            | Description                                                          |
| ----------- | ------------- | -------------------------------------------------------------------- |
| `mailboxId` | `MailboxInfo` | MAILBOXID of the mailbox, e.g. `F2`. Not set for a `\Noselect` level |
| `emailId`   | `MessageInfo` | EMAILID of the message, e.g. `M1`. A copy keeps the EMAILID          |
| `threadId`  | `MessageInfo` | THREADID of the message, e.g. `T1`                                   |

```javascript
const server = imapkit({ plugins: ['OBJECTID'] });
server.control.addMessage('INBOX', { raw: 'x'.repeat(3000) });
server.control.listMessages('INBOX');
// [ { uid: 1, flags: [], internaldate: '...', size: 3000, emailId: 'M1', threadId: 'T1' } ]
```

## Operations of your own plugins

A [custom plugin](../reference/custom-plugins.md) can extend the control API the same way the built-in plugins do. It adds nothing while it is not loaded.

### control.register(name, fn, routes)

```typescript
register(name: string, fn: (...args: any[]) => unknown, routes?: ControlRoute[]): void
```

Adds `server.control[name]`, which calls `fn` with the same arguments, with no session as the origin of the changes it makes. Throws an `Error` if the name is taken. `fn` should throw `ImapKitError`s with a fitting `code`, so that both the control API and the REST API report errors the usual way.

`routes` are REST routes for the operation, served after the built-in ones and listed in `GET /v1/openapi.json`:

| Field     | Description                                                                                                                                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `method`  | `GET`, `POST`, `PUT` or `DELETE`                                                                                                                                                                                                                       |
| `path`    | URL path, `{name}` matches one URL encoded path segment, e.g. `/v1/mailboxes/{path}/note`                                                                                                                                                              |
| `summary` | one line for the OpenAPI document                                                                                                                                                                                                                      |
| `handler` | `({ params, query, body }) => result`: `params` are the decoded path parameters, `query` a `URLSearchParams`, `body` the parsed JSON body (`{}` without one). The result is sent as JSON with status 200, return `{ status, body }` for another status |

### Plugin data in mailbox and message info

| Array                         | Function                  | Use                                                                                                                      |
| ----------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `control.mailboxInfoHandlers` | `(mailbox, info) => void` | add fields to the `MailboxInfo` of `getMailbox()`, `listMailboxes()` and the operations that return one                  |
| `control.messageInfoHandlers` | `(message, info) => void` | add fields to the `MessageInfo` of `getMessage()` and `listMessages()`                                                   |
| `control.snapshotHandlers`    | `(mailbox, copy) => void` | put plugin data that is not JSON (a `Map`, a `Set`) into the snapshot of a mailbox, in the form the storage option takes |

Plugin properties on mailbox and message objects that are JSON data are copied into the snapshot without any help.

### Example

A plugin that keeps a note per mailbox:

```javascript
import imapkit, { ImapKitError } from 'imapkit';

function notesPlugin(server) {
    server.control.mailboxInfoHandlers.push((mailbox, info) => {
        info.note = mailbox.note || null;
    });
    server.control.register(
        'setNote',
        (path, note) => {
            const mailbox = server.control.requireMailbox(path);
            if (typeof note !== 'string') {
                throw new ImapKitError('Note must be a string', 'INVALID');
            }
            mailbox.note = note;
            return server.control.getMailbox(mailbox.path);
        },
        [
            {
                method: 'PUT',
                path: '/v1/mailboxes/{path}/note',
                summary: 'Sets the note of a mailbox',
                handler: ({ params, body }) => server.control.setNote(params.path, body.note)
            }
        ]
    );
}

const server = imapkit({ plugins: [notesPlugin], rest: { port: 0 } });
await server.start();
server.control.setNote('INBOX', 'hello').note; // 'hello'
```

`control.requireMailbox(path, selectable)` finds a mailbox by storage name and throws `NONEXISTENT` the way the built-in operations do, with `selectable: true` also for a `\Noselect` level. Over REST:

```bash
curl -X PUT http://127.0.0.1:8143/v1/mailboxes/INBOX/note \
     -H 'Content-Type: application/json' -d '{"note": "via REST"}'
# {"path":"INBOX","delimiter":"/",...,"note":"via REST"}
curl -X PUT http://127.0.0.1:8143/v1/mailboxes/INBOX/note \
     -H 'Content-Type: application/json' -d '{"note": 5}'
# HTTP 400 {"error":{"code":"INVALID","message":"Note must be a string"}}
```

Since `mailbox.note` is a string, `control.snapshot()` includes it as `"note"`.
