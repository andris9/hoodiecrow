---
title: IMAP4rev2
sidebar_position: 2
description: The IMAP4rev2 plugin advertises RFC 9051 next to IMAP4rev1, loads the extensions IMAP4rev2 folds in, and switches a session to RFC 9051 rules after ENABLE IMAP4rev2.
---

# IMAP4rev2

|            |                                                                                                                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plugin     | `IMAP4rev2`                                                                                                                                                                                     |
| Capability | `IMAP4rev2`, advertised next to `IMAP4rev1`                                                                                                                                                     |
| RFC        | [RFC 9051](https://www.rfc-editor.org/rfc/rfc9051)                                                                                                                                              |
| Loads      | ENABLE, NAMESPACE, UNSELECT, UIDPLUS, ESEARCH, SEARCHRES, IDLE, SASL-IR, LIST-EXTENDED, LIST-STATUS, MOVE, BINARY, SPECIAL-USE, STATUS=SIZE, AUTH=PLAIN, and LITERAL- unless LITERAL+ is loaded |

ImapKit implements IMAP4rev2 the way RFC 9051 Appendix A describes for a server that supports both revisions: it advertises `IMAP4rev1` and `IMAP4rev2`, every session starts as IMAP4rev1, and a client that wants IMAP4rev2 sends `ENABLE IMAP4rev2`. One server can therefore test an IMAP4rev1 client and an IMAP4rev2 client side by side, and a client that supports both can be checked for picking the right one.

```javascript
const server = imapkit({ plugins: ['IMAP4rev2'] });
```

## Capabilities

The plugin loads every extension that RFC 9051 Appendix E item 2 folds into IMAP4rev2, and each of them advertises its own capability. AUTH=PLAIN is required by RFC 9051 section 6.1.1.

```text
C: A0 CAPABILITY
S: * CAPABILITY IMAP4rev1 ENABLE NAMESPACE UNSELECT UIDPLUS ESEARCH SEARCHRES IDLE SASL-IR LIST-EXTENDED LIST-STATUS MOVE BINARY SPECIAL-USE STATUS=SIZE AUTH=PLAIN IMAP4rev2 LITERAL-
S: A0 OK Completed
```

- LITERAL- (non-synchronizing literals up to 4096 octets, RFC 9051 section 4.3) is loaded only if neither LITERAL+ nor LITERAL- is loaded already. Load `LITERAL+` as well to allow non-synchronizing literals of any size, it replaces the implied LITERAL- in any load order. Listing `LITERAL-` and `LITERAL+` by name still throws.
- STARTTLS and LOGINDISABLED (RFC 9051 section 6.1.1) are not loaded, as they change how clients log in. Load them yourself when you need them.
- `ENABLE IMAP4rev2` does not change the CAPABILITY list.

## Sessions before ENABLE

A session that does not send `ENABLE IMAP4rev2` behaves like it would on an IMAP4rev1 server with the same extensions. It gets `RECENT`, `[UNSEEN n]` and plain `SEARCH` responses, can use `CHECK`, `LSUB` and the `RFC822` FETCH items, and 8-bit characters in quoted strings are refused (RFC 9051 Appendix A). Partial FETCH ranges and the LARGER and SMALLER search keys take 32-bit numbers (RFC 3501 section 9).

```text
C: A3 SELECT INBOX
S: * FLAGS (\Answered \Flagged \Draft \Deleted \Seen)
S: * OK [PERMANENTFLAGS (\Answered \Flagged \Draft \Deleted \Seen \*)] Flags permitted
S: * 4 EXISTS
S: * 0 RECENT
S: * OK [UNSEEN 2] First unseen message
S: * OK [UIDVALIDITY 1] UIDs valid
S: * OK [UIDNEXT 5] Predicted next UID
S: A3 OK [READ-WRITE] Completed
C: A4 SEARCH UNSEEN
S: * SEARCH 2 3 4
S: A4 OK SEARCH completed
```

## Sessions after ENABLE IMAP4rev2

`ENABLE IMAP4rev2` must come before the first SELECT or EXAMINE (RFC 5161 section 3.1), as for every ENABLE. After it, the session follows RFC 9051:

| Area                   | IMAP4rev2 behavior                                                                                                                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SELECT, EXAMINE        | No `RECENT` response (nor after the EXISTS of new messages) and no `[UNSEEN n]` code. An untagged `LIST` response for the selected mailbox, with its special-use attributes. `* OK [CLOSED]` when a mailbox was selected before (section 6.3.2) |
| `\Recent`              | Not sent in FLAGS of FETCH responses (section 2.3.2)                                                                                                                                                                                            |
| SEARCH                 | Answers with an `ESEARCH` response, `RETURN (ALL)` when no result option is given (section 6.4.4). UTF-8 is assumed without `CHARSET`, and `CHARSET` is still allowed                                                                           |
| STATUS                 | `DELETED` is allowed (section 6.3.11), `RECENT` is not                                                                                                                                                                                          |
| Strings, mailbox names | UTF-8 in quoted strings and mailbox names, which must be Net-Unicode in Normalization Form C (section 5.1)                                                                                                                                      |
| APPEND                 | A message with 8-bit header fields can be appended (section 6.3.12)                                                                                                                                                                             |
| message/global         | Described in BODYSTRUCTURE and numbered in sections like message/rfc822                                                                                                                                                                         |
| Numbers                | Partial FETCH ranges and LARGER/SMALLER take 63-bit numbers (number64)                                                                                                                                                                          |

Items that RFC 9051 removed (Appendix E) are refused with `BAD`: `CHECK` (use NOOP), `LSUB` (use `LIST (SUBSCRIBED)`), the `RFC822`, `RFC822.HEADER` and `RFC822.TEXT` FETCH items (use `BODY[]`, `BODY.PEEK[HEADER]`, `BODY[TEXT]`), the `NEW`, `OLD` and `RECENT` SEARCH keys and the `RECENT` STATUS item.

```text
C: A2 ENABLE IMAP4rev2
S: * ENABLED IMAP4rev2
S: A2 OK ENABLE completed
C: A3 SELECT INBOX
S: * FLAGS (\Answered \Flagged \Draft \Deleted \Seen)
S: * OK [PERMANENTFLAGS (\Answered \Flagged \Draft \Deleted \Seen \*)] Flags permitted
S: * 4 EXISTS
S: * OK [UIDVALIDITY 1] UIDs valid
S: * OK [UIDNEXT 5] Predicted next UID
S: * LIST (\HasNoChildren) "/" INBOX
S: A3 OK [READ-WRITE] Completed
C: A4 SEARCH UNSEEN
S: * ESEARCH (TAG "A4") ALL 2:4
S: A4 OK SEARCH completed
C: A6 CHECK
S: A6 BAD CHECK is not part of IMAP4rev2, use NOOP (RFC 9051 Appendix E)
C: A7 FETCH 1 (RFC822.HEADER)
S: A7 BAD RFC822, RFC822.HEADER and RFC822.TEXT are not part of IMAP4rev2, use BODY[] (RFC 9051 Appendix E)
C: A8 SEARCH RECENT
S: A8 BAD Invalid search key RECENT
C: A9 STATUS Archive (MESSAGES DELETED SIZE)
S: * STATUS Archive (MESSAGES 0 DELETED 0 SIZE 0)
S: A9 OK Status completed
C: A11 LSUB "" "*"
S: A11 BAD LSUB is not part of IMAP4rev2, use LIST (SUBSCRIBED) (RFC 9051 Appendix E)
C: A12 SELECT Sent
S: * OK [CLOSED] Previous mailbox closed
S: * FLAGS (\Answered \Flagged \Draft \Deleted \Seen)
S: * OK [PERMANENTFLAGS (\Answered \Flagged \Draft \Deleted \Seen \*)] Flags permitted
S: * 0 EXISTS
S: * OK [UIDVALIDITY 1] UIDs valid
S: * OK [UIDNEXT 1] Predicted next UID
S: * LIST (\HasNoChildren \Sent) "/" Sent
S: A12 OK [READ-WRITE] Completed
```

`ENABLE` matches capability names case-insensitively and lists them in the advertised spelling, so `ENABLE imap4rev2` is answered with `* ENABLED IMAP4rev2`. With the [UNAUTHENTICATE](./authentication-and-transport.md#unauthenticate) plugin, `UNAUTHENTICATE` turns IMAP4rev2 off again, as it does for every enabled extension (RFC 8437 section 4.1).

## Keywords

RFC 9051 section 2.3.2 asks servers to keep the `$Forwarded`, `$MDNSent`, `$Junk`, `$NotJunk` and `$Phishing` keywords. With the plugin loaded, a mailbox that does not allow new keywords (no `\*` in PERMANENTFLAGS) still lists these five in PERMANENTFLAGS and keeps them on its messages.

## Not implemented

- A server that advertises only IMAP4rev2.
- UTF-8 in response text.
- The `OLDNAME` extended data item of LIST responses (section 6.3.9.7). Only [NOTIFY](./synchronization.md#notify) sends it, for RENAME.

Other extensions that need IMAP4rev2 semantics, like [UTF8=ACCEPT](./messages.md#utf8accept), share the same session state, so the two plugins work together in any load order.
