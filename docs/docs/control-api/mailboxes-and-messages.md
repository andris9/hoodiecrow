---
title: Mailboxes and Messages
sidebar_position: 2
description: Reference for the control API methods that inspect and change mailboxes and messages, with what connected IMAP sessions see for each change.
---

# Mailboxes and messages

These methods of `server.control` read and change the message store. Mailboxes are [storage names](./overview.md#mailbox-names-are-storage-names), messages are UIDs. Errors are [`ImapKitError`s](./overview.md#imapkiterror) with a `code`. The examples on this page are real outputs from a server created with `imapkit()` and the plugins named in each example.

## Inspection

### snapshot()

```typescript
snapshot(): Record<string, StorageNamespace>
```

Returns the whole store as JSON data in the shape of the [`storage` option](../guides/storage.md): namespaces, mailboxes, messages with their UIDs, flags and internal dates, UIDNEXT and UIDVALIDITY values, and subscriptions. A new server created from it starts from the same state:

```javascript
const copy = imapkit({ storage: server.control.snapshot(), plugins: ['CONDSTORE'] });
```

Message sources are binary strings, as in the storage option. Plugin data on mailboxes and messages is included as far as it is JSON data, for example `MODSEQ` and `HIGHESTMODSEQ` of CONDSTORE, `acl` of ACL, `metadata` of METADATA and `special-use` of SPECIAL-USE. Subscriptions of names that are not mailboxes (a subscription outlives DELETE) are not part of it.

Use it to write a failing test's state to a file, or to compare the whole store with an expected one after the client ran.

### listMailboxes()

```typescript
listMailboxes(): MailboxInfo[]
```

Describes every mailbox, ordered by name, including `\Noselect` hierarchy levels.

### getMailbox(path)

```typescript
getMailbox(path: string): MailboxInfo
```

Describes one mailbox, also a `\Noselect` level. Throws `NONEXISTENT` for a name that is not a mailbox.

A `MailboxInfo` has these fields:

| Field            | Type       | Description                                                                                                                                                                          |
| ---------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `path`           | `string`   | storage name                                                                                                                                                                         |
| `delimiter`      | `string`   | hierarchy delimiter of the namespace                                                                                                                                                 |
| `flags`          | `string[]` | mailbox attributes as LIST shows them, e.g. `\Noselect`, `\HasChildren`, `\HasNoChildren`                                                                                            |
| `selectable`     | `boolean`  | false for a `\Noselect` level that only holds child mailboxes                                                                                                                        |
| `subscribed`     | `boolean`  | whether the name is subscribed                                                                                                                                                       |
| `messages`       | `number`   | number of messages                                                                                                                                                                   |
| `unseen`         | `number`   | number of messages without `\Seen`                                                                                                                                                   |
| `uidnext`        | `number`   | the next UID                                                                                                                                                                         |
| `uidvalidity`    | `number`   | the UIDVALIDITY                                                                                                                                                                      |
| `permanentFlags` | `string[]` | the flags the mailbox defines, the list SELECT sends in `* FLAGS` (system flags and keywords that are in use). It has no `\*`, even when SELECT's PERMANENTFLAGS allows new keywords |
| `highestModseq`  | `number`   | only with CONDSTORE (or QRESYNC) loaded                                                                                                                                              |
| `specialUse`     | `string[]` | only with SPECIAL-USE loaded, see [Plugin operations](./plugin-operations.md#special-use)                                                                                            |
| `mailboxId`      | `string`   | only with OBJECTID loaded, not for `\Noselect` levels                                                                                                                                |

```javascript
server.control.getMailbox('INBOX');
```

```javascript
{
  path: 'INBOX',
  delimiter: '/',
  flags: [ '\\HasNoChildren' ],
  selectable: true,
  subscribed: true,
  messages: 1,
  unseen: 0,
  uidnext: 2,
  uidvalidity: 1,
  permanentFlags: [ '\\Answered', '\\Flagged', '\\Draft', '\\Deleted', '\\Seen' ],
  highestModseq: 3
}
```

### listMessages(path, options)

```typescript
listMessages(path: string, options?: { uids?: number[]; raw?: boolean }): MessageInfo[]
```

| Parameter      | Description                                                     |
| -------------- | --------------------------------------------------------------- |
| `path`         | storage name of a selectable mailbox                            |
| `options.uids` | only these UIDs. Every UID must exist (`NONEXISTENT` otherwise) |
| `options.raw`  | true includes the message source in `raw`. Default `false`      |

Returns the messages ordered by UID. Throws `NONEXISTENT` for a mailbox that does not exist or is `\Noselect`.

### getMessage(path, uid, options)

```typescript
getMessage(path: string, uid: number, options?: { raw?: boolean }): MessageInfo
```

Describes one message. Unlike `listMessages()`, the source is included unless `raw` is `false`.

A `MessageInfo` has these fields:

| Field          | Type       | Description                                           |
| -------------- | ---------- | ----------------------------------------------------- |
| `uid`          | `number`   | UID                                                   |
| `flags`        | `string[]` | flags, without `\Recent` (which belongs to a session) |
| `internaldate` | `string`   | internal date as an RFC 3501 date-time string         |
| `size`         | `number`   | size of the source in octets (RFC822.SIZE)            |
| `modseq`       | `number`   | only with CONDSTORE (or QRESYNC) loaded               |
| `emailId`      | `string`   | only with OBJECTID loaded                             |
| `threadId`     | `string`   | only with OBJECTID loaded                             |
| `raw`          | `Buffer`   | the source, only when asked for                       |

```javascript
server.control.getMessage('INBOX', 1);
```

```javascript
{
  uid: 1,
  flags: [ '\\Seen', '\\Flagged' ],
  internaldate: '08-Oct-2026 18:20:56 +0300',
  size: 23,
  modseq: 3,
  raw: <Buffer 53 75 62 6a 65 63 74 3a 20 68 65 6c 6c 6f 0d 0a 0d 0a 48 69 21 0d 0a>
}
```

## Messages

### addMessage(path, message, options)

```typescript
addMessage(
    path: string,
    message: { raw: string | Uint8Array; flags?: string[]; internaldate?: Date | string },
    options?: { checks?: boolean }
): { uid: number; uidvalidity: number }
```

Adds a message like a delivery from outside.

| Parameter              | Description                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `path`                 | storage name of a selectable mailbox                                                                                              |
| `message.raw`          | the message source. A string is encoded as UTF-8, a `Buffer` or `Uint8Array` is stored as it is (use it for 8-bit or binary data) |
| `message.flags`        | flags of the new message, default none                                                                                            |
| `message.internaldate` | a `Date` or an RFC 3501 date-time string such as `"17-Jul-1996 02:44:25 -0700"`, default the current time                         |
| `options.checks`       | true runs the checks APPEND runs and refuses the message like APPEND would. Default `false`                                       |

Returns the new UID and the UIDVALIDITY of the mailbox. A `Date` is stored in the local time zone of the process, a string is kept as it is.

**What sessions see:** sessions that have the mailbox selected get `* n EXISTS`. The first read-write session that has it selected sees the message as `\Recent`, like a delivery.

```javascript
const server = imapkit({ plugins: ['IDLE'] });
// ... the client logs in, selects INBOX and starts IDLE
server.control.addMessage('INBOX', { raw: 'Subject: three\r\n\r\nz\r\n' });
// the idling client receives: * 2 EXISTS
```

**The `checks` option.** Without it, the message is added whatever the limits are, which is how you fill a mailbox above its quota. With `checks: true` the checks of the loaded plugins run first: QUOTA refuses a message over a hard limit with `OVERQUOTA`, APPENDLIMIT one over the limit with `TOOBIG`. A soft quota does not refuse anything.

```javascript
const server = imapkit({ plugins: ['QUOTA'], quota: { STORAGE: 1 } });
server.control.addMessage('INBOX', { raw: 'x'.repeat(5000) }, { checks: true });
// ImapKitError OVERQUOTA: Quota exceeded
server.control.addMessage('INBOX', { raw: 'x'.repeat(5000) });
// { uid: 1, uidvalidity: 1 }
```

**Errors:** `NONEXISTENT` for a missing or `\Noselect` mailbox, `INVALID` for an empty or missing source, a flag STORE would refuse (such as `\Recent` or an unknown system flag) or an internal date in another format, and the code of a failed check.

### setFlags(path, uids, flags, mode)

```typescript
setFlags(path: string, uids: number[], flags: string[], mode?: 'set' | 'add' | 'remove'): { uid: number; flags: string[] }[]
```

Changes the flags of messages, like `STORE FLAGS`, `+FLAGS` and `-FLAGS`.

| `mode`          | Effect                                                       |
| --------------- | ------------------------------------------------------------ |
| `set` (default) | replaces the flags of every message with `flags`             |
| `add`           | adds `flags`                                                 |
| `remove`        | removes `flags`. Flags that are not permanent may be removed |

Returns `{ uid, flags }` of every listed message, in the order of `uids`.

**What sessions see:** sessions that have the mailbox selected get an unsolicited FETCH with the UID and the new flags, for messages whose flags actually changed. After `ENABLE CONDSTORE` the response also has the new `MODSEQ`, as every changed message gets a new mod-sequence. The session's own `\Recent` is part of the FLAGS list it sees:

```
* 1 FETCH (UID 1 FLAGS (\Seen \Flagged \Recent) MODSEQ (3))
```

**Errors:** `NONEXISTENT` for a missing mailbox or UID, `INVALID` for a UID list that is not positive integers, an unknown `mode` (`Invalid flag mode "toggle", expected set, add or remove`), or a flag STORE would refuse.

### expungeMessages(path, uids)

```typescript
expungeMessages(path: string, uids: number[]): number[]
```

Removes messages, whatever their flags are. Returns the removed UIDs.

**What sessions see:** `* n EXPUNGE` for every message and then `* n EXISTS` with the new count. After `ENABLE QRESYNC` a session gets `* VANISHED` with the UIDs instead of the EXPUNGE responses. The [RFC 2180](https://www.rfc-editor.org/rfc/rfc2180) rules apply as for an EXPUNGE in another session, see [Multiple sessions](../guides/multiple-sessions.md).

```
* 1 EXPUNGE
* 0 EXISTS
```

With QRESYNC enabled, an idling session receives:

```
* VANISHED 1
* 1 EXISTS
```

**Errors:** `NONEXISTENT` for a missing mailbox or UID, `INVALID` for a UID list that is not positive integers.

### copyMessages(path, uids, target)

```typescript
copyMessages(path: string, uids: number[], target: string): { uidvalidity: number; uids: { uid: number; targetUid: number }[] }
```

Copies messages to another mailbox, in UID order like COPY. The copies keep the flags and internal date and get new UIDs in the target. Returns the UIDVALIDITY of the target and the new UID of every message, the same information COPYUID carries.

**What sessions see:** sessions that have the target selected get `EXISTS`.

```javascript
server.control.copyMessages('INBOX', [2, 1], 'Archive/2024');
// { uidvalidity: 3, uids: [ { uid: 1, targetUid: 1 }, { uid: 2, targetUid: 2 } ] }
```

**Errors:** `NONEXISTENT` for a missing source, target or UID.

### moveMessages(path, uids, target)

```typescript
moveMessages(path: string, uids: number[], target: string): { uidvalidity: number; uids: { uid: number; targetUid: number }[] }
```

Copies the messages like `copyMessages()` and then expunges them from the source. The return value has the same shape. It does not need the MOVE plugin.

**What sessions see:** `EXISTS` in the target, `EXPUNGE` (or `VANISHED`) and `EXISTS` in the source.

### replaceMessage(path, uid, message)

```typescript
replaceMessage(path: string, uid: number, message: { raw: string | Uint8Array; flags?: string[]; internaldate?: Date | string }): { uid: number; uidvalidity: number }
```

Replaces a message with a new source. The content of a UID never changes ([RFC 9051 section 2.3.1.1](https://www.rfc-editor.org/rfc/rfc9051#section-2.3.1.1)), so this adds the new message and expunges the old one, and the new message gets a new UID. Flags and internal date of the old message are kept unless `message` gives new ones. Returns the new UID.

**What sessions see:** `EXISTS` for the new message, then `EXPUNGE` (or `VANISHED`) and `EXISTS` for the old one:

```
* 4 EXISTS
* 1 EXPUNGE
* 3 EXISTS
```

**Errors:** as `addMessage()` (without the checks) and `NONEXISTENT` for a UID that does not exist.

## Mailboxes

### createMailbox(path, options)

```typescript
createMailbox(path: string, options?: { subscribed?: boolean }): MailboxInfo
```

Creates a mailbox like CREATE, with any missing superior levels as normal mailboxes. Creating the name of a `\Noselect` level turns it into a normal mailbox. `subscribed: true` subscribes the new mailbox (not the superior levels). Returns the new mailbox's `MailboxInfo`.

```javascript
server.control.createMailbox('Archive/2024', { subscribed: true });
// creates Archive and Archive/2024, the mailbox event lists created: [ 'Archive', 'Archive/2024' ]
```

**What sessions see:** nothing unsolicited, except NOTIFY sessions that asked for mailbox events. With ACL loaded, a new mailbox gets the ACL of its parent.

**Errors:** `INVALID` for a name that is not valid modified UTF-7, `ALREADYEXISTS` for an existing mailbox (also `INBOX`).

### deleteMailbox(path)

```typescript
deleteMailbox(path: string): void
```

Deletes a mailbox like DELETE. A mailbox with children stays as a `\Noselect` level. Subscriptions stay, as subscriptions are names.

**What sessions see:** sessions that have the mailbox selected get `* BYE Selected mailbox was deleted` and are disconnected, since they can not be told about the deletion any other way ([RFC 2180 section 3.3](https://www.rfc-editor.org/rfc/rfc2180#section-3.3)).

**Errors:** `NONEXISTENT` for a name that is not a mailbox, `CANNOT` for INBOX, `HASCHILDREN` for a `\Noselect` level that still has children.

### renameMailbox(path, newPath)

```typescript
renameMailbox(path: string, newPath: string): MailboxInfo
```

Renames a mailbox like RENAME, with its children. Returns the renamed mailbox's `MailboxInfo`. Sessions that have the mailbox selected stay connected. Subscriptions stay with the old names.

Renaming INBOX follows [RFC 3501 section 6.3.5](https://www.rfc-editor.org/rfc/rfc3501#section-6.3.5): the messages of INBOX move to a new mailbox with the new name, which gets a new UIDVALIDITY, and INBOX stays, empty. Sessions that have INBOX selected get `EXPUNGE` (or `VANISHED`) for every message.

```javascript
server.control.renameMailbox('INBOX', 'FromInbox');
// { path: 'FromInbox', ..., messages: 1, uidnext: 2, uidvalidity: 4, ... }
```

**Errors:** `NONEXISTENT` for a source that does not exist or is `\Noselect`, `ALREADYEXISTS` for a target that exists, `CANNOT` for a rename into the mailbox itself (`Can not move a mailbox into itself`), `INVALID` for a new name that is not valid modified UTF-7.

### subscribe(path)

```typescript
subscribe(path: string): boolean
```

Subscribes a mailbox. Returns `true` if the subscription changed, `false` if it was subscribed already. Throws `NONEXISTENT` for a name that is not a selectable mailbox.

### unsubscribe(path)

```typescript
unsubscribe(path: string): boolean
```

Removes a name from the subscriptions. The name does not have to be a mailbox, so a subscription left behind by a deleted or renamed mailbox can be removed. Returns `true` if the subscription changed, `false` if the name was not subscribed (not an error, as in [RFC 9051 section 6.3.8](https://www.rfc-editor.org/rfc/rfc9051#section-6.3.8)).

## Events

The mailbox operations emit the `mailbox` event, `setFlags()` the `flags` event, and every operation that removes messages the `expunge` event, all with `origin: null`. `addMessage()` and `copyMessages()` emit no event, and `replaceMessage()` only the `expunge` event of the old message. See [Events](./events.md).
