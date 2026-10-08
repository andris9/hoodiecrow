---
title: Storage
sidebar_position: 2
description: The storage option in depth, namespaces, mailboxes, messages, \Recent, plugin data, subscriptions, validation and snapshot round trips.
---

# Storage

The `storage` option describes the whole mailbox tree a server starts with: namespaces, mailboxes, messages, flags and UIDs. The command line takes the same object as a JSON file with `--storage=<path>` (or `IMAPKIT_STORAGE`).

ImapKit deep copies the object when the server is built, so you can reuse one fixture for many servers and nothing a client does ever changes your object. Without a `storage` option the server starts with an empty INBOX and an empty personal namespace, `{ "INBOX": {}, "": {} }`.

## A first example

```javascript title="storage-example.js"
import imapkit from 'imapkit';

const server = imapkit({
    plugins: ['NAMESPACE', 'SPECIAL-USE'],
    storage: {
        INBOX: {
            uidvalidity: 1700000000,
            messages: [
                'Subject: plain string\r\n\r\nHello\r\n',
                {
                    raw: 'Subject: with options\r\n\r\nHi\r\n',
                    uid: 45,
                    flags: ['\\Seen', '$Important'],
                    internaldate: '14-Sep-2013 21:22:28 -0300'
                }
            ]
        },
        '': {
            separator: '/',
            folders: {
                Archive: {
                    'special-use': '\\Archive',
                    folders: { 2025: {} }
                },
                Sent: { 'special-use': '\\Sent', subscribed: false }
            }
        },
        '#shared/': { type: 'shared' }
    }
});

const port = await server.start();
```

A client that logs in sees this (`C:` is the client, `S:` the server):

```text
C: A2 NAMESPACE
S: * NAMESPACE (("" "/")) NIL (("#shared/" "/"))
S: A2 OK Completed
C: A3 LIST "" "*"
S: * LIST (\HasNoChildren) "/" "INBOX"
S: * LIST (\HasChildren \Archive) "/" "Archive"
S: * LIST (\HasNoChildren) "/" "Archive/2025"
S: * LIST (\HasNoChildren \Sent) "/" "Sent"
S: A3 OK Completed
C: A4 LSUB "" "*"
S: * LSUB (\HasNoChildren) "/" "INBOX"
S: * LSUB (\HasChildren \Archive) "/" "Archive"
S: * LSUB (\HasNoChildren) "/" "Archive/2025"
S: A4 OK Completed
C: A5 SELECT INBOX
S: * FLAGS (\Answered \Flagged \Draft \Deleted \Seen $Important)
S: * OK [PERMANENTFLAGS (\Answered \Flagged \Draft \Deleted \Seen $Important \*)] Flags permitted
S: * 2 EXISTS
S: * 0 RECENT
S: * OK [UNSEEN 2] First unseen message
S: * OK [UIDVALIDITY 1700000000] UIDs valid
S: * OK [UIDNEXT 47] Predicted next UID
S: A5 OK [READ-WRITE] Completed
C: A6 FETCH 1:* (UID FLAGS INTERNALDATE)
S: * 1 FETCH (UID 45 FLAGS (\Seen $Important) INTERNALDATE "14-Sep-2013 21:22:28 -0300")
S: * 2 FETCH (UID 46 FLAGS () INTERNALDATE "08-Oct-2026 18:21:25 +0300")
S: A6 OK FETCH Completed
```

A few things to notice, each explained below:

- The message given as a plain string got UID 46, after the explicit UID 45, and the current time as its internal date.
- `$Important` shows up in FLAGS and PERMANENTFLAGS because a message has it.
- `Sent` has `subscribed: false`, so LSUB leaves it out.
- `\Archive` and `\Sent` are listed because the SPECIAL-USE plugin is loaded.

## Namespaces

The top level keys of `storage` are namespaces, keyed by their prefix. The one exception is `INBOX`, which is a mailbox of its own (it can still have child mailboxes in `folders`).

| Key                          | Meaning                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `"INBOX"`                    | The INBOX mailbox. Takes the [mailbox keys](#mailboxes) and `separator`.                     |
| `""`                         | A namespace without a prefix, mailbox names are used as they are (`Archive/2025`).           |
| `"INBOX."`                   | A namespace with a prefix, as Cyrus uses it: mailboxes are `INBOX.Drafts`, `INBOX.Sent`, ... |
| `"#shared/"`, `"user."`, ... | Other namespaces, usually with `type` set to `"shared"` or `"user"`.                         |

A namespace object takes these keys, plus the [mailbox keys](#mailboxes):

| Key         | Default                                                                         | Description                                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `separator` | The last character of the key if it is not a letter or a digit, otherwise `"/"` | The hierarchy separator, a single character. `"INBOX."` gets `"."`, `"#shared/"` gets `"/"`, `"#news"` and `""` get `"/"`.                                                           |
| `type`      | `"personal"`                                                                    | `"personal"`, `"user"` (other users' mailboxes) or `"shared"`. The NAMESPACE plugin lists the namespaces in these three groups ([RFC 2342](https://www.rfc-editor.org/rfc/rfc2342)). |
| `folders`   | `{}`                                                                            | The mailboxes of the namespace, by name.                                                                                                                                             |

LIST patterns match full mailbox names: with an empty reference the name is interpreted as SELECT would interpret it ([RFC 9051 section 6.3.9](https://www.rfc-editor.org/rfc/rfc9051#section-6.3.9)), so with a prefixed personal namespace like `"INBOX."` the pattern includes the prefix (`LIST "" "INBOX.%"`). The wildcards match the mailboxes of the first personal namespace, INBOX and namespaces without a prefix. The mailboxes of other namespaces are only matched when the pattern names the namespace prefix before any wildcard (`LIST "" "user.%"`, `LIST "#shared/" "*"`), which RFC 9051 allows ("Server implementations are permitted to "hide" otherwise accessible mailboxes from the wildcard characters"). If the storage has no personal namespace, ImapKit adds `""` as one. INBOX takes the separator of the first personal namespace unless it sets its own `separator`.

New mailboxes can only be created in personal namespaces. CREATE of a name in a `user` or `shared` namespace is answered with `NO [NOPERM]`.

### Cyrus

A Cyrus style layout keeps personal mailboxes under `INBOX.`, other users under `user.` and shared mailboxes without a prefix:

```json title="storage.json"
{
    "INBOX": {},
    "INBOX.": {},
    "user.": {
        "type": "user"
    },
    "": {
        "type": "shared"
    }
}
```

With the NAMESPACE plugin loaded the server answers:

```text
C: A2 NAMESPACE
S: * NAMESPACE (("INBOX." ".")) (("user." ".")) (("" "/"))
S: A2 OK Completed
```

LIST patterns include the `INBOX.` prefix. With the mailboxes `INBOX.Drafts` and `INBOX.Sent`, `%` lists INBOX itself, and `INBOX.%` the mailboxes below it:

```text
C: A3 LIST "" "%"
S: * LIST (\HasChildren) "." "INBOX"
S: A3 OK Completed
C: A4 LIST "" "INBOX.%"
S: * LIST (\HasNoChildren) "." "INBOX.Drafts"
S: * LIST (\HasNoChildren) "." "INBOX.Sent"
S: A4 OK Completed
```

### Gmail

Gmail keeps its system mailboxes under a `\Noselect` `[Gmail]` level and marks them with special-use attributes:

```json title="storage.json"
{
    "INBOX": {},
    "": {
        "separator": "/",
        "folders": {
            "[Gmail]": {
                "flags": ["\\Noselect"],
                "folders": {
                    "All Mail": { "special-use": "\\All" },
                    "Drafts": { "special-use": "\\Drafts" },
                    "Important": { "special-use": "\\Important" },
                    "Sent Mail": { "special-use": "\\Sent" },
                    "Spam": { "special-use": "\\Junk" },
                    "Starred": { "special-use": "\\Flagged" },
                    "Trash": { "special-use": "\\Trash" }
                }
            }
        }
    }
}
```

With the SPECIAL-USE plugin (and X-GM-EXT-1 for the Gmail extensions):

```text
C: A2 LIST "" "*"
S: * LIST (\HasNoChildren) "/" "INBOX"
S: * LIST (\Noselect \HasChildren) "/" "[Gmail]"
S: * LIST (\HasNoChildren \All) "/" "[Gmail]/All Mail"
S: * LIST (\HasNoChildren \Drafts) "/" "[Gmail]/Drafts"
S: * LIST (\HasNoChildren \Important) "/" "[Gmail]/Important"
S: * LIST (\HasNoChildren \Sent) "/" "[Gmail]/Sent Mail"
S: * LIST (\HasNoChildren \Junk) "/" "[Gmail]/Spam"
S: * LIST (\HasNoChildren \Flagged) "/" "[Gmail]/Starred"
S: * LIST (\HasNoChildren \Trash) "/" "[Gmail]/Trash"
S: A2 OK Completed
```

## Mailboxes

INBOX, every namespace and every entry in a `folders` object take these keys. All of them are optional.

| Key                   | Default                                                              | Description                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uidvalidity`         | `1`                                                                  | UIDVALIDITY, an integer from 1 to 4294967295. A mailbox created later gets a value higher than any in use.                                                                                                                                                                                                                                           |
| `uidnext`             | One more than the highest UID                                        | The next UID. A value lower than the highest message UID plus one is raised.                                                                                                                                                                                                                                                                         |
| `flags`               | `[]`                                                                 | Mailbox attributes, for example `["\\Noselect"]` or `["\\Noinferiors"]`, in any case. `\HasChildren` and `\HasNoChildren` are set by the server.                                                                                                                                                                                                     |
| `permanentFlags`      | The `systemFlags` option, `\Answered \Flagged \Draft \Deleted \Seen` | The flags clients can store.                                                                                                                                                                                                                                                                                                                         |
| `allowPermanentFlags` | `true`                                                               | When true, clients can create new keywords (PERMANENTFLAGS ends with `\*`). When false, the permanent flags are `permanentFlags` and every flag a message of the mailbox has or had (`knownFlags`), the list SELECT sends in PERMANENTFLAGS. STORE ignores other flags, APPEND and COPY leave them out, the control API refuses them with `INVALID`. |
| `knownFlags`          | `[]`                                                                 | Keywords that stay in FLAGS and PERMANENTFLAGS even when no message has them. The server adds every flag a message gets here, a snapshot keeps the list.                                                                                                                                                                                             |
| `subscribed`          | `true`                                                               | Set `false` to leave the mailbox out of the subscription list, see [Subscriptions](#subscriptions).                                                                                                                                                                                                                                                  |
| `messages`            | `[]`                                                                 | The messages, see [Messages](#messages).                                                                                                                                                                                                                                                                                                             |
| `folders`             | none                                                                 | Child mailboxes by name.                                                                                                                                                                                                                                                                                                                             |
| `uid`                 | `1`                                                                  | Kept from older versions of the format and not used. Snapshots include it.                                                                                                                                                                                                                                                                           |

A `\Noselect` mailbox is only a hierarchy level: it is listed, but SELECT answers `NO [NONEXISTENT]`. A `\Noinferiors` mailbox can not get children, CREATE below it is answered with `NO [CANNOT]`.

Flags of messages in the storage become flags of the mailbox: they are added to FLAGS and PERMANENTFLAGS, and a keyword stays there after the last message with it loses it ([RFC 3501 section 7.2.6](https://www.rfc-editor.org/rfc/rfc3501#section-7.2.6)).

## Messages

A message is either a string with the full message source, or an object:

| Key            | Default          | Description                                                                                                                                                                                                                                                                                                                                |
| -------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `raw`          | `""`             | The message source. A string, or a `Buffer` / `Uint8Array` in JavaScript.                                                                                                                                                                                                                                                                  |
| `uid`          | Assigned         | The UID, an integer from 1 to 4294967295. Two messages with the same UID in one mailbox throw `Duplicate UID <n> in mailbox <path>`.                                                                                                                                                                                                       |
| `flags`        | `[]`             | A flag or a list of flags. `\Recent` here is turned into `recent: true`.                                                                                                                                                                                                                                                                   |
| `internaldate` | The current time | An RFC 3501 date-time string such as `"14-Sep-2013 21:22:28 -0300"`, or a `Date`. The month name can be in any case, it is sent as `Sep`. Other forms, such as a Date header value (`"Thu, 1 Jan 2026 10:00:00 +0000"`), impossible dates and invalid `Date` objects, are refused when the server is built, see [Validation](#validation). |
| `recent`       | `false`          | `true` makes the message `\Recent` for the first session that selects the mailbox, see [`\Recent`](#recent).                                                                                                                                                                                                                               |

Messages are sorted by UID when the server loads them. Messages without a `uid` get UIDs after the highest UID of the mailbox, in the order they are listed. That is why the plain string in the first example got UID 46 and not 1.

The current time for messages without `internaldate` comes from the `now` option when it is set, which keeps dates the same from run to run (see [Repeatable tests](../faults/repeatable-tests.md)).

:::caution 8-bit message sources
ImapKit keeps a message source as a binary string, one character per octet. A JavaScript string with characters up to U+00FF is taken octet by octet, so `'Subject: café'` stores `é` as the single Latin-1 octet `0xE9`. Only a string with a character above U+00FF is encoded as UTF-8. To store UTF-8 (or any exact octets), pass a `Buffer`: `{ raw: Buffer.from('Subject: café\r\n\r\nx') }`.
:::

## `\Recent`

`\Recent` is a session flag, not a stored one ([RFC 3501 section 2.3.2](https://www.rfc-editor.org/rfc/rfc3501#section-2.3.2)). A message from the storage is `\Recent` only when it has `recent: true` (or `\Recent` in its `flags`). The first session that selects the mailbox read-write takes the `\Recent` flags, later sessions see `0 RECENT`. EXAMINE shows them but does not take them. See [Multiple sessions](./multiple-sessions.md#recent) for a transcript.

Messages added later by APPEND, COPY, MOVE, SMTP or the control API are `\Recent` for one session: a session that has the mailbox selected read-write gets them, otherwise the next session that selects it.

## Plugin data

Plugins keep their own data on mailboxes and messages, and the storage can set it up front. A key is only used when its plugin is loaded, otherwise it is kept as it is and ignored.

| Key                                       | On               | Plugin                                      | Description                                                                                                                                       |
| ----------------------------------------- | ---------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `special-use`                             | mailbox          | SPECIAL-USE, CREATE-SPECIAL-USE, X-GM-EXT-1 | A special-use attribute or a list of them, for example `"\\Sent"`.                                                                                |
| `acl`                                     | mailbox          | ACL                                         | Rights by identifier, for example `{ "otheruser": "lrs", "anyone": "l" }`. See [Access control](../extensions/access-control.md).                 |
| `metadata`                                | mailbox          | METADATA                                    | Mailbox annotations, for example `{ "/private/comment": "My comment" }`.                                                                          |
| `appendLimit`                             | mailbox          | APPENDLIMIT                                 | The APPEND limit of the mailbox in octets, `null` for no limit.                                                                                   |
| `HIGHESTMODSEQ`                           | mailbox          | CONDSTORE                                   | The highest mod-sequence.                                                                                                                         |
| `MODSEQ`                                  | message          | CONDSTORE                                   | The mod-sequence of the message, a new one is assigned when missing.                                                                              |
| `qresyncExpunged`                         | mailbox          | QRESYNC                                     | Expunged UIDs with their mod-sequences, written by the server. UIDs missing from the initial storage count as expunged before the server started. |
| `MAILBOXID`                               | mailbox          | OBJECTID                                    | The mailbox id, generated (`F1`, `F2`, ...) when missing.                                                                                         |
| `EMAILID`, `THREADID`                     | message          | OBJECTID                                    | The message and thread ids, generated (`M1`, `T1`, ...) when missing.                                                                             |
| `SAVEDATE`                                | mailbox, message | SAVEDATE                                    | On a mailbox, `false` turns save dates off. On a message, the save date (a date-time string or a `Date`), the server start time when missing.     |
| `X-GM-MSGID`, `X-GM-THRID`, `X-GM-LABELS` | message          | X-GM-EXT-1                                  | Gmail message id, thread id and labels.                                                                                                           |
| `preview`                                 | message          | PREVIEW                                     | A fixed PREVIEW text instead of a generated one.                                                                                                  |

```json title="storage.json"
{
    "INBOX": {
        "acl": { "otheruser": "lrs" },
        "metadata": { "/private/comment": "My comment" },
        "messages": [{ "raw": "Subject: hi\r\n\r\nHello\r\n", "MODSEQ": 5, "EMAILID": "M100" }]
    },
    "": {}
}
```

## Subscriptions

The subscription list holds mailbox names, not mailboxes ([RFC 3501 section 6.3.6](https://www.rfc-editor.org/rfc/rfc3501#section-6.3.6)):

- A mailbox from the storage is subscribed unless it has `"subscribed": false`. A mailbox created later is not.
- DELETE does not unsubscribe. LSUB and `LIST (SUBSCRIBED)` keep listing the name (as `\NonExistent` in extended LIST) until UNSUBSCRIBE, and a mailbox created again under that name is subscribed.
- RENAME leaves the subscription with the old name.
- SUBSCRIBE refuses names that are not mailboxes, UNSUBSCRIBE accepts any name.

```text
C: A2 LSUB "" "*"
S: * LSUB (\HasNoChildren) "/" "INBOX"
S: * LSUB (\HasNoChildren) "/" "Old"
S: A2 OK Completed
C: A3 CREATE New
S: A3 OK CREATE completed
C: A4 RENAME Old Renamed
S: A4 OK RENAME completed
C: A5 DELETE Renamed
S: A5 OK DELETE completed
C: A6 LIST (SUBSCRIBED) "" "*"
S: * LIST (\Subscribed \HasNoChildren) "/" "INBOX"
S: * LIST (\NonExistent \Subscribed \HasNoChildren) "/" "Old"
S: A6 OK Completed
C: A7 SUBSCRIBE Missing
S: A7 NO [NONEXISTENT] Mailbox does not exist
```

This run used `{ "INBOX": {}, "": { "folders": { "Old": {}, "Hidden": { "subscribed": false } } } }` with the LIST-EXTENDED plugin. `New` is not subscribed because it was created by a client.

## Validation

The server checks the `storage` option when it is built and throws an error with the path of the problem, so a typo in a fixture fails loudly instead of giving you an empty mailbox:

```javascript title="validate.js"
import imapkit, { validateStorage } from 'imapkit';

try {
    imapkit({ storage: { INBOX: { message: ['Subject: hi\r\n\r\nHello\r\n'] } } });
} catch (err) {
    console.log(err.message);
    // Invalid storage at "INBOX": unknown key "message", did you mean "messages"?
}

try {
    validateStorage({ '': { folders: { Sent: { messages: [{ raw: 'x', uid: 0 }] } } } });
} catch (err) {
    console.log(err.message);
    // Invalid storage at "".folders["Sent"].messages[0].uid: must be an integer from 1 to 4294967295
}
```

The check covers the types of the known keys, `type` and `separator` of namespaces, `internaldate` and `SAVEDATE` values that are not an RFC 3501 date-time string or a valid `Date`, and keys that look like a typo of a known key (the same key in another case, or one edit away, such as `uidValidity` or `flagz`). Other unknown keys are allowed, since plugins keep their own data on mailboxes and messages.

The package exports the same check and a JSON Schema (draft 2020-12) of the format:

| Export                     | Description                                                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `validateStorage(storage)` | Throws `Invalid storage at <path>: <problem>` for an invalid storage object.                                                             |
| `storageSchema`            | The JSON Schema, with `$defs` for `mailbox`, `message` and `namespace`. Point your editor or a schema validator at it for storage files. |

```javascript
import { storageSchema, validateStorage } from 'imapkit';
```

## Snapshots

`server.control.snapshot()` returns the current state in the shape of the `storage` option: mailboxes, messages, UIDs, flags, subscriptions and the JSON data of plugins. A new server built from a snapshot starts where the old one stopped:

```javascript title="snapshot.js"
import assert from 'node:assert';
import imapkit from 'imapkit';

const server = imapkit({ plugins: ['CONDSTORE'] });
server.control.createMailbox('Projects');
server.control.addMessage('Projects', { raw: 'Subject: plan\r\n\r\nDraft\r\n', flags: ['\\Draft'] });

const saved = server.control.snapshot();

// a new server starts from the saved state
const copy = imapkit({ plugins: ['CONDSTORE'], storage: saved });
assert.deepStrictEqual(copy.control.snapshot(), saved);
```

The `Projects` part of that snapshot looks like this. Every key the server filled in is written out, the message source is the binary string described in [Messages](#messages):

```json
{
    "uidvalidity": 2,
    "uid": 1,
    "allowPermanentFlags": true,
    "permanentFlags": ["\\Answered", "\\Flagged", "\\Draft", "\\Deleted", "\\Seen"],
    "uidnext": 2,
    "knownFlags": ["\\Draft"],
    "HIGHESTMODSEQ": 2,
    "flags": [],
    "subscribed": false,
    "messages": [
        {
            "flags": ["\\Draft"],
            "internaldate": "08-Oct-2026 18:21:55 +0300",
            "raw": "Subject: plan\r\n\r\nDraft\r\n",
            "recent": true,
            "uid": 1,
            "MODSEQ": 2
        }
    ]
}
```

Subscriptions of names that are not mailboxes (for example a deleted mailbox that is still subscribed) are not part of a snapshot. See [Mailboxes and messages](../control-api/mailboxes-and-messages.md) for the rest of the control API.
