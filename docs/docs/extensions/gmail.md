---
title: Gmail Extensions
sidebar_position: 10
description: The X-GM-EXT-1 plugin of ImapKit with X-GM-MSGID, X-GM-THRID, X-GM-LABELS and a subset of X-GM-RAW, the storage keys it reads, and a Gmail like storage layout.
---

# Gmail extensions

|               |                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------- |
| Plugin        | `X-GM-EXT-1`                                                                                |
| Capability    | `X-GM-EXT-1`                                                                                |
| Reference     | [Gmail IMAP extensions](https://developers.google.com/workspace/gmail/imap/imap-extensions) |
| Server option | `HIGHESTX-GM-MSGID` (default `1278455344230334865`)                                         |

The plugin adds the Gmail specific message ids, thread ids, labels and the `X-GM-RAW` search key, so a client that has a Gmail code path can be tested without a Gmail account. Combine it with SPECIAL-USE and a Gmail shaped storage (below) and, for the login, with [XOAUTH2](./authentication-and-transport.md#xoauth2).

```javascript
const server = imapkit({ plugins: ['X-GM-EXT-1', 'SPECIAL-USE', 'XOAUTH2', 'SASL-IR'], storage });
```

## X-GM-MSGID and X-GM-THRID

Both are FETCH items and SEARCH keys, 64-bit unsigned numbers.

- Every message gets an `X-GM-MSGID` when the storage is loaded or the message is added: the server keeps a counter that starts at the `HIGHESTX-GM-MSGID` option and adds one for every message. A message in the storage can set its own `X-GM-MSGID`, and the counter continues above the largest one.
- COPY and MOVE keep the X-GM-MSGID and X-GM-THRID of the source message, as Gmail does for a message that is in several mailboxes.
- `X-GM-THRID` is the X-GM-MSGID of the message, so every message is its own thread, unless the storage sets an `X-GM-THRID` value for it. With [OBJECTID](./synchronization.md#objectid) loaded, the messages of a THREADID share the X-GM-THRID of the first message of that thread, so both thread ids group the same messages.
- A SEARCH argument that is not a number up to 2^64 - 1 is `BAD`.

## X-GM-LABELS

A FETCH item, a STORE item (`X-GM-LABELS`, `+X-GM-LABELS`, `-X-GM-LABELS`, each also with `.SILENT`) and a SEARCH key.

- System labels are atoms that start with `\`. A message in INBOX has `\Inbox`, a message in a special-use mailbox has that attribute (`\Sent`, `\Important` ...).
- Other labels are mailbox names, sent and read in the form the session uses for mailbox names: modified UTF-7, or UTF-8 after `ENABLE UTF8=ACCEPT`. They are quoted when they are not atoms, and STORE accepts literals.
- A message in a mailbox without a special-use attribute gets the mailbox name as a label.
- Labels from the storage come from the `X-GM-LABELS` array of a message.
- In SEARCH, a label that starts with `\` is a system label and matches without case.
- Labels have no side effects: setting a label does not copy the message to that mailbox, and removing one does not remove it.

## X-GM-RAW

The SEARCH key `X-GM-RAW "query"` supports a subset of the Gmail search syntax:

| Syntax                                                                               | Meaning                                       |
| ------------------------------------------------------------------------------------ | --------------------------------------------- |
| `word`, `"a phrase"`                                                                 | TEXT search                                   |
| `-term`                                                                              | NOT                                           |
| `a OR b`, `( ... )`, `{a b}`                                                         | OR, grouping, any of                          |
| `from:`, `to:`, `cc:`, `bcc:`, `subject:`                                            | header search                                 |
| `label:name`                                                                         | X-GM-LABELS                                   |
| `in:inbox`, `in:sent`, `in:drafts`, `in:trash`, `in:spam`, `in:anywhere`, `in:label` | system labels, or any label                   |
| `is:read`, `is:unread`, `is:starred`, `is:important`                                 | SEEN, UNSEEN, FLAGGED, the `\Important` label |
| `larger:`, `smaller:`                                                                | size, with `k` or `m` suffixes                |
| `after:`, `before:`                                                                  | dates as `YYYY/MM/DD`                         |
| `rfc822msgid:`                                                                       | the Message-ID header                         |

Other Gmail operators (`has:`, `older_than:`, `newer_than:`, `filename:`, `category:` ...) are answered with `NO`, rather than with a wrong result.

## Example

With the four message INBOX used elsewhere in these docs, where the first message has `"X-GM-LABELS": ["Work", "\\Important"]` and the second `"X-GM-THRID": "1278455344230334866"` in the storage:

```text
C: A2 CAPABILITY
S: * CAPABILITY IMAP4rev1 X-GM-EXT-1 SPECIAL-USE
S: A2 OK Completed
C: A3 SELECT INBOX
S: ...
S: A3 OK [READ-WRITE] Completed
C: A4 FETCH 1:2 (X-GM-MSGID X-GM-THRID X-GM-LABELS)
S: * 1 FETCH (X-GM-MSGID 1278455344230334867 X-GM-THRID 1278455344230334867 X-GM-LABELS (Work \Important \Inbox))
S: * 2 FETCH (X-GM-MSGID 1278455344230334868 X-GM-THRID 1278455344230334866 X-GM-LABELS (\Inbox))
S: A4 OK FETCH Completed
C: A5 STORE 2 +X-GM-LABELS (Work "Project X")
S: * 2 FETCH (X-GM-LABELS (\Inbox Work "Project X"))
S: A5 OK STORE completed
C: A6 SEARCH X-GM-LABELS Work
S: * SEARCH 1 2
S: A6 OK SEARCH completed
C: A7 SEARCH X-GM-RAW "from:alice is:unread"
S: * SEARCH 4
S: A7 OK SEARCH completed
C: A8 UID SEARCH X-GM-RAW "subject:(lunch) OR label:work"
S: * SEARCH 1 2
S: A8 OK UID SEARCH completed
C: A9 SEARCH X-GM-RAW "has:attachment"
S: A9 NO X-GM-RAW operator has:attachment is not supported by imapkit
C: A11 SELECT "[Gmail]/Sent Mail"
S: ...
S: A11 OK [READ-WRITE] Completed
C: A12 FETCH 1 (X-GM-LABELS)
S: * 1 FETCH (X-GM-LABELS (\Sent))
S: A12 OK FETCH Completed
```

## Storage keys

| Where         | Key                 | Value                                                                                        |
| ------------- | ------------------- | -------------------------------------------------------------------------------------------- |
| message       | `X-GM-MSGID`        | decimal string, the message id                                                               |
| message       | `X-GM-THRID`        | decimal string, the thread id                                                                |
| message       | `X-GM-LABELS`       | array of labels, system labels with a leading `\`                                            |
| mailbox       | `special-use`       | the system label of the messages in it (with the SPECIAL-USE plugin also the LIST attribute) |
| server option | `HIGHESTX-GM-MSGID` | where the X-GM-MSGID counter starts                                                          |

## Gmail storage layout

A storage that looks like a Gmail account, with the `[Gmail]` level and its special-use mailboxes:

```json
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

Unlike Gmail, ImapKit does not show a message in `[Gmail]/All Mail` or in label mailboxes automatically. Put the messages where your test needs them. See [Storage](../guides/storage.md) for the storage format.
