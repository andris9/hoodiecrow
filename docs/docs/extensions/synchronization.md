---
title: Synchronization
sidebar_position: 4
description: ENABLE, IDLE, CONDSTORE, QRESYNC, OBJECTID, NOTIFY and UIDONLY in ImapKit, the extensions a client uses to keep its cache in sync with the server.
---

# Synchronization

These plugins cover how a client learns about changes: push notifications, mod-sequences, quick resynchronization, stable object ids and UID-only sessions.

| Plugin      | Capability  | RFC                                                |
| ----------- | ----------- | -------------------------------------------------- |
| `ENABLE`    | `ENABLE`    | [RFC 5161](https://www.rfc-editor.org/rfc/rfc5161) |
| `IDLE`      | `IDLE`      | [RFC 2177](https://www.rfc-editor.org/rfc/rfc2177) |
| `CONDSTORE` | `CONDSTORE` | [RFC 7162](https://www.rfc-editor.org/rfc/rfc7162) |
| `QRESYNC`   | `QRESYNC`   | [RFC 7162](https://www.rfc-editor.org/rfc/rfc7162) |
| `OBJECTID`  | `OBJECTID`  | [RFC 8474](https://www.rfc-editor.org/rfc/rfc8474) |
| `NOTIFY`    | `NOTIFY`    | [RFC 5465](https://www.rfc-editor.org/rfc/rfc5465) |
| `UIDONLY`   | `UIDONLY`   | [RFC 9586](https://www.rfc-editor.org/rfc/rfc9586) |

Changes made by another session, or through the [control API](../control-api/overview.md), reach a session the same way. See [Multiple sessions](../guides/multiple-sessions.md) for when ImapKit reports them.

## ENABLE

Adds the `ENABLE` command. The extensions that can be enabled are those whose plugins are loaded: `CONDSTORE`, `QRESYNC`, `UIDONLY`, `UTF8=ACCEPT`, `IMAP4rev2` and `METADATA` (or `METADATA-SERVER`). They can be loaded in any order with ENABLE, and QRESYNC, UIDONLY, UTF8=ACCEPT and IMAP4rev2 load ENABLE themselves.

- Capability names are matched case-insensitively. The `ENABLED` response lists only what this command enabled, in the advertised spelling (`IMAP4rev2`, `UTF8=ACCEPT`). Unknown names are ignored, as RFC 5161 section 3.1 requires.
- ENABLE needs a logged in session, and ImapKit refuses it with `BAD` once the session has selected a mailbox, since RFC 5161 section 3.1 says clients MUST NOT issue ENABLE once they SELECT or EXAMINE a mailbox. Servers do not have to check this, ImapKit does to catch the client bug.
- [UNAUTHENTICATE](./authentication-and-transport.md#unauthenticate) turns every enabled extension off.

```text
C: A2 ENABLE CONDSTORE
S: * ENABLED CONDSTORE
S: A2 OK ENABLE completed
```

```text
C: A2 SELECT INBOX
S: ...
S: A2 OK [READ-WRITE] Completed
C: A3 ENABLE CONDSTORE
S: A3 BAD ENABLE is not allowed after SELECT or EXAMINE
```

## IDLE

Adds the `IDLE` command. After the `+ idling` continuation the server sends changes as soon as they happen: new messages, expunges and flag changes by other sessions or the control API. The client ends IDLE with `DONE` (case-insensitive); any other line ends it with `BAD`.

In the transcripts with two sessions, `A C:` lines are sent by session A and `A S:` lines are what it receives, the same for session B. Here A has INBOX selected and idles while B appends a message:

```text
A C: A3 IDLE
A S: + idling
B C: B2 APPEND INBOX {20}
B S: + Go ahead
B C: Subject: hi
B C:
B C: hello
A S: * 5 EXISTS
A S: * 1 RECENT
B S: B2 OK APPEND Completed
A C: DONE
A S: A3 OK IDLE terminated
```

```text
C: A3 IDLE
S: + idling
C: NOOP
S: A3 BAD Invalid Idle continuation
```

An IDLE that lasts 30 minutes is ended by the server with `* BYE IDLE terminated` and the connection is closed. RFC 2177 lets a server log out a client that idles longer than that, which is why clients restart IDLE at least every 29 minutes. The timer does not keep the Node.js process alive.

## CONDSTORE

Adds mod-sequences (RFC 7162 section 3.1):

- Every message has a MODSEQ value, and every mailbox a HIGHESTMODSEQ. A message in storage can set its own `MODSEQ`, others get the next value when the storage is loaded or the message is added.
- SELECT and EXAMINE report `[HIGHESTMODSEQ n]`, and take the `(CONDSTORE)` parameter.
- Changing flags increments the MODSEQ of each changed message. Expunging increments HIGHESTMODSEQ.
- `FETCH ... (MODSEQ)` and the `CHANGEDSINCE` FETCH modifier.
- The `UNCHANGEDSINCE` STORE modifier. Messages changed since then are not stored and are listed in `[MODIFIED ...]`.
- The `MODSEQ` search key. The entry name and type are checked but ignored, as the mod-sequence is not stored per flag.
- `STATUS (HIGHESTMODSEQ)`.
- Flag changes by other sessions include MODSEQ once CONDSTORE is enabled in the session.
- SELECT and EXAMINE send `* OK [CLOSED]` when they close the selected mailbox (RFC 7162 section 3.2.11).

CONDSTORE is enabled in a session by `ENABLE CONDSTORE` (with the ENABLE plugin) or by the first CONDSTORE enabling command: `SELECT`/`EXAMINE` with `(CONDSTORE)`, `STATUS (HIGHESTMODSEQ)`, FETCH of `MODSEQ` or with `CHANGEDSINCE`, STORE with `UNCHANGEDSINCE`, or a search with the `MODSEQ` key. ImapKit gives every message changed by one STORE its own MODSEQ.

```text
C: A2 SELECT INBOX (CONDSTORE)
S: * FLAGS (\Answered \Flagged \Draft \Deleted \Seen)
S: * OK [PERMANENTFLAGS (\Answered \Flagged \Draft \Deleted \Seen \*)] Flags permitted
S: * 4 EXISTS
S: * 0 RECENT
S: * OK [UNSEEN 2] First unseen message
S: * OK [UIDVALIDITY 1] UIDs valid
S: * OK [UIDNEXT 5] Predicted next UID
S: * OK [HIGHESTMODSEQ 5] Highest
S: A2 OK [READ-WRITE] Completed, CONDSTORE is now enabled
C: A3 FETCH 1:* (FLAGS) (CHANGEDSINCE 1)
S: * 1 FETCH (FLAGS (\Seen) MODSEQ (2))
S: * 2 FETCH (FLAGS () MODSEQ (3))
S: * 3 FETCH (FLAGS (\Flagged) MODSEQ (4))
S: * 4 FETCH (FLAGS () MODSEQ (5))
S: A3 OK FETCH Completed
C: A4 STORE 1:2 (UNCHANGEDSINCE 1) +FLAGS (\Answered)
S: A4 OK [MODIFIED 1,2] STORE completed
C: A5 UID SEARCH MODSEQ 1
S: * SEARCH 1 2 3 4 (MODSEQ 5)
S: A5 OK UID SEARCH completed
C: A6 SELECT Archive
S: * OK [CLOSED] Previous mailbox closed
S: ...
S: * OK [HIGHESTMODSEQ 1] Highest
S: A6 OK [READ-WRITE] Completed
```

Mod-sequence values that break the RFC 7162 grammar (not a number, `0` for CHANGEDSINCE, more than 63 bits) are `BAD`. Without the CONDSTORE plugin, messages have no MODSEQ and the CONDSTORE syntax is not accepted.

## QRESYNC

Loads CONDSTORE and ENABLE. After `ENABLE QRESYNC`:

- `SELECT` and `EXAMINE` take `(QRESYNC (uidvalidity modseq [known-uids] [(known-sequence-set known-uid-set)]))` and report `VANISHED (EARLIER)` for the expunged UIDs and FETCH responses for the messages whose flags changed.
- `UID FETCH ... (CHANGEDSINCE n VANISHED)` reports the UIDs expunged since mod-sequence n.
- Expunges are reported with `VANISHED` instead of `EXPUNGE`: EXPUNGE, UID EXPUNGE, MOVE, expunges by other sessions and IDLE notifications.

Expunged UIDs are remembered with their mod-sequence. UIDs missing from the initial storage (gaps below UIDNEXT) count as expunged before the server started.

```text
C: A2 SELECT INBOX (QRESYNC (1 1))
S: A2 BAD QRESYNC parameter requires ENABLE QRESYNC
C: A3 ENABLE QRESYNC
S: * ENABLED QRESYNC
S: A3 OK ENABLE completed
C: A4 SELECT INBOX
S: ...
S: * OK [HIGHESTMODSEQ 5] Highest
S: A4 OK [READ-WRITE] Completed
C: A5 STORE 2 +FLAGS (\Deleted)
S: * 2 FETCH (FLAGS (\Deleted) MODSEQ (6) UID 2)
S: A5 OK STORE completed
C: A6 UID EXPUNGE 2
S: * VANISHED 2
S: A6 OK [HIGHESTMODSEQ 7] UID EXPUNGE completed
C: A7 SELECT INBOX (QRESYNC (1 5 1:4))
S: * OK [CLOSED] Previous mailbox closed
S: * FLAGS (\Answered \Flagged \Draft \Deleted \Seen)
S: * OK [PERMANENTFLAGS (\Answered \Flagged \Draft \Deleted \Seen \*)] Flags permitted
S: * 3 EXISTS
S: * 0 RECENT
S: * OK [UNSEEN 2] First unseen message
S: * OK [UIDVALIDITY 1] UIDs valid
S: * OK [UIDNEXT 5] Predicted next UID
S: * OK [HIGHESTMODSEQ 7] Highest
S: * VANISHED (EARLIER) 2
S: A7 OK [READ-WRITE] Completed
C: A8 UID FETCH 1:* (FLAGS) (CHANGEDSINCE 5 VANISHED)
S: * VANISHED (EARLIER) 2
S: A8 OK UID FETCH Completed
```

(UID EXPUNGE comes from the [UIDPLUS](./messages.md#uidplus) plugin.)

Strict checks, all answered with `BAD`:

- the QRESYNC SELECT parameter or the `VANISHED` modifier without `ENABLE QRESYNC`
- `VANISHED` with `FETCH` instead of `UID FETCH`, or without `CHANGEDSINCE`
- a UIDVALIDITY or mod-sequence of `0`, `*` in the UID sets, and sequence match sets that are not in ascending order or not of the same size

## OBJECTID

Adds the object identifiers of RFC 8474:

- `MAILBOXID`: a response code of SELECT, EXAMINE and CREATE, and a STATUS item.
- `EMAILID` and `THREADID`: FETCH items and SEARCH keys.

Ids are generated (`F1`, `M1`, `T1` ...) unless the storage sets a `MAILBOXID` for a mailbox or an `EMAILID` and `THREADID` for a message. Storage values must be valid object ids (1 to 255 letters, digits, `_` or `-`), a MAILBOXID can not repeat, and messages with the same EMAILID must have the same THREADID, otherwise the server throws when it is created.

COPY, MOVE and RENAME of INBOX keep the EMAILID and THREADID of a message. Messages are threaded by their `Message-ID`, `In-Reply-To` and `References` headers across all mailboxes, and a message joins the thread of the nearest known parent when it is added.

```text
C: A2 SELECT INBOX
S: ...
S: * OK [MAILBOXID (F7)] Ok
S: A2 OK [READ-WRITE] Completed
C: A3 FETCH 1:4 (EMAILID THREADID)
S: * 1 FETCH (EMAILID (M1) THREADID (T1))
S: * 2 FETCH (EMAILID (M2) THREADID (T1))
S: * 3 FETCH (EMAILID (M3) THREADID (T2))
S: * 4 FETCH (EMAILID (M4) THREADID (T2))
S: A3 OK FETCH Completed
C: A4 STATUS Archive (MAILBOXID)
S: * STATUS Archive (MAILBOXID (F1))
S: A4 OK Status completed
C: A5 CREATE Lists
S: A5 OK [MAILBOXID (F8)] CREATE completed
C: A6 SEARCH THREADID T1
S: * SEARCH 1 2
S: A6 OK SEARCH completed
```

With [X-GM-EXT-1](./gmail.md) loaded too, the messages of a THREADID share one `X-GM-THRID`.

## NOTIFY

Adds `NOTIFY SET [STATUS] (filter (events)) ...` and `NOTIFY NONE` (RFC 5465).

| Supported | Values                                                                                                                                                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Filters   | `selected`, `selected-delayed`, `inboxes` (same as `personal`), `personal`, `subscribed`, `subtree`, `mailboxes`                                                                                                                                   |
| Events    | `MessageNew` (with fetch attributes for the selected mailbox), `MessageExpunge`, `FlagChange`, `MailboxName` (`LIST` with `OLDNAME` for RENAME), `SubscriptionChange`, and with METADATA loaded `MailboxMetadataChange` and `ServerMetadataChange` |

How events are delivered:

- Events are sent as soon as they happen, also between commands. While a command runs they wait for its tagged response, EXPUNGE (or VANISHED) waits longer with `selected-delayed` and during FETCH, STORE and SEARCH. For a new message in the selected mailbox an IMAP4rev1 session gets EXISTS, the requested FETCH and then RECENT (RFC 5465 section 5.2 allows the RECENT response).
- After the first NOTIFY a session only hears about the events it asked for, also for the selected mailbox. Changes made by the session itself are not reported.
- Other mailboxes are reported with STATUS: MESSAGES and UIDNEXT, UNSEEN when the `\Seen` count changed, and HIGHESTMODSEQ when CONDSTORE is enabled. With ACL, only mailboxes with the `l` and `r` rights are reported, and granting or revoking `l` counts as MailboxName.
- Fetch attributes of MessageNew never set `\Seen`.
- `server.notifyOverflow([connection])` sends `* OK [NOTIFICATIONOVERFLOW]` and turns NOTIFY off, for testing how a client recovers. Without an argument it applies to every session with NOTIFY.

Session A has INBOX selected. Session B creates a mailbox, then selects INBOX and expunges message 4 (its SELECT and STORE are left out):

```text
A C: A3 NOTIFY SET (selected (MessageNew (UID FLAGS) MessageExpunge)) (personal (MessageNew MessageExpunge MailboxName))
A S: A3 OK NOTIFY completed
B C: B2 CREATE Receipts
B S: B2 OK CREATE completed
A S: * LIST (\HasNoChildren) "/" Receipts
B C: B5 EXPUNGE
B S: * 4 EXPUNGE
B S: B5 OK EXPUNGE Completed
A S: * 4 EXPUNGE
A S: * 3 EXISTS
```

Strict checks (RFC 5465 sections 3.1, 5 and 6.1):

```text
C: A4 NOTIFY SET (selected (MessageNew MessageExpunge MailboxName))
S: A4 BAD MailboxName can not be used with SELECTED or SELECTED-DELAYED
C: A5 NOTIFY SET (personal (FlagChange))
S: A5 BAD FlagChange and AnnotationChange require MessageNew and MessageExpunge
C: A6 NOTIFY SET (inboxes (MessageNew MessageExpunge AnnotationChange))
S: A6 NO [BADEVENT (MessageNew MessageExpunge FlagChange MailboxName SubscriptionChange)] Unsupported NOTIFY events
```

Also `BAD`: MessageNew without MessageExpunge or the other way round, two `selected` filters, fetch attributes outside the selected filters, empty event or mailbox lists, and `NOTIFY SET` without event groups. Unknown events, including AnnotationChange (there is no ANNOTATE support), get `NO [BADEVENT (...)]` listing the supported events. The fetch attributes of the CONTEXT=SEARCH `UPDATE` option (RFC 5465 section 7) are not supported.

## UIDONLY

Loads ENABLE. After `ENABLE UIDONLY`, the session must use UIDs everywhere (RFC 9586):

- `FETCH`, `STORE`, `SEARCH`, `COPY`, `MOVE`, `SORT`, `THREAD` and `REPLACE` are refused with `BAD [UIDREQUIRED]`, use their UID variants. A synchronizing literal of such a command is refused before it is sent.
- Message numbers in the criteria of UID SEARCH, UID SORT, UID THREAD and the ESEARCH command of MULTISEARCH, and the QRESYNC message sequence match data, are refused the same way.
- FETCH responses become `* <uid> UIDFETCH (...)`. The `UID` item is only included when UID FETCH asks for it.
- Expunges are reported with `VANISHED`, and SELECT does not send `[UNSEEN n]`. EXISTS and RECENT do not change.

Load [UIDPLUS](./messages.md#uidplus) as well for `UID EXPUNGE` and `COPYUID`.

```text
C: A2 ENABLE UIDONLY
S: * ENABLED UIDONLY
S: A2 OK ENABLE completed
C: A3 SELECT INBOX
S: * FLAGS (\Answered \Flagged \Draft \Deleted \Seen)
S: * OK [PERMANENTFLAGS (\Answered \Flagged \Draft \Deleted \Seen \*)] Flags permitted
S: * 4 EXISTS
S: * 0 RECENT
S: * OK [UIDVALIDITY 1] UIDs valid
S: * OK [UIDNEXT 5] Predicted next UID
S: A3 OK [READ-WRITE] Completed
C: A4 FETCH 1 (FLAGS)
S: A4 BAD [UIDREQUIRED] FETCH is not allowed once UIDONLY is enabled, use UID FETCH
C: A5 UID FETCH 1:2 (FLAGS)
S: * 1 UIDFETCH (FLAGS (\Seen))
S: * 2 UIDFETCH (FLAGS ())
S: A5 OK UID FETCH Completed
C: A6 UID SEARCH 1:2
S: A6 BAD [UIDREQUIRED] Message numbers are not allowed in the search criteria once UIDONLY is enabled, use UID <sequence set>
C: A7 UID STORE 2 +FLAGS (\Deleted)
S: * 2 UIDFETCH (FLAGS (\Deleted))
S: A7 OK UID STORE completed
C: A8 UID EXPUNGE 2
S: * VANISHED 2
S: A8 OK UID EXPUNGE completed
```
