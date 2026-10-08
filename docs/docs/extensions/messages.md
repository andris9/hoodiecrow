---
title: Messages
sidebar_position: 8
description: ImapKit plugins for adding, moving and reading messages, namely MOVE, UIDPLUS, MULTIAPPEND, CATENATE, REPLACE, APPENDLIMIT, BINARY, PREVIEW, SAVEDATE, MESSAGELIMIT, SAVELIMIT, UTF8=ACCEPT, LITERAL+ and LITERAL-.
---

# Messages

| Plugin                 | Capability                       | RFC                                                                                                    |
| ---------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `MOVE`                 | `MOVE`                           | [RFC 6851](https://www.rfc-editor.org/rfc/rfc6851)                                                     |
| `UIDPLUS`              | `UIDPLUS`                        | [RFC 4315](https://www.rfc-editor.org/rfc/rfc4315)                                                     |
| `MULTIAPPEND`          | `MULTIAPPEND`                    | [RFC 3502](https://www.rfc-editor.org/rfc/rfc3502)                                                     |
| `CATENATE`             | `CATENATE`, `URL-PARTIAL`        | [RFC 4469](https://www.rfc-editor.org/rfc/rfc4469), [RFC 5550](https://www.rfc-editor.org/rfc/rfc5550) |
| `REPLACE`              | `REPLACE`                        | [RFC 8508](https://www.rfc-editor.org/rfc/rfc8508)                                                     |
| `APPENDLIMIT`          | `APPENDLIMIT`, `APPENDLIMIT=<n>` | [RFC 7889](https://www.rfc-editor.org/rfc/rfc7889)                                                     |
| `BINARY`               | `BINARY`                         | [RFC 3516](https://www.rfc-editor.org/rfc/rfc3516)                                                     |
| `PREVIEW`              | `PREVIEW`                        | [RFC 8970](https://www.rfc-editor.org/rfc/rfc8970)                                                     |
| `SAVEDATE`             | `SAVEDATE`                       | [RFC 8514](https://www.rfc-editor.org/rfc/rfc8514)                                                     |
| `MESSAGELIMIT`         | `MESSAGELIMIT=<n>`               | [RFC 9738](https://www.rfc-editor.org/rfc/rfc9738)                                                     |
| `SAVELIMIT`            | `SAVELIMIT=<n>`                  | [RFC 9738](https://www.rfc-editor.org/rfc/rfc9738)                                                     |
| `UTF8=ACCEPT`          | `UTF8=ACCEPT`                    | [RFC 9755](https://www.rfc-editor.org/rfc/rfc9755)                                                     |
| `LITERAL+`, `LITERAL-` | `LITERAL+`, `LITERAL-`           | [RFC 7888](https://www.rfc-editor.org/rfc/rfc7888)                                                     |

The transcripts use an INBOX with four messages and empty `Archive`, `Sent` and `Trash` mailboxes. The untagged SELECT responses are shortened to `...` where they do not matter.

## MOVE

Adds `MOVE` and `UID MOVE`. The messages are copied to the target and expunged from the selected mailbox. With UIDPLUS, the `COPYUID` code comes in an untagged OK before the EXPUNGE responses (RFC 6851 section 4.3).

```text
C: A3 MOVE 1:2 Archive
S: * OK [COPYUID 1 1,2 1,2] Copied
S: * 1 EXPUNGE
S: * 1 EXPUNGE
S: A3 OK Done
C: A5 MOVE 1 Nope
S: A5 NO [TRYCREATE] Target mailbox does not exist
```

MOVE in a mailbox opened with EXAMINE gets `NO [CLIENTBUG]`, as it would expunge from a read-only mailbox. Without the plugin, `MOVE` is an unknown command, which is how you test the COPY, STORE and EXPUNGE fallback of a client (the `no-move` [quirk preset](../faults/quirk-presets.md) removes MOVE even if listed).

## UIDPLUS

Adds the `APPENDUID` and `COPYUID` response codes and the `UID EXPUNGE` command, which only expunges the messages of the UID set that have the `\Deleted` flag. `UIDNOTSTICKY` is not implemented, UIDs are always sticky.

```text
C: A4 UID COPY 3 Archive
S: A4 OK [COPYUID 1 3 1] UID COPY Completed
C: A5 APPEND Archive (\Seen) {20}
S: + Go ahead
C: Subject: hi
C:
C: hello
S: A5 OK [APPENDUID 1 2] APPEND Completed
```

- With MULTIAPPEND, APPENDUID lists the UIDs of all appended messages as a UID set.
- With REPLACE, APPENDUID is sent in an untagged OK before the EXPUNGE.
- A COPY that copied nothing gets no COPYUID.
- UID EXPUNGE in a read-only mailbox gets `NO [CLIENTBUG]`.

## MULTIAPPEND

APPEND takes several messages, each with its own optional flags and date, and appends all or none of them. A zero-length message literal cancels the whole APPEND with `NO` (RFC 3502 section 6.3.11).

```text
C: A2 APPEND Archive {20}
S: + Go ahead
C: Subject: hi
C:
C: hello (\Seen) {20}
S: + Go ahead
C: Subject: hi
C:
C: hello
S: A2 OK [APPENDUID 1 1:2] APPEND Completed
C: A3 APPEND Archive {20}
S: + Go ahead
C: Subject: hi
C:
C: hello {0}
S: + Go ahead
C:
S: A3 NO Zero-length message literal, APPEND cancelled
```

Without the plugin, a second message in APPEND is `BAD`:

```text
S: A2 BAD Only a single message can be appended
```

## CATENATE

APPEND (and REPLACE) can build a message from `TEXT` literals and `URL` parts that point to messages or message parts on the server (RFC 4469). `URL-PARTIAL` (RFC 5550) is advertised too, so URLs can take `;PARTIAL=offset.length`.

Only absolute-path URLs are accepted, for example `/INBOX;UIDVALIDITY=1/;UID=2/;SECTION=1.MIME/;PARTIAL=0.100`. Relative-path URLs like `;UID=1` (RFC 5092 section 7.2), other URLs and URLs that do not resolve fail with `NO [BADURL ...]`. A message over the literal size limit (the `maxLiteralSize` option) fails with `NO [TOOBIG]`. A literal8 `TEXT` part is refused.

```text
C: A2 APPEND Archive CATENATE (URL "/INBOX;UIDVALIDITY=1/;UID=1/;SECTION=HEADER" TEXT {7}
S: + Go ahead
C: Hello
C: )
S: A2 OK [APPENDUID 1 1] APPEND Completed
C: A3 APPEND Archive CATENATE (URL ";UID=1")
S: A3 NO [BADURL ;UID=1] Relative-path URLs are not allowed (RFC 5092 section 7.2)
C: A4 APPEND Archive CATENATE (URL "/INBOX/;UID=99")
S: A4 NO [BADURL /INBOX/;UID=99] Message does not exist
C: A5 APPEND Archive CATENATE (URL "/INBOX/;UID=1/;PARTIAL=0.20")
S: A5 OK [APPENDUID 1 2] APPEND Completed
```

With ACL loaded, URLs of mailboxes the user can not read are refused with `NO [BADURL]`.

## REPLACE

Adds `REPLACE` and `UID REPLACE`: append a new version of a message and expunge the old one in one step (RFC 8508). The target can be the selected mailbox or another one.

- Only the replaced message is expunged, not every `\Deleted` message. If the new message can not be appended, nothing changes.
- With UIDPLUS, `APPENDUID` comes in an untagged OK before the EXPUNGE. When the target is the selected mailbox, EXISTS comes before EXPUNGE, like the RFC 8508 section 3.2 example.
- REPLACE takes a single message even with MULTIAPPEND. It works with CATENATE and, with BINARY, with a literal8 message.
- A message number past the end is `BAD`, a UID that does not exist is `NO`, and REPLACE in a read-only mailbox is `NO`. When the message to replace is known to be invalid, the literal is refused before the client sends it.
- With QUOTA only the net usage counts.

```text
C: A3 UID REPLACE 2 INBOX {20}
S: + Go ahead
C: Subject: hi
C:
C: hello
S: * OK [APPENDUID 1 5] Replacement message saved
S: * 5 EXISTS
S: * 2 EXPUNGE
S: A3 OK UID REPLACE completed
C: A4 REPLACE 9 INBOX {20}
S: A4 BAD Invalid message sequence number
```

## APPENDLIMIT

Announces the largest message APPEND accepts (RFC 7889).

- The server option `appendLimit` (octets) sets the limit for every mailbox, advertised as `APPENDLIMIT=<n>`. Without the option there is no server wide limit.
- A mailbox in the storage can set its own `appendLimit`, a number, or `null` for no limit. Then the capability is a plain `APPENDLIMIT` and clients read the limits with `STATUS (APPENDLIMIT)`, which also works with LIST-STATUS.
- A larger message in APPEND or REPLACE fails with `NO [TOOBIG]`. A synchronizing literal that is too large is refused before the client sends it. An `appendLimit` of `0` refuses every message.
- COPY and MOVE are not limited, they are not uploads (RFC 7889 section 1).

```javascript
const server = imapkit({ plugins: ['APPENDLIMIT'], appendLimit: 10 });
```

```text
C: A2 CAPABILITY
S: * CAPABILITY IMAP4rev1 APPENDLIMIT=10
S: A2 OK Completed
C: A3 APPEND INBOX {20}
S: A3 NO [TOOBIG] Message exceeds the APPENDLIMIT of the mailbox
C: A4 STATUS INBOX (APPENDLIMIT)
S: * STATUS INBOX (APPENDLIMIT 10)
S: A4 OK Status completed
```

With `appendLimit: 10` and `"appendLimit": null` on the Archive mailbox:

```text
C: A2 CAPABILITY
S: * CAPABILITY IMAP4rev1 APPENDLIMIT
S: A2 OK Completed
C: A3 STATUS Archive (APPENDLIMIT)
S: * STATUS Archive (APPENDLIMIT NIL)
S: A3 OK Status completed
C: A4 STATUS INBOX (APPENDLIMIT)
S: * STATUS INBOX (APPENDLIMIT 10)
S: A4 OK Status completed
```

## BINARY

Adds the `BINARY[<part>]<<partial>>`, `BINARY.PEEK[<part>]<<partial>>` and `BINARY.SIZE[<part>]` FETCH items, which remove the base64 and quoted-printable transfer encodings. Other encodings fail with `NO [UNKNOWN-CTE]`. Decoded data is sent as a literal8 (`~{n}`) only when it contains NUL, otherwise as a normal string (RFC 3516 section 4.3).

APPEND, MULTIAPPEND and REPLACE accept literal8 messages (`~{n}`, and `~{n+}` with LITERAL+ or LITERAL-). Binary parts of an appended message, and parts with NUL octets, are stored base64 encoded, so `BODY[]` stays valid IMAP4rev1.

```text
C: A3 FETCH 5 (BINARY.SIZE[1] BINARY.PEEK[1])
S: * 5 FETCH (BINARY.SIZE[1] 13 BINARY[1] {13}
S: Café au lait)
S: A3 OK FETCH Completed
C: A5 FETCH 5 (BINARY[])
S: A5 BAD BINARY[] is not allowed, BINARY applies to leaf body parts only (RFC 9051 section 6.4.5)
C: A6 FETCH 5 (BINARY.PEEK[1.MIME])
S: A6 BAD Invalid BINARY.PEEK section, expecting a part number (RFC 3516 section 7)
```

Here message 5 is a multipart message whose first part is quoted-printable `Caf=C3=A9 au lait`.

A message appended as a literal8 with a binary part, read back with BODY and BINARY:

```text
C: A2 APPEND Archive ~{96}
S: + Go ahead
C: ...message with a part that holds the octets 00 01 02...
S: A2 OK [APPENDUID 1 1] APPEND Completed
C: A4 FETCH 1 (BODY.PEEK[TEXT] BINARY.PEEK[1])
S: * 1 FETCH (BODY[TEXT] {8}
S: AAECDQo= BINARY[1] ~{5}
S: <00 01 02 CR LF>)
S: A4 OK FETCH Completed
```

The same message in a normal `{96}` literal is `BAD`, as NUL octets are not allowed there.

Refused with `BAD`: `BINARY[]`, BINARY of multipart or message/rfc822 parts (RFC 9051 section 6.4.5 allows leaf body parts only), `HEADER`, `TEXT` or `MIME` sections, and a partial range on `BINARY.SIZE`. A literal8 is refused without a continuation request anywhere but in an APPEND or REPLACE message (and a SETMETADATA value with METADATA).

## PREVIEW

Adds the `PREVIEW` FETCH item with the `LAZY` modifier (RFC 8970).

- Previews are generated from the first text/plain or text/html part. text/plain is preferred in multipart/alternative, and attachments, attached messages and encrypted content are skipped.
- Transfer encoding and charset are decoded, HTML markup and quoted text are removed, whitespace is collapsed, and the result is cut to 200 characters.
- A message in the storage can set its own `"preview"` string.
- `PREVIEW (LAZY)` returns NIL until the preview of the message has been generated by a FETCH without LAZY, or comes from the storage.
- PREVIEW does not set `\Seen`.

```text
C: A3 FETCH 1 (PREVIEW (LAZY))
S: * 1 FETCH (PREVIEW NIL)
S: A3 OK FETCH Completed
C: A4 FETCH 1:2 (PREVIEW)
S: * 1 FETCH (PREVIEW "Shall we have lunch?")
S: * 2 FETCH (PREVIEW "Yes, at noon.")
S: A4 OK FETCH Completed
C: A5 FETCH 1 (PREVIEW (LAZY))
S: * 1 FETCH (PREVIEW "Shall we have lunch?")
S: A5 OK FETCH Completed
C: A7 FETCH 1 (PREVIEW ())
S: A7 BAD PREVIEW modifier list can not be empty
```

Unknown modifiers are `BAD` too.

## SAVEDATE

Adds the `SAVEDATE` FETCH item and the `SAVEDBEFORE`, `SAVEDON`, `SAVEDSINCE` and `SAVEDATESUPPORTED` SEARCH keys (RFC 8514).

- APPEND, COPY and MOVE set the save date to the current time. It is never copied from the source message.
- Messages in the storage can set it with a `SAVEDATE` value (an IMAP date-time string like `"08-Oct-2026 11:00:00 +0300"`, or a Date). Others get the current server time when the storage is loaded, or the time of the `now` option when it is set (see [Repeatable tests](../faults/repeatable-tests.md)).
- A mailbox with `"SAVEDATE": false` in the storage does not support save dates: FETCH returns NIL, `SAVEDATESUPPORTED` matches nothing, and the other keys use the internal date.

```text
C: A3 FETCH 1:2 (SAVEDATE)
S: * 1 FETCH (SAVEDATE "01-Oct-2026 12:00:00 +0000")
S: * 2 FETCH (SAVEDATE "08-Oct-2026 11:00:00 +0300")
S: A3 OK FETCH Completed
C: A4 SEARCH SAVEDBEFORE 2-Oct-2026
S: * SEARCH 1
S: A4 OK SEARCH completed
C: A5 SEARCH SAVEDATESUPPORTED
S: * SEARCH 1 2 3 4
S: A5 OK SEARCH completed
C: A6 SELECT Trash
S: ...
S: A6 OK [READ-WRITE] Completed
C: A7 SEARCH SAVEDATESUPPORTED
S: * SEARCH
S: A7 OK SEARCH completed
```

## MESSAGELIMIT and SAVELIMIT

RFC 9738 lets a server limit how many messages one command works on. Both plugins read the limit from the `messageLimit` server option (default 1000). Any positive number is accepted, so a small test mailbox can hit it. The two plugins can not be loaded together.

**MESSAGELIMIT** is advertised as `MESSAGELIMIT=<n>`:

- FETCH, STORE, SEARCH, MOVE, UID EXPUNGE and their UID variants only work on the n messages with the highest UIDs (UID EXPUNGE counts the `\Deleted` ones), from the highest down. They add `[MESSAGELIMIT n uid]` with the lowest processed UID to the tagged OK, or send it in an untagged `NO` when the tagged OK already has a response code (like `HIGHESTMODSEQ` or `MODIFIED`).
- SEARCH counts the searched messages, which its top level sequence set and the `UID`, `UIDAFTER` and `UIDBEFORE` keys narrow down.
- COPY, APPEND (MULTIAPPEND), SORT and THREAD of more messages, and a FETCH `PARTIAL` range of more messages, fail with `NO [MESSAGELIMIT ...]`.
- EXPUNGE, CLOSE and STATUS are not limited.
- Adds the `UIDAFTER` and `UIDBEFORE` search keys, which take a single UID (anything else is `BAD`).

```text
C: A2 CAPABILITY
S: * CAPABILITY IMAP4rev1 MESSAGELIMIT=2
S: A2 OK Completed
C: A4 FETCH 1:* (FLAGS)
S: * 4 FETCH (FLAGS ())
S: * 3 FETCH (FLAGS (\Flagged))
S: A4 OK [MESSAGELIMIT 2 3] FETCH Completed
C: A5 COPY 1:* Archive
S: A5 NO [MESSAGELIMIT 2 3] Too many messages to copy, try a smaller subset
C: A6 UID SEARCH UIDAFTER 1
S: * SEARCH 4 3
S: A6 OK [MESSAGELIMIT 2 3] UID SEARCH completed
```

**SAVELIMIT** is advertised as `SAVELIMIT=<n>`. Only COPY and APPEND (MULTIAPPEND) of more messages fail with `NO [MESSAGELIMIT ...]`, other commands are not limited:

```text
C: A2 CAPABILITY
S: * CAPABILITY IMAP4rev1 SAVELIMIT=2 MOVE
S: A2 OK Completed
C: A5 COPY 1:* Archive
S: A5 NO [MESSAGELIMIT 2 3] Too many messages to copy, try a smaller subset
C: A6 MOVE 1:* Archive
S: * 1 EXPUNGE
S: * 1 EXPUNGE
S: * 1 EXPUNGE
S: * 1 EXPUNGE
S: A6 OK Done
```

## UTF8=ACCEPT

Loads ENABLE. A server that advertises UTF8=ACCEPT accepts UTF-8 in quoted strings from every session (RFC 9755 section 3). Before `ENABLE UTF8=ACCEPT`, mailbox names must still be modified UTF-7, SEARCH needs `CHARSET UTF-8` for 8-bit strings, and APPEND of a message with 8-bit header fields gets `NO` (RFC 9755 section 4). After it:

- Mailbox names are UTF-8 in both directions. The storage keeps modified UTF-7 names, and `&` is an ordinary character in UTF-8 names.
- Strings that are valid UTF-8 are sent quoted.
- SEARCH strings are UTF-8 without `CHARSET`, and `SEARCH CHARSET` is `BAD`. SORT and THREAD accept only UTF-8.
- A message with 8-bit header fields can be appended.

```text
C: A3 CREATE "Gr&APw-n"
S: A3 OK CREATE completed
C: A4 APPEND INBOX {22}
S: + Go ahead
C: Subject: Grüße
C:
C: hi
S: A4 NO Message header has 8-bit characters, ENABLE UTF8=ACCEPT first (RFC 9755 section 4)
C: A5 ENABLE UTF8=ACCEPT
S: * ENABLED UTF8=ACCEPT
S: A5 OK ENABLE completed
C: A6 LIST "" "Gr*"
S: * LIST (\HasNoChildren) "/" "Grün"
S: A6 OK Completed
C: A7 CREATE "Café"
S: A7 OK CREATE completed
C: A10 SEARCH CHARSET UTF-8 SUBJECT x
S: A10 BAD CHARSET is not allowed, search strings are always UTF-8 in this session
```

Refused with `BAD` after ENABLE: invalid UTF-8 in quoted strings, and mailbox names with control characters, U+2028, U+2029, a leading BOM, unassigned code points, or a name that is not in Unicode Normalization Form C. While the plugin is loaded, the same name rules apply before ENABLE to modified UTF-7 names, so `CREATE "a&AA0-"` (an encoded CR) is `BAD` too.

Not implemented: `UTF8=ONLY`, the obsolete `APPEND ... UTF8 (...)` data item of RFC 6855, and downgrading 8-bit headers for clients that did not enable UTF-8 (RFC 9755 section 8). The plugin shares its session state with [IMAP4rev2](./imap4rev2.md), so both work in any load order.

## LITERAL+ and LITERAL-

Without either plugin, every literal is synchronizing: the client sends `{n}`, waits for the `+` continuation and then the data. ImapKit answers literal data sent before the continuation with `BAD` (RFC 3501 section 4.3), and `{n+}` is a syntax error:

```text
C: A2 APPEND Archive {20+}
S: * BAD [SYNTAX] Unexpected char at position 21
S: A2 BAD Error parsing command
```

The rest of the message is then read as commands and gets more `BAD` responses, which is the client bug made visible.

- **LITERAL+** allows non-synchronizing literals `{n+}` of any size.
- **LITERAL-** allows them up to 4096 octets. A larger one is read and dropped, and the command is answered with `BAD [TOOBIG]` (RFC 7888 section 5).

```text
C: A3 APPEND Archive {20+}
C: Subject: hi
C:
C: hello
S: A3 OK APPEND Completed
```

```text
C: A3 APPEND Archive {5000+}
C: ...5000 octets...
S: A3 BAD [TOOBIG] Non-synchronizing literals are limited to 4096 octets
C: A4 NOOP
S: A4 OK Completed
```

The two plugins can not be loaded together (RFC 7888 section 5). IMAP4rev2 loads LITERAL- unless LITERAL+ is loaded, and LITERAL+ replaces that implied LITERAL-.
