---
title: Strict by Design
sidebar_position: 4
description: Why ImapKit refuses client input that breaks the IMAP RFCs, the full list of rules it enforces, and how to read a BAD in your test transcript.
---

# Strict by design

ImapKit is a guardrail for developing standards compliant IMAP clients. It follows the RFCs strictly instead of accepting whatever a client sends.

Most production servers are lenient. They guess what a sloppy command meant, accept literals before the continuation request, or ignore extra arguments. A client that works against them can still break against the next, stricter server, and the bug shows up in production. ImapKit answers such input with `BAD` (or `NO` where the RFC asks for it), so the bug shows up in your test suite instead.

## Reading a BAD

When your client gets `BAD` from ImapKit, the client broke the protocol grammar or a MUST of an RFC. The human readable text says what was wrong:

```text
C: A1 SELECT INBOX
S: A1 BAD SELECT is not allowed in the Not Authenticated state
C: A2 LOGIN testuser testpass
S: A2 OK User logged in
C: A3 NOOP now
S: A3 BAD NOOP does not take any arguments
C: A4 SELECT INBOX
S: * 1 EXISTS
S: A4 OK [READ-WRITE] Completed
C: A5 FETCH 2 FLAGS
S: A5 BAD Message sequence number 2 is greater than the number of messages (1)
C: A6 STORE 1 +FLAGS (\Recent)
S: A6 BAD Invalid system flag \Recent
C: A7 SEARCH SUBJECT "café"
S: * BAD [SYNTAX] Unexpected char at position 22
S: A7 BAD Error parsing command
C: A8 CREATE "Café"
S: * BAD [SYNTAX] Unexpected char at position 14
S: A8 BAD Error parsing command
C: A9 CREATE "Caf&AOk-"
S: A9 OK CREATE completed
```

Some untagged SELECT responses are left out above. `A7` needs `CHARSET UTF-8` for an 8-bit search string, and `A8` must encode the mailbox name in modified UTF-7, as `A9` does.

`NO` is different: it means the command was valid but could not be carried out (a missing mailbox, a wrong password, an expunged message). Many `NO` responses carry a response code that tells the client what to do next, see [Response codes](#response-codes).

Some RFC 2683 recommendations that a client SHOULD follow are flagged without failing the command: `STATUS` on the selected mailbox completes, but with `OK [CLIENTBUG]`.

```text
C: B1 STATUS INBOX (MESSAGES)
S: * STATUS INBOX (MESSAGES 1)
S: B1 OK [CLIENTBUG] Status completed, STATUS SHOULD NOT be used on the selected mailbox
C: B2 EXAMINE INBOX
S: * 1 EXISTS
S: B2 OK [READ-ONLY] Completed
C: B3 STORE 1 +FLAGS (\Seen)
S: B3 NO [CLIENTBUG] Mailbox is read-only
```

A simple rule for client tests: fail the test on any tagged `BAD`, and on any `CLIENTBUG` code.

## The rules

ImapKit answers these with `BAD`, or `NO` where noted. The list matches the README and is covered by `test/conformance.test.ts` and the tests of each plugin.

### Commands and arguments

| Rule                                                                                                                                                                       | Reference                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Commands sent in the wrong state, for example `FETCH` before `SELECT` or `LOGIN` after login                                                                               | [RFC 3501 section 3](https://www.rfc-editor.org/rfc/rfc3501#section-3)             |
| Arguments to commands that take none (`NOOP x`, `CLOSE x`), missing or extra arguments, and values that break the grammar                                                  | [RFC 3501 section 9](https://www.rfc-editor.org/rfc/rfc3501#section-9)             |
| Invalid sequence sets (`0`, `abc`, `5:`, `1:2:3`)                                                                                                                          | RFC 3501 section 9                                                                 |
| Message sequence numbers greater than the number of messages in FETCH, STORE, COPY and MOVE, also `*` in an empty mailbox. UID sets and SEARCH keys can point past the end | RFC 3501 section 9, seq-number                                                     |
| Flags that are not atoms, `\Recent` in STORE or APPEND, invalid dates                                                                                                      | RFC 3501 section 9                                                                 |
| `ENABLE` after `SELECT` or `EXAMINE`                                                                                                                                       | [RFC 5161 section 3.1](https://www.rfc-editor.org/rfc/rfc5161#section-3.1)         |
| `ID` lists that break the limits of RFC 2971                                                                                                                               | [RFC 2971](https://www.rfc-editor.org/rfc/rfc2971)                                 |
| More than one message in `APPEND` without MULTIAPPEND. With MULTIAPPEND, a zero-length message literal cancels the whole `APPEND` with `NO`                                | [RFC 3502](https://www.rfc-editor.org/rfc/rfc3502)                                 |
| Command lines longer than 1 MiB. RFC 2683 asks servers to accept at least 8000 octets, and clients to stay near 1000                                                       | [RFC 2683 section 3.2.1.5](https://www.rfc-editor.org/rfc/rfc2683#section-3.2.1.5) |

### Framing, literals and pipelining

| Rule                                                                                                                                                                                                                          | Reference                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Command lines that end with a bare LF instead of CRLF                                                                                                                                                                         | RFC 3501 section 9                                                                                                                                     |
| Literal data sent before the server's `+` continuation request                                                                                                                                                                | [RFC 3501 section 4.3](https://www.rfc-editor.org/rfc/rfc3501#section-4.3)                                                                             |
| `{n+}` without LITERAL+ or LITERAL-. With LITERAL-, a non-synchronizing literal over 4096 octets gets `BAD [TOOBIG]`                                                                                                          | [RFC 7888 section 5](https://www.rfc-editor.org/rfc/rfc7888#section-5)                                                                                 |
| Literals for unknown commands, or for commands that can not run in the current state, are refused without a continuation request                                                                                              | RFC 3501 section 4.3                                                                                                                                   |
| Literal8 (`~{n}`) anywhere but in an APPEND or REPLACE message with BINARY, or a SETMETADATA value with METADATA, refused without a continuation request. NUL octets in a normal literal. A literal8 `TEXT` part in CATENATE  | [RFC 3516](https://www.rfc-editor.org/rfc/rfc3516), [RFC 4469 section 5](https://www.rfc-editor.org/rfc/rfc4469#section-5)                             |
| Pipelined commands that RFC 3501 calls ambiguous, for example `CHECK` followed by `FETCH` without waiting for the `CHECK` result                                                                                              | [RFC 3501 section 5.5](https://www.rfc-editor.org/rfc/rfc3501#section-5.5)                                                                             |
| `STARTTLS` and `COMPRESS` with commands pipelined after them. TLS or compression is not started and the pipelined commands are refused without running. `COMPRESS` while compression is active gets `BAD [COMPRESSIONACTIVE]` | [RFC 9051 section 6.2.1](https://www.rfc-editor.org/rfc/rfc9051#section-6.2.1), [RFC 4978 section 3](https://www.rfc-editor.org/rfc/rfc4978#section-3) |
| Anything other than `DONE` while IDLE                                                                                                                                                                                         | [RFC 2177](https://www.rfc-editor.org/rfc/rfc2177)                                                                                                     |

Two of these, each pair sent in a single write (`<LF>` marks a bare line feed):

```text
C: A3 CHECK
C: A4 FETCH 1 FLAGS
S: A3 OK Completed
S: A4 BAD Commands with message sequence numbers must wait for the completion of earlier commands
C: A5 NOOP<LF>
C: A6 NOOP
S: A5 BAD Lines must end with CRLF
S: A6 OK Completed
```

### Mailbox names

| Rule                                                                                                               | Reference                                                                      |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Names that are not valid modified UTF-7, including 8-bit names                                                     | [RFC 3501 section 5.1.3](https://www.rfc-editor.org/rfc/rfc3501#section-5.1.3) |
| CREATE or RENAME to names with an empty hierarchy level (`foo//bar`, `/foo`, `foo//`), answered with `NO [CANNOT]` | [RFC 5530 section 3](https://www.rfc-editor.org/rfc/rfc5530#section-3)         |

### Search, sort and thread

| Rule                                                                                                                                                                                                                    | Reference                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8-bit SEARCH strings without `CHARSET UTF-8`, invalid UTF-8. An unsupported charset gets `NO [BADCHARSET]`                                                                                                              | [RFC 3501 section 6.4.4](https://www.rfc-editor.org/rfc/rfc3501#section-6.4.4)                                                                                                         |
| SORT and THREAD with a charset that is not an atom or a quoted string, an empty sort criteria list, `REVERSE` that is not followed by a sort key (`REVERSE REVERSE DATE`), or a threading algorithm that is not an atom | [RFC 5256 section 5](https://www.rfc-editor.org/rfc/rfc5256#section-5)                                                                                                                 |
| Unknown `SEARCH RETURN` options or `RETURN` after `CHARSET`, `$` combined with numbers, and `SEARCH MODSEQ` values or entry names that break the grammar                                                                | [RFC 4466 section 2.6.1](https://www.rfc-editor.org/rfc/rfc4466#section-2.6.1), [RFC 5182](https://www.rfc-editor.org/rfc/rfc5182), [RFC 7162](https://www.rfc-editor.org/rfc/rfc7162) |
| `UIDAFTER` and `UIDBEFORE` (MESSAGELIMIT) with anything but a single UID                                                                                                                                                | [RFC 9738 section 3.2](https://www.rfc-editor.org/rfc/rfc9738#section-3.2)                                                                                                             |

### Authentication

| Rule                                                                                                                                           | Reference                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Invalid base64 in SASL exchanges                                                                                                               | RFC 3501 section 9                                                                                                                             |
| 8-bit user names or passwords in `LOGIN` (UTF-8 user names need `AUTHENTICATE`), invalid UTF-8 in an `AUTHENTICATE PLAIN` message              | [RFC 9755 section 5](https://www.rfc-editor.org/rfc/rfc9755#section-5), [RFC 4616 section 2](https://www.rfc-editor.org/rfc/rfc4616#section-2) |
| OAUTHBEARER client responses that break the RFC 7628 or GS2 grammar, and anything other than a single `%x01` after an OAUTHBEARER error result | [RFC 7628](https://www.rfc-editor.org/rfc/rfc7628), [RFC 5801](https://www.rfc-editor.org/rfc/rfc5801)                                         |

See [Authentication](./authentication.md) for transcripts.

### Extensions

These apply when the plugin is loaded. Without it, the extension's commands and arguments are unknown and get `BAD` anyway.

| Extension                                                                             | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QRESYNC ([RFC 7162](https://www.rfc-editor.org/rfc/rfc7162))                          | The QRESYNC `SELECT` parameter or the `VANISHED` modifier without `ENABLE QRESYNC`, `VANISHED` with `FETCH` or without `CHANGEDSINCE`, and values that break the grammar: UIDVALIDITY or mod-sequence `0`, `*` in the UID sets, sequence match sets that are not ascending or not of the same size                                                                                                                                                             |
| LIST-EXTENDED ([RFC 5258](https://www.rfc-editor.org/rfc/rfc5258))                    | Unknown options, `RECURSIVEMATCH` without a base option like `SUBSCRIBED` (also `(SPECIAL-USE RECURSIVEMATCH)`, [RFC 6154 section 6](https://www.rfc-editor.org/rfc/rfc6154#section-6)), an empty pattern list, options with values they do not take, a repeated `STATUS` return option with different items, invalid `STATUS` items ([RFC 5819](https://www.rfc-editor.org/rfc/rfc5819))                                                                      |
| METADATA ([RFC 5464 section 3.2](https://www.rfc-editor.org/rfc/rfc5464#section-3.2)) | Entry names with `//`, a trailing `/`, `*`, `%`, 8-bit or control characters, or a scope other than `/private` or `/shared`, values that are atoms or use bare CR or LF as line ends, empty entry or option lists, and GETMETADATA options after the mailbox name (errata 2785)                                                                                                                                                                                |
| ACL ([RFC 4314 section 3](https://www.rfc-editor.org/rfc/rfc4314#section-3))          | Unknown or uppercase rights, empty identifiers, identifiers with control characters or invalid UTF-8                                                                                                                                                                                                                                                                                                                                                           |
| CATENATE ([RFC 4469](https://www.rfc-editor.org/rfc/rfc4469))                         | URLs that are not absolute-path references (`/INBOX/;UID=1`), including relative-path references like `;UID=1` that [RFC 5092 section 7.2](https://www.rfc-editor.org/rfc/rfc5092#section-7.2) forbids, and URLs of message parts that do not exist (`NO [BADURL ...]`)                                                                                                                                                                                        |
| UIDONLY ([RFC 9586](https://www.rfc-editor.org/rfc/rfc9586))                          | Every command that takes message sequence numbers, and sequence sets in search criteria, get `BAD [UIDREQUIRED]`                                                                                                                                                                                                                                                                                                                                               |
| UTF8=ACCEPT ([RFC 9755](https://www.rfc-editor.org/rfc/rfc9755))                      | Invalid UTF-8 in quoted strings, `SEARCH CHARSET` after `ENABLE UTF8=ACCEPT`, mailbox names with control characters (in UTF-8, or encoded in modified UTF-7 like `&AA0-`), U+2028, U+2029, a leading BOM, unassigned code points or a name that is not in Unicode Normalization Form C. `NO` for `APPEND` of a message with an 8-bit header before `ENABLE UTF8=ACCEPT` (section 4)                                                                            |
| BINARY ([RFC 3516](https://www.rfc-editor.org/rfc/rfc3516))                           | `BINARY[]`, `BINARY` of multipart or message/rfc822 parts ([RFC 9051 section 6.4.5](https://www.rfc-editor.org/rfc/rfc9051#section-6.4.5) allows leaf body parts only), `HEADER`, `TEXT` or `MIME` sections, and a partial range on `BINARY.SIZE`                                                                                                                                                                                                              |
| NOTIFY ([RFC 5465](https://www.rfc-editor.org/rfc/rfc5465))                           | MessageNew without MessageExpunge or the other way round, FlagChange without both (section 5), mailbox events or two selected filters with `selected`/`selected-delayed` (section 6.1), fetch attributes outside the selected filters, empty event or mailbox lists, `NOTIFY SET` without event groups. Unknown events get `NO [BADEVENT (...)]` listing the supported ones (section 3.1)                                                                      |
| IMAP4rev2 ([RFC 9051](https://www.rfc-editor.org/rfc/rfc9051))                        | After `ENABLE IMAP4rev2`: `CHECK`, `LSUB`, the `RFC822`, `RFC822.HEADER` and `RFC822.TEXT` FETCH items, the `NEW`, `OLD` and `RECENT` SEARCH keys and the `RECENT` STATUS item (none are in the RFC 9051 grammar, Appendix E), numbers above 63 bits in LARGER and SMALLER, invalid UTF-8, and mailbox names that are not Net-Unicode (section 5.1). Before it: 8-bit quoted strings (Appendix A), and partial ranges, LARGER and SMALLER values above 32 bits |

## Response codes

Failures carry the [RFC 5530](https://www.rfc-editor.org/rfc/rfc5530) response codes that [RFC 9051 section 7.1](https://www.rfc-editor.org/rfc/rfc9051#section-7.1) lists, in both protocol revisions:

| Code                                                              | When                                                                                                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AUTHENTICATIONFAILED`, `AUTHORIZATIONFAILED`                     | Failed logins                                                                                                                                                |
| `ALREADYEXISTS`, `NONEXISTENT`, `CANNOT`, `HASCHILDREN`, `NOPERM` | Mailbox operations                                                                                                                                           |
| `TRYCREATE`                                                       | The target of APPEND, COPY or MOVE does not exist or is a `\Noselect` name                                                                                   |
| `CLIENTBUG`                                                       | `STATUS` on the selected mailbox, and `STORE`, `EXPUNGE`, `UID EXPUNGE`, `MOVE` and `REPLACE` in a mailbox selected read-only                                |
| `EXPUNGEISSUED`                                                   | FETCH, STORE, SEARCH, SORT or THREAD completes while the EXPUNGE of another session can not be reported yet, see [Multiple sessions](./multiple-sessions.md) |

## RFC 2683 recommendations

A few client side recommendations of [RFC 2683](https://www.rfc-editor.org/rfc/rfc2683) are checked as well:

- `STATUS` on the selected mailbox gets `CLIENTBUG` (section 3.1.1).
- Mailbox names must be valid modified UTF-7 (section 3.4.2).
- EXPUNGE or STORE after EXAMINE, which answered `[READ-ONLY]`, get `NO` (section 3.3.2).

## The other direction

Strictness works both ways. ImapKit's own responses follow the grammar too: a string that can not be quoted is sent as a literal, and every status response has human readable text.

ImapKit's test suite enforces this. Every transcript a test produces goes through a response grammar check before the test looks at it: CRLF framing and literals, the RFC 3501 section 9 shape of tagged, untagged and continuation responses, and ImapFlow's response parser. A fuzz test replays mutated commands under the same check. So if your client fails to parse something ImapKit sent, look at the client's parser first.

The flip side: ImapKit does not imitate the quirks of real servers by default. To test how your client copes with a server that misbehaves, use [Scripted faults](../faults/scripted-faults.md) and [Quirk presets](../faults/quirk-presets.md).
