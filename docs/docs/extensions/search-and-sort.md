---
title: Search and Sort
sidebar_position: 3
description: ESEARCH, SEARCHRES, SORT, SORT=DISPLAY, ESORT, THREAD, CONTEXT=SEARCH, CONTEXT=SORT, PARTIAL and MULTISEARCH in ImapKit, with the supported charsets and the strict checks.
---

# Search and sort

The core server implements `SEARCH` and `UID SEARCH` with every RFC 3501 search key. The plugins on this page add result options, saved results, sorting, threading, live updates, paging and searching across mailboxes.

| Plugin                  | Capability              | RFC                                                |
| ----------------------- | ----------------------- | -------------------------------------------------- |
| `ESEARCH`               | `ESEARCH`               | [RFC 4731](https://www.rfc-editor.org/rfc/rfc4731) |
| `SEARCHRES`             | `SEARCHRES`             | [RFC 5182](https://www.rfc-editor.org/rfc/rfc5182) |
| `SORT`                  | `SORT`                  | [RFC 5256](https://www.rfc-editor.org/rfc/rfc5256) |
| `SORT=DISPLAY`          | `SORT=DISPLAY`          | [RFC 5957](https://www.rfc-editor.org/rfc/rfc5957) |
| `ESORT`                 | `ESORT`                 | [RFC 5267](https://www.rfc-editor.org/rfc/rfc5267) |
| `THREAD=ORDEREDSUBJECT` | `THREAD=ORDEREDSUBJECT` | [RFC 5256](https://www.rfc-editor.org/rfc/rfc5256) |
| `THREAD=REFERENCES`     | `THREAD=REFERENCES`     | [RFC 5256](https://www.rfc-editor.org/rfc/rfc5256) |
| `CONTEXT=SEARCH`        | `CONTEXT=SEARCH`        | [RFC 5267](https://www.rfc-editor.org/rfc/rfc5267) |
| `CONTEXT=SORT`          | `CONTEXT=SORT`          | [RFC 5267](https://www.rfc-editor.org/rfc/rfc5267) |
| `PARTIAL`               | `PARTIAL`               | [RFC 9394](https://www.rfc-editor.org/rfc/rfc9394) |
| `MULTISEARCH`           | `MULTISEARCH`           | [RFC 7377](https://www.rfc-editor.org/rfc/rfc7377) |

The transcripts on this page use an INBOX with four messages: two "Lunch" messages from Alice and Bob, and two "Report" messages from Carol and Alice, where message 1 is `\Seen` and message 3 is `\Flagged`.

## Charsets

SEARCH, SORT and THREAD support the `US-ASCII` and `UTF-8` charsets. Any other charset is answered with `NO [BADCHARSET (US-ASCII UTF-8)]`. Search strings with 8-bit characters need `CHARSET UTF-8` (and a literal, since IMAP4rev1 does not allow 8-bit characters in quoted strings):

```text
C: A3 SEARCH CHARSET UTF-8 SUBJECT {6}
S: + Go ahead
C: Lünch
S: * SEARCH
S: A3 OK SEARCH completed
C: A4 SEARCH SUBJECT {6}
S: + Go ahead
C: Lünch
S: A4 BAD SUBJECT argument has 8-bit characters, use CHARSET UTF-8
C: A5 SEARCH CHARSET KOI8-R SUBJECT x
S: A5 NO [BADCHARSET (US-ASCII UTF-8)] Unsupported charset KOI8-R
```

Strings are matched with ASCII case folding. After `ENABLE UTF8=ACCEPT` or `ENABLE IMAP4rev2` the search charset changes, see [UTF8=ACCEPT](./messages.md#utf8accept) and [IMAP4rev2](./imap4rev2.md).

## ESEARCH

`SEARCH` and `UID SEARCH` take the result options `MIN`, `MAX`, `ALL` and `COUNT` and answer with one `ESEARCH` response instead of `SEARCH`. With CONDSTORE loaded, a search with the `MODSEQ` key adds the highest mod-sequence of the returned messages.

```text
C: A3 SEARCH RETURN (MIN MAX COUNT) UNSEEN
S: * ESEARCH (TAG "A3") MIN 2 MAX 4 COUNT 3
S: A3 OK SEARCH completed
C: A4 UID SEARCH RETURN (ALL) FROM alice
S: * ESEARCH (TAG "A4") UID ALL 1,4
S: A4 OK UID SEARCH completed
C: A5 SEARCH RETURN (FOO) ALL
S: A5 BAD Unknown SEARCH result option FOO
C: A6 SEARCH CHARSET UTF-8 RETURN (ALL) ALL
S: A6 BAD Invalid search key RETURN
```

Unknown result options are `BAD` (RFC 4466 section 2.6.1), and so is `RETURN` after `CHARSET`, because the grammar puts the result options first.

## SEARCHRES

Loads ESEARCH. `SEARCH RETURN (SAVE)` stores the result in the session's search result variable, and `$` refers to it in FETCH, STORE, COPY, MOVE, UID EXPUNGE, SEARCH and their UID variants. With ESORT, `SAVE` works for SORT too, and with MULTISEARCH for the ESEARCH command when the selected mailbox is the only one searched.

```text
C: A3 SEARCH RETURN (SAVE) FROM alice
S: A3 OK SEARCH completed
C: A4 FETCH $ (FLAGS)
S: * 1 FETCH (FLAGS (\Seen))
S: * 4 FETCH (FLAGS ())
S: A4 OK FETCH Completed
C: A5 FETCH 1,$ (FLAGS)
S: A5 BAD Invalid sequence set
```

- `$` must be used alone. `1,$` and other combinations with numbers are `BAD`.
- `SAVE` alone sends no ESEARCH response. With `MIN` or `MAX`, only those messages are saved (RFC 5182 section 2.4).
- An `OK` stores the result, a `NO` empties the variable and a `BAD` leaves it as it was (RFC 5182 section 2.1). SELECT, EXAMINE, CLOSE, UNSELECT and UNAUTHENTICATE empty it.
- Expunged messages drop out of the saved result. As `$` holds no message numbers, commands that use it can be pipelined.

## SORT

`SORT` and `UID SORT` with all RFC 5256 sort keys: `ARRIVAL`, `CC`, `DATE`, `FROM`, `SIZE`, `SUBJECT` and `TO`, each optionally preceded by `REVERSE`. Strings are compared with the `i;unicode-casemap` collation (RFC 5051), base subjects follow RFC 5256 section 2.1 and sent dates section 2.2. Ties are broken by mailbox order. With CONDSTORE, a `MODSEQ` search key appends the highest mod-sequence to the SORT response (RFC 7162 section 3.1.9).

```text
C: A3 SORT (REVERSE DATE) UTF-8 ALL
S: * SORT 4 3 2 1
S: A3 OK SORT completed
C: A4 UID SORT (FROM SUBJECT) US-ASCII ALL
S: * SORT 1 4 2 3
S: A4 OK UID SORT completed
C: A5 SORT (REVERSE REVERSE DATE) UTF-8 ALL
S: A5 BAD Invalid sort criterion REVERSE
C: A6 SORT (DATE) ISO-8859-1 ALL
S: A6 NO [BADCHARSET (US-ASCII UTF-8)] Unsupported charset ISO-8859-1
C: A7 SORT () UTF-8 ALL
S: A7 BAD SORT expects a list of sort criteria
```

Following RFC 5256 section 5, SORT and THREAD refuse with `BAD` a charset that is not an atom or a quoted string (a literal), an empty sort criteria list, and `REVERSE` that is not followed by a sort key. `I18NLEVEL=1` is not advertised, as SEARCH matches strings with ASCII case folding only.

For a Date header with an invalid or missing time, the sent date is 00:00:00 of that date. A message without a usable Date header sorts by its internal date (RFC 5256 section 2.2).

## SORT=DISPLAY

Loads SORT and adds the `DISPLAYFROM` and `DISPLAYTO` sort keys (RFC 5957), which sort by the display name of the first From or To address, or by the address when there is no display name.

```text
C: A3 SORT (DISPLAYFROM) UTF-8 ALL
S: * SORT 1 4 2 3
S: A3 OK SORT completed
```

## ESORT

Loads SORT and ESEARCH. `SORT RETURN (...)` and `UID SORT RETURN (...)` take the `MIN`, `MAX`, `ALL` and `COUNT` result options and answer with an ESEARCH response. `MIN` is the first and `MAX` the last message in sort order, and `ALL` lists the messages in sort order.

```text
C: A3 SORT RETURN (MIN MAX ALL COUNT) (REVERSE ARRIVAL) UTF-8 ALL
S: * ESEARCH (TAG "A3") MIN 4 MAX 1 ALL 4,3,2,1 COUNT 4
S: A3 OK SORT completed
```

The `CONTEXT`, `UPDATE` and `PARTIAL` result options are `BAD` for SORT unless CONTEXT=SORT is loaded. `PARTIAL` also works for SORT when the PARTIAL plugin is loaded.

## THREAD

`THREAD` and `UID THREAD` with the `ORDEREDSUBJECT` and `REFERENCES` algorithms of RFC 5256 section 3. Each algorithm is its own plugin and capability, load both to support both. REFERENCES is the full algorithm, threading by the Message-ID, In-Reply-To and References headers.

```javascript
const server = imapkit({ plugins: ['THREAD=ORDEREDSUBJECT', 'THREAD=REFERENCES'] });
```

```text
C: A2 CAPABILITY
S: * CAPABILITY IMAP4rev1 THREAD=ORDEREDSUBJECT THREAD=REFERENCES
S: A2 OK Completed
C: A4 THREAD REFERENCES UTF-8 ALL
S: * THREAD (1 2)(3 4)
S: A4 OK THREAD completed
C: A5 UID THREAD ORDEREDSUBJECT UTF-8 ALL
S: * THREAD (1 2)(3 4)
S: A5 OK UID THREAD completed
C: A6 THREAD "REFERENCES" UTF-8 ALL
S: A6 BAD THREAD expects a threading algorithm atom
```

The threading algorithm must be an atom, as in the RFC 5256 grammar. The same charset checks as for SORT apply.

## CONTEXT=SEARCH and CONTEXT=SORT

`CONTEXT=SEARCH` loads ESEARCH and adds the `UPDATE`, `CONTEXT` and `PARTIAL` result options to SEARCH and UID SEARCH, and the `CANCELUPDATE` command. `CONTEXT=SORT` loads ESORT and CONTEXT=SEARCH and adds the same options to SORT and UID SORT.

With `UPDATE`, the session receives `ADDTO` and `REMOVEFROM` ESEARCH updates as messages start or stop matching, whether this session or another one changed them. REMOVEFROM comes before the EXPUNGE response, ADDTO after EXISTS and FETCH. For SORT, the updates carry context positions in sort order.

In this transcript, sessions A and B both have INBOX selected. `A C:` lines are sent by session A, `A S:` lines are what it receives:

```text
A C: A3 SEARCH RETURN (UPDATE COUNT) UNSEEN
A S: * ESEARCH (TAG "A3") COUNT 3
A S: A3 OK SEARCH completed
B C: B3 STORE 2 +FLAGS (\Seen)
B S: * 2 FETCH (FLAGS (\Seen))
B S: B3 OK STORE completed
A C: A4 NOOP
A S: * 2 FETCH (UID 2 FLAGS (\Seen))
A S: * ESEARCH (TAG "A3") REMOVEFROM (0 2)
A S: A4 OK Completed
A C: A5 CANCELUPDATE "A3"
A S: A5 OK Updates cancelled
```

- Updates end with `CANCELUPDATE "tag"` or when the mailbox is closed (SELECT, EXAMINE, CLOSE, UNSELECT). `CANCELUPDATE` takes one or more quoted tags, a tag that is not an updating search gets `NO Unknown tag`.
- The server option `maxSearchContexts` (default 10) limits the updating searches of a session. Above it, the search still runs and its other result options are honored, but an untagged `NO [NOUPDATE "tag"]` tells the client that it gets no updates (RFC 5267 section 4.3.1).
- Reusing the tag of an active updating search is `BAD`.
- `CONTEXT` is accepted as a hint and ignored.
- `PARTIAL` takes a positive range like `1:100`. The negative ranges of RFC 9394 need the PARTIAL plugin.
- Message numbers in the search program are taken as they were when the search ran (RFC 5267 section 4.3).

## PARTIAL

Loads ESEARCH. Adds the `PARTIAL` result option of SEARCH (and of SORT with ESORT) and the `PARTIAL` modifier of FETCH and UID FETCH. A range counts results from 1, and a negative range like `-1:-100` counts from the last result. The FETCH modifier picks a window of the messages the sequence set matched and combines with `CHANGEDSINCE` of CONDSTORE.

```text
C: A3 SEARCH RETURN (PARTIAL 1:2) ALL
S: * ESEARCH (TAG "A3") PARTIAL (1:2 1:2)
S: A3 OK SEARCH completed
C: A4 UID SEARCH RETURN (PARTIAL -1:-2 COUNT) ALL
S: * ESEARCH (TAG "A4") UID PARTIAL (-1:-2 3:4) COUNT 4
S: A4 OK UID SEARCH completed
C: A5 UID FETCH 1:* (FLAGS) (PARTIAL -1:-2)
S: * 3 FETCH (FLAGS (\Flagged) UID 3)
S: * 4 FETCH (FLAGS () UID 4)
S: A5 OK UID FETCH Completed
C: A6 SEARCH RETURN (PARTIAL 1:2 PARTIAL 3:4) ALL
S: A6 BAD SEARCH result option PARTIAL can be used only once
```

A command takes only one `PARTIAL` or `ALL` result option, and `PARTIAL` together with `ALL` is `BAD` (RFC 9394 section 3.1). A range must use the same sign on both ends and may not contain `*` or `0`.

## MULTISEARCH

Loads ESEARCH. Adds the `ESEARCH` command, which searches several mailboxes, also in the authenticated state:

```text
ESEARCH IN (mailboxes "a" subtree "b" subtree-one "c" personal subscribed inboxes selected) RETURN (...) criteria
```

It sends one ESEARCH response with UIDs and the `TAG`, `MAILBOX` and `UIDVALIDITY` correlators for every mailbox with matches.

```text
C: A2 ESEARCH IN (personal) RETURN (COUNT) ALL
S: * ESEARCH (TAG "A2" MAILBOX INBOX UIDVALIDITY 1) UID COUNT 4
S: A2 OK ESEARCH completed
C: A3 ESEARCH IN (mailboxes INBOX) FROM alice
S: * ESEARCH (TAG "A3" MAILBOX INBOX UIDVALIDITY 1) UID ALL 1,4
S: A3 OK ESEARCH completed
```

- Mailboxes that do not exist or are `\Noselect` are skipped. With [ACL](./access-control.md), so are mailboxes without the `r` right, and without `l` unless they are named under `mailboxes` or as a subtree root.
- A mailbox named twice is searched once. `inboxes` is INBOX.
- `SAVE` (SEARCHRES) is only allowed when the selected mailbox is the only one searched. `UPDATE` (CONTEXT=SEARCH) only applies to the selected mailbox.
- `selected-delayed` and scope options are `BAD`, RFC 7377 defines no scope options.
- With [UIDONLY](./synchronization.md#uidonly), message numbers in the criteria are refused like in UID SEARCH.
