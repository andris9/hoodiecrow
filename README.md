# ImapKit

ImapKit is a scriptable, in-memory IMAP server for testing IMAP clients. It implements IMAP4rev1 ([RFC 3501](https://www.rfc-editor.org/rfc/rfc3501)) and, as an optional plugin, IMAP4rev2 ([RFC 9051](https://www.rfc-editor.org/rfc/rfc9051)), with more than 50 extensions that can be turned on and off per server instance. Nothing is ever written to disk: the mailbox tree comes from a JSON object, so every new server starts from the same known state.

ImapKit is strict on purpose: it answers client input that breaks the RFCs with `BAD` or `NO`, so client bugs show up in your test suite instead of in production (see [Strict by design](#strict-by-design)).

[![Run Tests](https://github.com/postalsys/imapkit/actions/workflows/test.yml/badge.svg)](https://github.com/postalsys/imapkit/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/imapkit)](https://www.npmjs.com/package/imapkit)
[![license](https://img.shields.io/npm/l/imapkit)](https://github.com/postalsys/imapkit/blob/master/LICENSE)

Homepage: [imapkit.com](https://imapkit.com). ImapKit requires Node.js 20 or newer.

> ImapKit is maintained by the team behind **[EmailEngine](https://emailengine.app/?utm_source=imapkit-readme&utm_medium=readme&utm_campaign=oss-docs&utm_content=note)**, a self-hosted email API that turns Gmail, Microsoft 365, and IMAP accounts into REST endpoints, with managed OAuth2 and webhooks for incoming mail. If you need a production email integration rather than a mock IMAP server for tests, start there.

> **Formerly Hoodiecrow.** ImapKit was published as [`hoodiecrow-imap`](https://www.npmjs.com/package/hoodiecrow-imap) up to version 3.3.1. To migrate, install `imapkit` instead and use `require('imapkit')`. The command is now `imapkit` and its environment variables start with `IMAPKIT_` instead of `HOODIECROW_`. The API, plugins, storage format and XTOYBIRD commands are unchanged.

# Usage

### Run as a standalone server

Install ImapKit globally with npm and run it:

```bash
npm install -g imapkit
imapkit -p 1143
```

Point your IMAP client to `localhost:1143` and log in with user name `testuser` and password `testpass`. Without `-p` the server listens on port 143 (993 with `--secure`), which usually needs root privileges.

`imapkit --smtpPort=1025` also starts an SMTP server that appends every message it receives to INBOX.

Run `imapkit --help` to see all command line options, the environment variables (`IMAPKIT_PORT`, `IMAPKIT_PLUGINS`, ...) and sample configuration data. For example, `imapkit -p 1143 --plugin=IDLE,MOVE,CONDSTORE --storage=storage.json` loads three plugins and the mailboxes of `storage.json`.

### Include as a Node.js module

Add `imapkit` dependency

```bash
npm install imapkit
```

Create and start an IMAP server

```javascript
import imapkit from 'imapkit';
// or with CommonJS: const imapkit = require('imapkit');

const server = imapkit(options);
server.listen(1143);
```

ImapKit is written in TypeScript and ships both ES modules and CommonJS, each with type declarations. The package exports the `imapkit(options)` factory as its default export, the `IMAPServer` and `IMAPConnection` classes, and types such as `IMAPServerOptions`, `Plugin`, `CommandHandler`, `Mailbox` and `Message` for writing plugins:

```typescript
import imapkit, { type IMAPServerOptions, type Plugin } from 'imapkit';
```

ImapKit needs Node.js 20 or newer. It also runs on the latest [Bun](https://bun.sh/) and [Deno](https://deno.com/) releases (`npm:imapkit` in Deno), CI runs the whole test suite on both.

See [complete.js](https://github.com/postalsys/imapkit/blob/master/examples/complete.js) for an example.

## Scope

ImapKit is a single user, multiple connection IMAP server. Changes made over IMAP live only in the memory of that server instance, so start a new server for every test.

Several clients can connect to the server simultaneously but all the clients share the same user account, even if login credentials are different. The ACL plugin can limit what users other than the owner can do (see [ACL](#acl)).

ImapKit is extendable: any command can be overridden and plugins can be added (see [Creating custom plugins](#creating-custom-plugins), and `src/commands` and `src/plugins` for the built-in commands and plugins). To test a client against a broken or unusual server, [script rules](#scripted-faults) make the server misbehave at chosen points.

## Strict by design

ImapKit is meant for developing standards compliant IMAP clients, so it follows the RFCs strictly instead of accepting whatever clients send. Most production servers are lenient, which hides client bugs until the client meets a stricter server. ImapKit answers these with `BAD` (or `NO` where the RFC requires it):

- commands sent in the wrong state (RFC 3501 section 3), for example `FETCH` before `SELECT` or `LOGIN` after login
- arguments to commands that take none (`NOOP x`, `CLOSE x`), missing or extra arguments, and values that break the RFC 3501 grammar
- command lines that end with a bare LF instead of CRLF
- literal data sent before the server's `+` continuation request (RFC 3501 section 4.3); `{n+}` is only accepted when LITERAL+ or LITERAL- is enabled, and with LITERAL- only up to 4096 octets, a larger one is answered with `BAD [TOOBIG]` (RFC 7888 section 5)
- literals for unknown commands, or for commands that can not run in the current state, are refused without a continuation request
- mailbox names that are not valid modified UTF-7 (RFC 3501 section 5.1.3), including 8-bit names, and CREATE or RENAME to names with an empty hierarchy level (`foo//bar`, `/foo`, `foo//`), answered with `NO [CANNOT]` (RFC 5530 section 3)
- invalid sequence sets (`0`, `abc`), message sequence numbers greater than the number of messages in FETCH, STORE, COPY and MOVE, also `*` in an empty mailbox (RFC 3501 section 9, seq-number; UID sets and SEARCH keys can point past the end), flags that are not atoms, `\Recent` in STORE or APPEND, invalid dates
- 8-bit SEARCH strings without `CHARSET UTF-8`, invalid UTF-8, unsupported charsets (`NO [BADCHARSET]`)
- SORT and THREAD (RFC 5256 section 5) with a charset that is not an atom or a quoted string, an empty sort criteria list, `REVERSE` that is not followed by a sort key (`REVERSE REVERSE DATE`), or a threading algorithm that is not an atom
- invalid base64 in SASL exchanges, and anything other than `DONE` while IDLE
- 8-bit user names or passwords in `LOGIN` (RFC 9755 section 5: UTF-8 user names need `AUTHENTICATE`), and invalid UTF-8 in an `AUTHENTICATE PLAIN` message (RFC 4616 section 2). User names are unicode strings everywhere: the keys of `users`, SASL user names and ACL identifiers
- OAUTHBEARER client responses that break the RFC 7628 or GS2 (RFC 5801) grammar, and anything other than a single `%x01` after an OAUTHBEARER error result
- `STARTTLS` and `COMPRESS` with commands pipelined after them (RFC 9051 section 6.2.1, RFC 4978 section 3), TLS or compression is then not started and the pipelined commands are refused with `BAD` without running, and `COMPRESS` while compression is active (`BAD [COMPRESSIONACTIVE]`)
- pipelined commands that RFC 3501 section 5.5 calls ambiguous, for example `CHECK` followed by `FETCH` without waiting for the `CHECK` result
- `ENABLE` after `SELECT` or `EXAMINE` (RFC 5161 section 3.1), and `ID` lists that break the RFC 2971 limits
- the QRESYNC `SELECT` parameter or the `VANISHED` modifier without `ENABLE QRESYNC`, `VANISHED` with `FETCH` or without `CHANGEDSINCE`, and QRESYNC values that break the RFC 7162 grammar (UIDVALIDITY or mod-sequence `0`, `*` in the UID sets, sequence match sets that are not ascending or not of the same size)
- unknown `SEARCH RETURN` options or `RETURN` after `CHARSET` (RFC 4466 section 2.6.1), `$` combined with numbers, and `SEARCH MODSEQ` values or entry names that break the RFC 7162 grammar
- extended LIST commands (RFC 5258) with unknown options, `RECURSIVEMATCH` without a base option like `SUBSCRIBED` (also `(SPECIAL-USE RECURSIVEMATCH)`, RFC 6154 section 6), an empty pattern list, options with values they do not take, a repeated `STATUS` return option with different items, and invalid `STATUS` items (RFC 5819)
- METADATA entry names that break RFC 5464 section 3.2 (`//`, a trailing `/`, `*`, `%`, 8-bit or control characters, a scope other than `/private` or `/shared`), values that are atoms or use bare CR or LF as line ends, empty entry or option lists, and GETMETADATA options after the mailbox name (errata 2785)
- unknown or uppercase ACL rights, and empty identifiers or identifiers with control characters or invalid UTF-8 (RFC 4314 section 3)
- more than one message in `APPEND` without MULTIAPPEND, and with MULTIAPPEND a zero-length message literal cancels the whole `APPEND` with `NO` (RFC 3502)
- CATENATE URLs that are not absolute-path references (`/INBOX/;UID=1`), including relative-path references like `;UID=1` that RFC 5092 section 7.2 forbids, and URLs of message parts that do not exist (`NO [BADURL ...]`)
- with UIDONLY (RFC 9586): every command that takes message sequence numbers, and sequence sets in search criteria, answered with `BAD [UIDREQUIRED]`
- `UIDAFTER` and `UIDBEFORE` (MESSAGELIMIT, RFC 9738 section 3.2) with anything but a single UID
- with UTF8=ACCEPT (RFC 9755): invalid UTF-8 in quoted strings, `SEARCH CHARSET` after `ENABLE UTF8=ACCEPT`, mailbox names with control characters (UTF-8, or encoded in modified UTF-7 like `&AA0-`), U+2028, U+2029, a leading BOM, unassigned code points or a name that is not in Unicode Normalization Form C, and `NO` for `APPEND` of a message with an 8-bit header before `ENABLE UTF8=ACCEPT` (section 4)
- literal8 (`~{n}`) anywhere but in an APPEND or REPLACE message with BINARY, or a SETMETADATA value with METADATA, refused without a continuation request; NUL octets in a normal literal; a literal8 `TEXT` part in CATENATE
- with BINARY: `BINARY[]`, `BINARY` of multipart or message/rfc822 parts (RFC 9051 section 6.4.5 allows leaf body parts only), `HEADER`, `TEXT` or `MIME` sections, and a partial range on `BINARY.SIZE`
- with NOTIFY (RFC 5465): MessageNew without MessageExpunge or the other way round, FlagChange without both (section 5), mailbox events or two selected filters with `selected`/`selected-delayed` (section 6.1), fetch attributes outside the selected filters, empty event or mailbox lists, `NOTIFY SET` without event groups; unknown events get `NO [BADEVENT (...)]` listing the supported ones (section 3.1)
- after `ENABLE IMAP4rev2` (RFC 9051): `CHECK`, `LSUB`, the `RFC822`, `RFC822.HEADER` and `RFC822.TEXT` FETCH items, the `NEW`, `OLD` and `RECENT` SEARCH keys and the `RECENT` STATUS item, none of which are in the RFC 9051 grammar (Appendix E), numbers above 63 bits in LARGER and SMALLER, and invalid UTF-8 or mailbox names that are not Net-Unicode (section 5.1); before it, 8-bit quoted strings (Appendix A) and partial ranges, LARGER and SMALLER values above 32 bits (RFC 3501 section 9 number)

Responses follow the grammar strictly too: strings that can not be quoted are sent as literals. Failures carry the RFC 5530 response codes that RFC 9051 section 7.1 lists, in both protocol revisions: `AUTHENTICATIONFAILED` and `AUTHORIZATIONFAILED` for logins, `ALREADYEXISTS`, `NONEXISTENT`, `CANNOT`, `HASCHILDREN` and `NOPERM` for mailbox operations, `TRYCREATE` when the target of APPEND, COPY or MOVE does not exist or is a `\Noselect` name, `CLIENTBUG` for `STATUS` on the selected mailbox and for `STORE`, `EXPUNGE`, `UID EXPUNGE`, `MOVE` and `REPLACE` in a mailbox selected read-only, and `EXPUNGEISSUED` when FETCH, STORE, SEARCH, SORT or THREAD completes while the EXPUNGE of another session can not be reported yet.

Some client side recommendations of RFC 2683 are checked too: `STATUS` on the selected mailbox gets `CLIENTBUG` (section 3.1.1), mailbox names must be valid modified UTF-7 (section 3.4.2), and EXPUNGE or STORE after EXAMINE, which answered `[READ-ONLY]`, get `NO` (section 3.3.2). Command lines are not limited to the 1000 octets that section 3.2.1.5 suggests for clients, the server accepts up to 1 MiB (the section asks servers for at least 8000 octets) and answers a longer line with `BAD`.

## Multiple sessions

ImapKit follows these of the strategies that RFC 2180 (IMAP4 Multi-Accessed Mailbox Practice) allows, so a client can be tested against one consistent behavior:

- a session that has not been told about the EXPUNGE of another session yet keeps its message numbers. FETCH still returns the expunged messages (section 4.1.1) and SEARCH still finds them (section 4.3), both end with `OK [EXPUNGEISSUED]`
- STORE does not change expunged messages: with `.SILENT` it ends with `OK` (section 4.2.1), otherwise the other messages are stored and get their FETCH responses, and the tagged response is `NO [EXPUNGEISSUED]` (sections 4.2.2 and 4.2.3; with CONDSTORE `NO [MODIFIED ...]` when that applies, RFC 7162 section 3.1.3)
- COPY and MOVE of a set that includes an expunged message copy nothing and return the pending EXPUNGE responses with `NO [EXPUNGEISSUED]` (section 4.4.1)
- UID commands report the pending EXPUNGE responses before they run (RFC 3501 section 7.4.1), the UIDs of the expunged messages then no longer exist and are ignored (RFC 3501 section 6.4.8). UID SEARCH with message numbers in its criteria still uses the old numbers
- DELETE of a mailbox that other sessions have selected disconnects them with `* BYE` (section 3.3)
- RENAME keeps the messages of the mailbox under the new name, sessions that have it selected keep working, the old name no longer exists (section 3.4)
- a session that ends without LOGOUT or CLOSE does not expunge anything (RFC 2683 section 3.1.2), and there is no inactivity timeout

## Authentication

By default the only account is user name `"testuser"` with password `"testpass"` (and access token `"testtoken"` for XOAUTH2 and OAUTHBEARER). The `users` option replaces the default account list, for example `{ "testuser": { "password": "testpass" }, "otheruser": { "password": "secret" } }`, and `XTOYBIRD USERADD` adds users at runtime. All users share the same mailbox tree.

## Status

### IMAP4rev1

All RFC 3501 commands are supported. Some choices that the RFCs leave to the server:

- The subscription list holds names, not mailboxes (RFC 3501 section 6.3.6). DELETE does not unsubscribe, so LSUB and `LIST (SUBSCRIBED)` keep listing the name (as `\NonExistent` in extended LIST) until UNSUBSCRIBE, and a mailbox created again under that name is subscribed. RENAME leaves the subscription with the old name (RFC 9051 section 6.3.6). A mailbox from the storage object is subscribed unless it has `"subscribed": false`, a new mailbox is not. SUBSCRIBE refuses names that are not mailboxes, UNSUBSCRIBE accepts any name
- CREATE `a/b` also creates `a` as a normal mailbox if it does not exist (RFC 3501 section 6.3.3, Dovecot creates a `\Noselect` level instead). An existing `\Noselect` level stays `\Noselect`
- DELETE of a mailbox with children leaves a `\Noselect` level that keeps nothing but the children, CREATE of that name makes a new mailbox with a new UIDVALIDITY
- A keyword stays in the FLAGS and PERMANENTFLAGS of a mailbox once a message in it had the keyword, also after that message is expunged (RFC 3501 section 7.2.6, like Dovecot)

### Supported Plugins

Plugins can be enabled when starting the server but can not be unloaded or loaded when the server is already running.
All plugins are self contained and not tied to core. If you do not enable a plugin, no trace of it is left
to the system. For example, if you do not enable CONDSTORE, messages do not have a MODSEQ value set.
Plugin names are case insensitive and capability spellings like `LITERAL+` or `AUTH=PLAIN` are accepted too.
An unknown plugin name throws an error, and a plugin listed more than once is loaded only once.

- **ACL** Adds ACL [RFC4314] capability with `RIGHTS=texk` (SETACL, DELETEACL, GETACL, LISTRIGHTS and MYRIGHTS), and LIST-MYRIGHTS [RFC8440] when LIST-EXTENDED is loaded. See [ACL](#acl) below
- **APPENDLIMIT** Adds APPENDLIMIT [RFC7889] capability. The server option `appendLimit` (octets) sets the limit for every mailbox and is advertised as `APPENDLIMIT=<n>`. A mailbox in the storage can set its own `appendLimit` (a number, or `null` for no limit), then the capability is advertised without a value and clients read the limits with `STATUS (APPENDLIMIT)`. Larger messages in APPEND and REPLACE fail with `NO [TOOBIG]`, synchronizing literals are refused before the client sends them
- **AUTH-PLAIN** Adds AUTH=PLAIN capability. Supports SASL-IR [RFC4959] as well
- **BINARY** Adds BINARY [RFC3516] support: `BINARY[<part>]<<partial>>`, `BINARY.PEEK` and `BINARY.SIZE` FETCH items that remove base64 and quoted-printable encodings (`NO [UNKNOWN-CTE]` for other encodings), and APPEND, MULTIAPPEND and REPLACE with literal8 messages (`~{n}`, `~{n+}` with LITERAL+ or LITERAL-). Decoded data is sent as a literal8 only when it contains NUL. Binary parts of an appended message, and parts with NUL octets, are stored base64 encoded, so `BODY[]` stays valid IMAP4rev1
- **COMPRESS** Adds COMPRESS=DEFLATE [RFC4978] capability. Raw DEFLATE in both directions after the tagged OK, every burst of responses ends with a sync flush
- **CATENATE** Adds CATENATE [RFC4469] and URL-PARTIAL [RFC5550] capabilities. APPEND (and REPLACE) can build a message from literals and IMAP URLs of messages or message parts on the server. Only absolute-path URLs are accepted, for example `/INBOX;UIDVALIDITY=1/;UID=2/;SECTION=1.MIME/;PARTIAL=0.100`, other URLs and URLs that do not resolve fail with `NO [BADURL ...]`. A message over the literal size limit fails with `NO [TOOBIG]`. Plugins can refuse URLs of a mailbox through `server.urlAccessChecks`
- **CONDSTORE** Adds CONDSTORE [RFC7162] support, including the `SEARCH MODSEQ` search key and the `CLOSED` response code
- **CONTEXT=SEARCH** Adds CONTEXT=SEARCH [RFC5267] capability, also loads ESEARCH: the `UPDATE`, `CONTEXT` and `PARTIAL` result options of SEARCH and UID SEARCH, and the CANCELUPDATE command. With `UPDATE` the session gets `ADDTO` and `REMOVEFROM` ESEARCH updates as messages start or stop matching, whether this or another session changed them (REMOVEFROM comes before the EXPUNGE response, ADDTO after EXISTS and FETCH). Updates end with CANCELUPDATE or when the mailbox is closed. Server option `maxSearchContexts` (default 10) limits the updating searches of a session, above it the server answers with `NO [NOUPDATE "tag"]`. `CONTEXT` is accepted as a hint and ignored. Message numbers in the search program are taken as they were when the search ran (RFC 5267 section 4.3)
- **CONTEXT=SORT** Adds CONTEXT=SORT [RFC5267] capability, also loads ESORT and CONTEXT=SEARCH: `UPDATE`, `CONTEXT` and `PARTIAL` for SORT and UID SORT, the updates carry context positions in sort order
- **CREATE-SPECIAL-USE** Enables CREATE-SPECIAL-USE [RFC6154] capability. Allowed special flags can be set with server option `"special-use"`
- **ESEARCH** Adds ESEARCH [RFC4731] capability: `SEARCH RETURN (MIN MAX ALL COUNT)` and `UID SEARCH RETURN (...)` answer with an ESEARCH response. With CONDSTORE the response includes `MODSEQ` for a `MODSEQ` search
- **ESORT** Adds ESORT [RFC5267] capability, also loads SORT and ESEARCH: `SORT RETURN (MIN MAX ALL COUNT)` and `UID SORT RETURN (...)` answer with an ESEARCH response in sort order. With SEARCHRES, `SAVE` works for SORT as well
- **ENABLE** Adds ENABLE capability [RFC5161]. Can be loaded in any order with the plugins it enables (eg. CONDSTORE). Capability names are matched case-insensitively, the ENABLED response lists them as the server advertises them (`IMAP4rev2`, `UTF8=ACCEPT`)
- **ID** Adds ID [RFC2971] capability
- **IDLE** Adds IDLE [RFC2177] capability
- **IMAP4rev2** Adds IMAP4rev2 [RFC9051], advertised next to IMAP4rev1 (Appendix A). Loads the extensions that IMAP4rev2 folds in (ENABLE, NAMESPACE, UNSELECT, UIDPLUS, ESEARCH, SEARCHRES, IDLE, SASL-IR, LIST-EXTENDED, LIST-STATUS, MOVE, BINARY, SPECIAL-USE, STATUS=SIZE, AUTH=PLAIN, and LITERAL- unless LITERAL+ is loaded), and keeps the `$Forwarded`, `$MDNSent`, `$Junk`, `$NotJunk` and `$Phishing` keywords also in mailboxes that do not allow new keywords. Every session starts as IMAP4rev1; after `ENABLE IMAP4rev2` it follows RFC 9051: `STATUS DELETED` is allowed, `SEARCH` answers with `ESEARCH`, `SELECT` and `EXAMINE` send an untagged `LIST` response for the mailbox and `* OK [CLOSED]` when they close one, but no `RECENT` response, `[UNSEEN]` code or `\Recent` flag, mailbox names and quoted strings are UTF-8, SEARCH assumes UTF-8 when no `CHARSET` is given, a message with 8-bit headers can be appended, message/global parts are described and numbered like message/rfc822, and the items that RFC 9051 removed are BAD (see [Strict by design](#strict-by-design)). STARTTLS and LOGINDISABLED (RFC 9051 section 6.1.1) are not loaded, as they change how clients log in; load them when needed. Partial FETCH ranges and the LARGER and SMALLER search keys take 63-bit numbers (number64) after ENABLE, 32-bit ones before it (partial ranges up to 2^53 - 1, the largest exact JavaScript number). A server that advertises only IMAP4rev2, UTF-8 in response text, and OLDNAME are not implemented
- **LIST-EXTENDED** Adds LIST-EXTENDED [RFC5258]: selection options `SUBSCRIBED`, `REMOTE` (there are no remote mailboxes) and `RECURSIVEMATCH`, return options `SUBSCRIBED` and `CHILDREN`, multiple mailbox patterns and the `CHILDINFO` extended data item. `\Noselect` mailboxes are listed as `\NonExistent` in extended LIST responses. With SPECIAL-USE loaded, the `SPECIAL-USE` selection and return options [RFC6154] combine with the other options. The plain RFC 3501 LIST is not changed
- **LIST-STATUS** Adds LIST-STATUS [RFC5819], the `STATUS` return option of LIST. Loads LIST-EXTENDED as well
- **LITERALMINUS** Enables LITERAL- [RFC7888] capability: non-synchronizing literals up to 4096 octets. A larger one is read and dropped, and the command is answered with `BAD [TOOBIG]`. Can not be loaded together with LITERALPLUS
- **LITERALPLUS** Enables LITERAL+ [RFC7888] capability. Can not be loaded together with LITERALMINUS, but replaces the LITERAL- that IMAP4rev2 loads
- **LOGINDISABLED** Disables LOGIN support for unencrypted connections
- **MESSAGELIMIT** Adds MESSAGELIMIT [RFC9738] capability, advertised as `MESSAGELIMIT=<n>`, where the server option `messageLimit` sets n (default 1000, any positive number is accepted so that small test mailboxes can hit it). FETCH, STORE, SEARCH, MOVE, UID EXPUNGE and their UID variants only work on the n messages with the highest UIDs (UID EXPUNGE counts the `\Deleted` ones) and add `[MESSAGELIMIT n uid]` with the lowest processed UID to the tagged OK, or send it in an untagged `NO` when the tagged OK already has a response code (like `HIGHESTMODSEQ` or `MODIFIED`). SEARCH counts the searched messages, which its top level sequence set, `UID`, `UIDAFTER` and `UIDBEFORE` keys narrow down. COPY, APPEND (MULTIAPPEND), SORT and THREAD of more messages, and a FETCH `PARTIAL` range (PARTIAL plugin) of more messages, fail with `NO [MESSAGELIMIT ...]`. EXPUNGE, CLOSE and STATUS are not limited. Adds the `UIDAFTER` and `UIDBEFORE` search keys. Can not be loaded together with SAVELIMIT
- **METADATA** Adds METADATA [RFC5464] capability (GETMETADATA and SETMETADATA) for server and mailbox annotations. Values can be binary: SETMETADATA takes a literal8 (`~{n}`), and values with NUL are sent back as a literal8. Initial mailbox entries come from a `metadata` object on the mailbox in storage (`"INBOX": { "metadata": { "/private/comment": "My comment" } }`), server entries from the `metadata` option. Server options `metadataMaxSize` (largest value in octets, default 65536), `metadataMaxEntries` (entries per mailbox and for the server, default 100) and `metadataPrivate: false` (refuse `/private` entries with `[METADATA NOPRIVATE]`) let you test the client's error handling. `/shared/admin` on the server is read-only. Annotations move with RENAME (renaming INBOX copies them), DELETE removes them. After `ENABLE METADATA` (needs the ENABLE plugin), changes made by other sessions are announced with unsolicited `METADATA` responses. With SPECIAL-USE loaded, the read-only `/private/specialuse` entry shows the special-use attributes of a mailbox (RFC 6154 section 4)
- **MULTISEARCH** Adds MULTISEARCH [RFC7377] capability, also loads ESEARCH: the ESEARCH command, also in the authenticated state. `ESEARCH IN (mailboxes "a" subtree "b" subtree-one "c" personal subscribed inboxes selected) RETURN (...) criteria` sends one ESEARCH response with UIDs and the `TAG`, `MAILBOX` and `UIDVALIDITY` correlators for every mailbox with matches. Mailboxes that do not exist or are `\Noselect` are skipped (with ACL also those without the `r` right, and without `l` unless named under `mailboxes` or as a subtree root), a mailbox named twice is searched once, and `inboxes` is INBOX. `SAVE` is only allowed when the selected mailbox is the only one searched, `UPDATE` (with CONTEXT=SEARCH) only applies to the selected mailbox
- **METADATA-SERVER** Same as METADATA, but only for server annotations (mailbox name `""`)
- **MOVE** Adds MOVE [RFC6851] capability (MOVE and UID MOVE commands)
- **MULTIAPPEND** Adds MULTIAPPEND [RFC3502] capability. APPEND takes several messages and appends all or none of them. With UIDPLUS, APPENDUID lists the UIDs as a UID set
- **NAMESPACE** Adds NAMESPACE [RFC2342] capability
- **NOTIFY** Adds NOTIFY [RFC5465] capability: `NOTIFY SET [STATUS] (filter events) ...` and `NOTIFY NONE` with the `selected`, `selected-delayed`, `inboxes` (same as `personal`), `personal`, `subscribed`, `subtree` and `mailboxes` filters and the MessageNew (with fetch attributes for the selected mailbox), MessageExpunge, FlagChange, MailboxName (LIST with `OLDNAME` for RENAME) and SubscriptionChange events, plus MailboxMetadataChange and ServerMetadataChange with METADATA. Events are sent as soon as they happen, also between commands, except EXPUNGE (or VANISHED) with `selected-delayed` and during FETCH, STORE and SEARCH. After the first NOTIFY a session only hears about the events it asked for, also for the selected mailbox; changes made by the session itself are not reported. Other mailboxes are reported with STATUS (UNSEEN when the `\Seen` count changed, HIGHESTMODSEQ when CONDSTORE is enabled), with ACL only mailboxes with the `l` and `r` rights, and granting or revoking `l` counts as MailboxName. Fetch attributes never set `\Seen`. `server.notifyOverflow([connection])` sends `* OK [NOTIFICATIONOVERFLOW]` and turns NOTIFY off. AnnotationChange (no ANNOTATE support) is refused with `NO [BADEVENT]`, the fetch attributes of the CONTEXT=SEARCH `UPDATE` option (RFC 5465 section 7) are not supported
- **OAUTHBEARER** Adds AUTH=OAUTHBEARER [RFC7628] capability, with or without SASL-IR. Uses the same credentials as XOAUTH2: access token `"testtoken"`, the authzid in the GS2 header (`n,a=testuser,`) is optional. A failed login gets the JSON error result as a continuation request (`invalid_token` or `invalid_request`), the client must answer it with `AQ==` (a single `%x01`)
- **OBJECTID** Adds OBJECTID [RFC8474] capability: `MAILBOXID` for CREATE, SELECT, EXAMINE and STATUS, `EMAILID` and `THREADID` for FETCH and SEARCH. Ids are generated (`F1`, `M1`, `T1`, ...) unless the storage sets a `MAILBOXID` for a mailbox or an `EMAILID` / `THREADID` for a message. COPY, MOVE and RENAME INBOX keep the EMAILID and THREADID of a message. Messages are threaded by their `Message-ID`, `In-Reply-To` and `References` headers across all mailboxes, a message joins the thread of the nearest known parent when it is added
- **PARTIAL** Adds PARTIAL [RFC9394] capability, also loads ESEARCH: the `PARTIAL` result option of SEARCH (`RETURN (PARTIAL 1:100)`, `RETURN (PARTIAL -1:-100)` counts from the last result) and of SORT with ESORT, and the `PARTIAL` modifier of FETCH and UID FETCH (`UID FETCH 1:* (FLAGS) (PARTIAL -1:-50)`), which combines with CHANGEDSINCE. With PARTIAL loaded a command takes only one PARTIAL or ALL result option
- **PREVIEW** Adds PREVIEW [RFC8970] capability (the PREVIEW FETCH data item with the LAZY modifier). Previews are generated from the first text/plain or text/html part (text/plain preferred in multipart/alternative, attachments, attached messages and encrypted content are skipped): transfer encoding and charset are decoded, HTML markup and quoted text are removed, whitespace is collapsed and the result is cut to 200 characters. A message in storage can set its own `"preview"` string instead. `PREVIEW (LAZY)` returns NIL until the preview of the message has been generated by a FETCH without LAZY, or comes from storage
- **QUOTA** Adds QUOTA [RFC9208] capability with `GETQUOTA`, `GETQUOTAROOT`, `SETQUOTA` (`QUOTASET`), the `STORAGE`, `MESSAGE` and `MAILBOX` resources and the `DELETED` and `DELETED-STORAGE` STATUS items. INBOX and the personal namespaces share one quota root, other namespaces have none. Configure it with the `quota` server option, eg. `{ "root": "User quota", "STORAGE": 10240, "MESSAGE": 1000, "MAILBOX": 100, "soft": false }` (STORAGE is in units of 1024 octets, a missing resource is not limited). APPEND, COPY and MOVE (from outside the quota root) fail with `NO [OVERQUOTA]` when they would go over a limit, and CREATE or RENAME INBOX when they would go over the MAILBOX limit. With `"soft": true` they succeed with an untagged `NO [OVERQUOTA]` warning instead. `SETQUOTA` changes the limits at runtime
- **REPLACE** Adds REPLACE [RFC8508] capability (REPLACE and UID REPLACE commands). With UIDPLUS, APPENDUID is sent in an untagged OK before the EXPUNGE. With QUOTA only the net usage counts (RFC 8508 section 3.4)
- **SASL-IR** Enables SASL-IR [RFC4959] capability
- **QRESYNC** Adds QRESYNC [RFC7162] capability, also loads CONDSTORE and ENABLE. After `ENABLE QRESYNC`: `SELECT`/`EXAMINE` with `(QRESYNC (uidvalidity modseq [known-uids] [seq-match-data]))` reports `VANISHED (EARLIER)` and the changed flags, `UID FETCH ... (CHANGEDSINCE n VANISHED)` works, and expunges (EXPUNGE, UID EXPUNGE, MOVE, other sessions, IDLE) are reported with `VANISHED` instead of `EXPUNGE`. Expunged UIDs are remembered with their mod-sequence; UIDs missing from the initial storage count as expunged before the server started
- **SAVELIMIT** Adds SAVELIMIT [RFC9738] capability, advertised as `SAVELIMIT=<n>` (server option `messageLimit`, default 1000): only COPY and APPEND (MULTIAPPEND) of more messages fail with `NO [MESSAGELIMIT ...]`. Can not be loaded together with MESSAGELIMIT
- **SAVEDATE** Adds SAVEDATE [RFC8514] capability: the `SAVEDATE` FETCH item and the `SAVEDBEFORE`, `SAVEDON`, `SAVEDSINCE` and `SAVEDATESUPPORTED` SEARCH keys. APPEND, COPY and MOVE set the save date to the current time, messages in storage can set it with a `SAVEDATE` value (a date-time string or a Date) and get the time the server was started otherwise. A mailbox with `"SAVEDATE": false` in storage does not support save dates: FETCH returns NIL and the SEARCH keys use the internal date
- **SEARCHRES** Adds SEARCHRES [RFC5182] capability, also loads ESEARCH: `SEARCH RETURN (SAVE)` stores the result and `$` refers to it in FETCH, STORE, COPY, MOVE, UID EXPUNGE, SEARCH and their UID variants. `$` must be used alone, not combined with numbers like `1,$`
- **SORT** Adds SORT [RFC5256] capability (SORT and UID SORT with all RFC 5256 sort keys). Strings are compared with the i;unicode-casemap collation (RFC 5051), base subjects follow RFC 5256 section 2.1 and sent dates section 2.2. With CONDSTORE, a MODSEQ search key appends the highest mod-sequence (RFC 7162 section 3.1.9). I18NLEVEL=1 is not advertised, as SEARCH matches strings with ASCII case folding only
- **SORT=DISPLAY** Adds SORT=DISPLAY [RFC5957] capability (DISPLAYFROM and DISPLAYTO sort keys), also loads SORT
- **SPECIAL-USE** Enables SPECIAL-USE [RFC6154] capability Mailboxes need to have a "special-use" property (String or Array) that will be used as extra flag for LIST and LSUB responses
- **STARTTLS** Adds STARTTLS command
- **STATUS=SIZE** Adds STATUS=SIZE [RFC8438], the `SIZE` status item (also with LIST-STATUS). The plugin file is `status-size`
- **THREAD=ORDEREDSUBJECT** Adds THREAD=ORDEREDSUBJECT [RFC5256] capability (THREAD and UID THREAD)
- **THREAD=REFERENCES** Adds THREAD=REFERENCES [RFC5256] capability (THREAD and UID THREAD), the full REFERENCES algorithm of RFC 5256 section 3. Load both THREAD plugins to support both algorithms
- **UIDONLY** Adds UIDONLY [RFC9586] capability and loads ENABLE. After `ENABLE UIDONLY`, FETCH, STORE, SEARCH, COPY, MOVE, SORT, THREAD and REPLACE, message numbers in the criteria of UID SEARCH, UID SORT, UID THREAD and the ESEARCH command (MULTISEARCH), and the QRESYNC message sequence match data are refused with `BAD [UIDREQUIRED]` (a synchronizing literal of such a command is refused before it is sent). Every FETCH response becomes a `* <uid> UIDFETCH (...)` response (the `UID` item is only included when UID FETCH asks for it), expunges are reported with `VANISHED`, and SELECT does not send `[UNSEEN n]`. EXISTS and RECENT are not changed. Load UIDPLUS for UID EXPUNGE and COPYUID
- **UIDPLUS** Adds UIDPLUS [RFC4315] capability (APPENDUID, COPYUID and UID EXPUNGE)
- **UNAUTHENTICATE** Adds UNAUTHENTICATE [RFC8437] capability. Returns to the Not Authenticated state and resets the session: the selected mailbox is closed without expunging, ENABLEd extensions and CONDSTORE are turned off, and COMPRESS ends after the tagged OK. TLS stays
- **UNSELECT** Adds UNSELECT [RFC3691] capability
- **UTF8=ACCEPT** Adds UTF8=ACCEPT [RFC9755] capability and loads ENABLE. After `ENABLE UTF8=ACCEPT` mailbox names are UTF-8 in both directions (storage keeps modified UTF-7 names, so `&` is an ordinary character), strings that are valid UTF-8 are sent quoted, and SEARCH strings are UTF-8 without `CHARSET`. UTF8=ONLY, the obsolete `APPEND ... UTF8 (...)` data item of RFC 6855 and downgrading of 8-bit headers for clients that did not enable UTF-8 (RFC 9755 section 8) are not implemented
- **X-GM-EXT-1** Adds [Gmail specific](https://developers.google.com/workspace/gmail/imap/imap-extensions) extensions. `X-GM-MSGID` and `X-GM-THRID` work with FETCH and SEARCH (every message is its own thread unless the storage sets an `X-GM-THRID` value for it; with OBJECTID loaded, the messages of a `THREADID` share the `X-GM-THRID` of the first message of that thread, so both thread ids group the same messages). `X-GM-LABELS` works with FETCH, STORE (`+`, `-`, `.SILENT`) and SEARCH: system labels are atoms that start with `\` (`\Inbox` for INBOX, the special-use attribute for special-use mailboxes), other labels are mailbox names, sent and read in the form the session uses for mailbox names (modified UTF-7, or UTF-8 after `ENABLE UTF8=ACCEPT`) and quoted when they are not atoms. In SEARCH a label that starts with `\` is a system label. Setting a label does not change message behavior, for example the message does not get copied to another mailbox. `X-GM-RAW` supports a subset of the Gmail search syntax: words and `"phrases"` (TEXT), `-term`, `OR`, `( )`, `{ }`, `from:`, `to:`, `cc:`, `bcc:`, `subject:`, `label:`, `in:` (`inbox`, `sent`, `drafts`, `trash`, `spam`, `anywhere` or a label), `is:` (`read`, `unread`, `starred`, `important`), `larger:` and `smaller:` (with `k` or `m`), `after:` and `before:` (`YYYY/MM/DD`) and `rfc822msgid:`. Other Gmail operators (`has:`, `older_than:` ...) are answered with NO
- **XOAUTH2** Gmail XOAUTH2 login. Needs SASL-IR (load the SASL-IR plugin too), Gmail itself does not. Use `"testuser"` as the user name and `"testtoken"` as the access token to log in.
- **XTOYBIRD** Custom plugin to allow programmatic control of the server. XTOYBIRD commands are only allowed after login

## ACL

All users share the same mailbox tree. With the ACL plugin, the owner (server option `aclOwner`, `"testuser"` by default) has every right on every mailbox, and every other user only gets the rights that the ACL of a mailbox grants to their user name or to `anyone`, minus the negative rights of `-username` and `-anyone` (RFC 4314 section 2). ACLs come from the `acl` property of a mailbox in the storage, or from SETACL:

```json
{
    "INBOX": { "acl": { "otheruser": "lrs", "anyone": "l" } },
    "": { "folders": { "Shared": { "acl": { "otheruser": "lrswikte", "-otheruser": "t" } } } }
}
```

The rights of other users are enforced as RFC 4314 section 4 describes:

- LIST and LSUB leave out mailboxes without `l`. SELECT, EXAMINE and STATUS need `r`, SUBSCRIBE needs `l`
- a mailbox is opened READ-ONLY without any of `i`, `e`, `s`, `w` and `t`, and PERMANENTFLAGS only lists the flags the user can change
- STORE changes only the flags the user has rights for (`s` for `\Seen`, `t` for `\Deleted`, `w` for the others) and answers `NO [NOPERM]` if it could change none of them; a FETCH without `s` does not set `\Seen`
- APPEND and COPY need `i` on the target and keep only the flags the user has rights for. MOVE also needs `t` and `e` on the source (RFC 6851 section 4.2), and so does REPLACE (RFC 8508 section 4.1). APPEND and REPLACE are refused before the message literal is sent, a target the user can not see like a missing one
- EXPUNGE needs `e`, CLOSE without `e` closes the mailbox without expunging
- CREATE needs `k` on the nearest existing parent (so other users can not create top level mailboxes), DELETE needs `x`, RENAME needs `x` on the mailbox and `k` on the new parent
- GETACL, SETACL, DELETEACL and LISTRIGHTS need `a`, MYRIGHTS needs any of `l`, `r`, `i`, `k`, `x`, `a`
- with LIST-STATUS, mailboxes without `r` get no STATUS response and are listed with `\Noselect` (RFC 5819 section 2)
- with METADATA, GETMETADATA and SETMETADATA on a mailbox need `l` and any of `r`, `s`, `w`, `i`, `p` (RFC 5464 section 3.3), and unsolicited METADATA responses only go to sessions with these rights
- with QUOTA, GETQUOTAROOT only lists the MAILBOX resource without `r` on the mailbox, and SETQUOTA needs `a` on every mailbox of the quota root (RFC 9208 section 6)

Missing rights are answered with `NO [NOPERM]`, or with the same error as for a mailbox that does not exist when the user does not have `l` either, so the existence of the mailbox is not disclosed (RFC 4314 section 6). The rights on the selected mailbox are taken when it is selected. A new mailbox inherits the ACL of its parent and DELETE removes the ACL. The obsolete `c` and `d` rights are accepted as `kx` and `et` and are added to ACL and MYRIGHTS responses (RFC 4314 section 2.1.1). The rights of the owner can not be changed.

## Existing XTOYBIRD commands

To use these functions, XTOYBIRD plugin needs to be enabled and the client needs to be logged in.

XTOYBIRD is a test control plugin, not an IMAP extension: it skips every access check, so any user that may use it can read the whole storage (all users' mailboxes with `XTOYBIRD STORAGE`), add users and shut the server down. Load it only in tests that need it. With the ACL plugin only the owner (`aclOwner` option, default `testuser`) may use XTOYBIRD, other users get `NO [NOPERM]`.

Available commands:

- **XTOYBIRD SERVER** dumps server internals
- **XTOYBIRD CONNECTION** dumps connection internals
- **XTOYBIRD STORAGE** dumps storage as JSON
- **XTOYBIRD USERADD "username" "password"** adds or updates user
- **XTOYBIRD USERDEL "username"** removes a user
- **XTOYBIRD SHUTDOWN** Closes the server after the last client disconnects. New connections are rejected.

Example usage for XTOYBIRD STORAGE:

```
S: * OK ImapKit ready for rumble
C: A0 LOGIN testuser testpass
S: A0 OK User logged in
C: A1 XTOYBIRD STORAGE
S: * XTOYBIRD [XJSONDUMP] {3224}
S: {
S:     "INBOX": {
S:         "messages": [
S:             {
S:                 "raw": "Subject: hello 1\r\n\r\nWorld 1!",
S:                 ...
S: A1 OK XTOYBIRD Completed
```

## Ideas for future XTOYBIRD commands

- Change UIDVALIDITY at runtime (eg. `A1 XTOYBIRD UIDVALIDITY INBOX 123` where 123 is the new UIDVALIDITY for INBOX)
- Reset the server to its initial state (`A1 XTOYBIRD RESET`)
- Replace the storage at runtime with a JSON string that describes the entire storage (`A1 XTOYBIRD UPDATE {123}\r\n{"INBOX":{...}})`)

## CONDSTORE support

- All messages have MODSEQ value
- CONDSTORE can be ENABLEd
- SELECT/EXAMINE show HIGHESTMODSEQ
- SELECT/EXAMINE support (CONDSTORE) option
- Updating flags increments MODSEQ value
- FETCH (MODSEQ) works
- FETCH (CHANGEDSINCE modseq) works
- STORE (UNCHANGEDSINCE modseq) works, messages changed since then are reported with `[MODIFIED ...]`
- SEARCH MODSEQ works, the entry name and type are checked but ignored since MODSEQ is not stored per flag
- Flag changes made by other sessions include MODSEQ once CONDSTORE is enabled
- SELECT/EXAMINE send `* OK [CLOSED]` when they close the selected mailbox

# Known issues

- **addr-adl** (at-domain-list) values are not supported, NIL is always used
- **anonymous namespaces** are not supported
- **LIST** does not insert a hierarchy delimiter between a reference without one and the mailbox name (RFC 2683 section 3.4.9 recommends it), the two are concatenated as RFC 9051 section 6.3.9 describes, like Dovecot does
- **CHARSET** values other than US-ASCII and UTF-8 are not supported

# Running tests

The source is TypeScript in `src/`, `npm run build` compiles it into `dist/esm` (ES modules) and `dist/cjs` (CommonJS). Tests use the built-in Node.js test runner (TypeScript test files run through [tsx](https://tsx.is/)), linting uses ESLint and the TypeScript compiler, and formatting uses Prettier.

    npm install
    npm test                                       # lint, type check, build and all tests
    npm run test:unit                              # tests only
    npm run test:coverage                          # tests with coverage (Node.js 22.8 or newer)
    npm run test:bun                               # tests under Bun
    npm run test:deno                              # tests under Deno
    node --import tsx --test test/fetch.test.ts    # a single test file
    npm run format                                 # apply Prettier formatting

`compare/` holds a development tool that replays the same IMAP commands against ImapKit and a Dovecot server running in Docker and shows where the responses differ (`npm run dovecot:start`, then `npm run compare -- compare/scenarios/fetch.txt`). See [CLAUDE.md](CLAUDE.md#comparing-with-dovecot) for details.

## Example storage

The `storage` option (or `--storage=<path>` for the command) describes the mailbox tree. The keys are namespaces.

### Cyrus

storage.json:

```json
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

### Gmail

storage.json:

```json
{
    "INBOX": {},
    "": {
        "separator": "/",
        "folders": {
            "[Gmail]": {
                "flags": ["\\Noselect"],
                "folders": {
                    "All Mail": {
                        "special-use": "\\All"
                    },
                    "Drafts": {
                        "special-use": "\\Drafts"
                    },
                    "Important": {
                        "special-use": "\\Important"
                    },
                    "Sent Mail": {
                        "special-use": "\\Sent"
                    },
                    "Spam": {
                        "special-use": "\\Junk"
                    },
                    "Starred": {
                        "special-use": "\\Flagged"
                    },
                    "Trash": {
                        "special-use": "\\Trash"
                    }
                }
            }
        }
    }
}
```

## Use ImapKit for testing your client

Creating your tests in Node.js is a piece of cake, you do not even need to run the `imapkit` command. Here is a sample test using the built-in [Node.js test runner](https://nodejs.org/api/test.html).

```javascript
import { describe, it, beforeEach, afterEach } from 'node:test';
import imapkit from 'imapkit';
import myIMAPClient from '../my-imap-client.js';

describe('IMAP tests', () => {
    let server;

    // Executed before every test, creates a new blank IMAP server
    // on a random free port
    beforeEach(
        () =>
            new Promise(resolve => {
                server = imapkit();
                server.listen(0, resolve);
            })
    );

    // Executed after every test, closes the IMAP server created for the test
    afterEach(() => new Promise(resolve => server.close(resolve)));

    // A new IMAP client is instantiated that tries to connect to the
    // IMAP server. If the client is connected the test is considered as passed.
    it('Connect to the server', (t, done) => {
        const client = myIMAPClient.connect('localhost', server.address().port);
        client.on('ready', () => {
            client.disconnect();
            done();
        });
    });
});
```

## Scripted faults

ImapKit is strict and correct by default. To test how a client copes with a server that is not, script rules make the server deviate from the protocol at chosen points: answer a command with a canned response, send a literal where a quoted string is expected, cut a response in the middle of a literal, delay or split output, or drop the connection. Rules come from the `script` server option (a rule or a list of rules), or are added at runtime with `server.script.add()`:

```javascript
const server = imapkit({
    plugins: ['IDLE'],
    script: [
        // the first SELECT gets NO, the next ones run as usual
        { on: 'command', command: 'SELECT', times: 1, send: '$TAG NO [UNAVAILABLE] Try again later\r\n' },
        // the body of message 1 is cut short and the connection dropped
        { on: 'response', command: 'FETCH', match: /^\* 1 FETCH .*BODY\[\]/, truncate: 40 }
    ]
});

// a rule added later, it returns a handle
const rule = server.script.add({
    on: 'response',
    command: 'FETCH',
    untagged: true,
    // strings in the response tree become literals, valid IMAP that a client must handle
    mutate: response => {
        const walk = list =>
            list.forEach((node, i) => (Array.isArray(node) ? walk(node) : typeof node === 'string' && (list[i] = { type: 'LITERAL', value: node })));
        walk(response.attributes);
    }
});
// ... run the client
assert.strictEqual(rule.hits, 1);
rule.remove();
```

Every rule watches one event (`on`):

- `greeting`: the `* OK` greeting of a new connection
- `command`: a complete command line (with its literals) from the client. The rule acts instead of the parser and the command handler, so it also matches lines that do not parse and commands that do not exist. The rule is chosen when the line arrives (matchers like `state` see the session at that moment), and acts in the order of the commands, so pipelined responses stay in order
- `input`: a line read by a command that takes over the input, like `DONE` of IDLE or a SASL response of AUTHENTICATE
- `response`: every response the server sends with `connection.send()`, tagged and untagged, as the exact bytes that are about to go out, after every plugin and the core changed the response
- `continuation`: a `+` continuation request (literals, IDLE, AUTHENTICATE)

The matchers of a rule all have to match. Rules are checked in the order they were added, the first rule that matches and is not used up handles the event, so a later rule can handle what an earlier one leaves alone.

| Matcher                    | Events                 | Matches                                                                                                                                                            |
| -------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `command`                  | all but greeting       | the command name, or a list of names, case-insensitive (`'UID FETCH'`). An unsolicited response belongs to the command that runs, or that reads input (IDLE)       |
| `tag`                      | all but greeting       | the command tag, a string or a RegExp                                                                                                                              |
| `description`              | response, continuation | the description passed to `connection.send()`, or a list of them. Continuation requests are `LITERAL`, `IDLE`, `AUTHENTICATE PLAIN` and `AUTHENTICATE OAUTHBEARER` |
| `untagged`                 | response               | `true` for untagged responses only, `false` for tagged ones                                                                                                        |
| `session`                  | all                    | the number of the connection, or a list of numbers, 1 for the first connection the server accepted                                                                 |
| `state`, `user`, `mailbox` | all                    | the session state (`'Not Authenticated'`, `'Authenticated'`, `'Selected'`), the authenticated user, the path of the selected mailbox                               |
| `match`                    | all                    | a RegExp, or a string with a regular expression, tested against the command line or the output bytes (a binary string)                                             |
| `when`                     | all                    | a function that gets the event context and returns true to match                                                                                                   |
| `nth`                      | all                    | the rule fires from the nth matching event on (default 1)                                                                                                          |
| `times`                    | all                    | the rule fires this many times at most, then lets later rules handle the event                                                                                     |

The actions say what happens instead of the usual behavior. Strings are sent as they are (binary strings, one character per octet, or UTF-8 when they have characters above U+00FF) without an added CRLF, and `$TAG` in a string is replaced with the tag of the command. A Buffer is sent as it is, a function gets the event context and returns a string or a Buffer.

| Action                | Events                 | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send`                | all                    | output events: bytes sent instead of the output. command and input: bytes sent instead of processing the line                                                                                                                                                                                                                                                                                                                                                  |
| `run`                 | command, input         | process the line as usual after `send` (to add output before the real response)                                                                                                                                                                                                                                                                                                                                                                                |
| `drop`                | all                    | output events: send nothing. command and input: ignore the line, the client gets no answer                                                                                                                                                                                                                                                                                                                                                                     |
| `mutate`              | response, continuation | `(response, context)` gets a copy of the response object before it is compiled and changes it, or returns another one. Continuation requests have a response object only when a plugin sends them with `connection.send()` (the error challenges of XOAUTH2 and OAUTHBEARER), other events ignore `mutate`. A tagged response that does not compile then is sent as `NO [SERVERBUG]`, an untagged one is dropped. Use `send` for output that is not valid IMAP |
| `before`, `after`     | output events          | bytes sent before or after the output, e.g. an unsolicited response                                                                                                                                                                                                                                                                                                                                                                                            |
| `delay`               | all but input          | milliseconds to wait before the output goes out, all later output waits behind it. For a command, the wait before the rule acts or the command runs, later commands wait too                                                                                                                                                                                                                                                                                   |
| `chunk`, `chunkDelay` | all                    | write the bytes in pieces of `chunk` octets, `chunkDelay` milliseconds apart (default 10)                                                                                                                                                                                                                                                                                                                                                                      |
| `truncate`            | all                    | send only this many octets of the bytes, then close the connection                                                                                                                                                                                                                                                                                                                                                                                             |
| `close`               | all                    | close the connection after the bytes are sent, `'reset'` destroys the socket instead (a TCP RST where the runtime supports it)                                                                                                                                                                                                                                                                                                                                 |

A rule needs at least one action, and for command and input events `chunk` and `truncate` need `send`. A rule with only `delay` (and `run`) delays the line and then processes it as usual. Rules are checked when they are added: an unknown option, an option that does not apply to the event, or an invalid value throws a `TypeError`, so a typo can not turn into a rule that never fires.

The event context, which `when`, `mutate` and `send` functions get, has `event`, `connection`, `session`, `state`, `user`, `mailbox`, `tag`, `command`, `data` (the command line or the output bytes, as a binary string), and for responses `description` and `response`.

`server.script.add(rule)` returns a handle with `rule`, `matched` (events that matched the rule, also before `nth`), `hits` (events the rule handled) and `remove()`, `server.script.add([rules])` returns a list of handles. `server.script.rules` lists the handles in order, `server.script.clear()` removes every rule. The server emits a `script` event `{ rule, event, session, tag, command }` every time a rule fires.

The `imapkit` command takes the rules as JSON with `--script=<path>` (or `IMAPKIT_SCRIPT`), or as `script` in the `--config` file. JSON rules use strings for `match` and `send`, functions (`when`, `mutate`, function values of `send`) work only from JavaScript:

```json
[
    { "on": "greeting", "send": "* BYE Too many connections\r\n", "close": true, "times": 1 },
    { "on": "response", "command": "FETCH", "untagged": true, "send": "* 1 FETCH (BODY[] {100}\r\nshort", "close": true }
]
```

Faults change only the output and the handling of the lines a rule matches, the state of the server stays consistent: a LOGIN answered by a rule with `OK` does not log the session in, and a dropped EXPUNGE response still removes the message. COMPRESS works with delayed output, as the output keeps the compression layer it was sent with. Script rules are for tests only, a rule can send anything.

## Creating custom plugins

A plugin can be a string as a pointer to a built in plugin or a function. Plugin function is run when the server is created and gets server instance object as an argument.

```javascript
imapkit({
    // Add two plugins, built in "IDLE" and custom function
    plugins: ['IDLE', myAwesomePlugin]
});

// Plugin handler
function myAwesomePlugin(server) {
    // Add a string to the capability listing
    server.registerCapability('XSUM');

    /**
     * Add a new command XSUM
     * If client runs this command, the response is a sum of all
     * numeric arguments provided
     *
     * A1 XSUM 1 2 3 4 5
     * * XSUM 15
     * A1 OK SUM completed
     *
     * @param {Object} connection - Session instance
     * @param {Object} parsed - Input from the client in structured form
     * @param {String} data - Input command as a binary string
     * @param {Function} callback - callback function to run
     */
    server.setCommandHandler('XSUM', function (connection, parsed, data, callback) {
        // Send untagged XSUM response
        connection.send(
            {
                tag: '*',
                command: 'XSUM',
                attributes: [
                    [].concat(parsed.attributes || []).reduce(function (prev, cur) {
                        return prev + Number(cur.value);
                    }, 0)
                ]
            },
            'XSUM',
            parsed,
            data
        );

        // Send tagged OK response
        connection.send(
            {
                tag: parsed.tag,
                command: 'OK',
                attributes: [
                    // TEXT allows to send unquoted
                    { type: 'TEXT', value: 'XSUM completed' }
                ]
            },
            'XSUM',
            parsed,
            data
        );
        callback();
    });
}
```

### Plugin methods

#### Add a capability

    server.registerCapability(name[, availability])

Where

- **name** a string displayed in the capability response
- **availability** a function which returns boolean value. Executed before displaying the capability response. If the function returns true, the capability is displayed, if false then not.

Example

```javascript
// Display in CAPABILITY only in Not Authenticated state
server.registerCapability('XAUTH', function (connection) {
    return connection.state === 'Not Authenticated';
});
```

#### Define a command

    server.setCommandHandler(name, handler[, options])

Where

- **name** is the command name
- **handler** _(connection, parsed, data, callback)_ is the handler function for the command
- **options** is an optional object, checked by the server before the handler runs:
    - **states** lists the connection states the command is valid in (`'Not Authenticated'`, `'Authenticated'`, `'Selected'`), any state if not set. A plain list is read as the states
    - **noArguments** if true, the command is refused when it has arguments
    - **mailboxArguments** lists the positions of arguments that are mailbox names, these must be valid modified UTF-7 (RFC 3501 section 5.1.3)
    - **astringArguments** lists the positions of other astring arguments (user names, identifiers). In these, in mailbox names and in search criteria an atom `NIL` reaches the handler as an atom, not as `null`
    - **searchCriteria** is the position where SEARCH style criteria start, **sequenceSet** the position of an argument with message sequence numbers. Both are used for the RFC 3501 section 5.5 pipelining check
    - **noExpunge** if true, EXPUNGE responses are held back while the command runs (like FETCH, STORE and SEARCH, RFC 3501 section 7.4.1)
    - **literal8** if true (or the name of the capability that allows it), the command accepts `~{n}` literals (RFC 3516)
    - **noPipelining** if true, the command is refused with BAD when the client sent more input after it (STARTTLS, COMPRESS), and so are the commands sent with it
    - **appendMessage** if true, the command takes a message after its mailbox argument like APPEND (REPLACE), so a message literal to a missing mailbox is refused with `NO [TRYCREATE]` before it is sent

    Without options, a command that already exists (such as a built-in one that the handler wraps) keeps its settings.

#### Inspect command options

    server.getCommandOptions(name) -> Object
    server.getCommandStates(name) -> Array|false

`getCommandOptions` returns the options of a command (see above) with every key set, `getCommandStates` only the connection states it is valid in, or `false` if any state is fine.

#### Run after every plugin is loaded

A plugin that wraps commands or handlers of other plugins, whatever the load order, does it once all plugins are loaded:

```javascript
server.once('pluginsLoaded', function () {
    const move = server.getCommandHandler('MOVE');
    // ...
});
```

Handler arguments

- **connection** - Session instance
- **parsed** - Input from the client in structured form (see [imap-handler](https://github.com/postalsys/imap-handler#parse-imap-commands) for reference)
- **data** - Input command as a binary string
- **callback** - callback function to run (does not take any arguments)

The command should send data to the client with `connection.send()`

    connection.send(response, description, parsed, data, /* any additional data */)

Where

- **response** is a [imap-handler](https://github.com/postalsys/imap-handler#parse-imap-commands) compatible object. To get the correct tag for the OK, NO or BAD response, look into `parsed.tag`
- **description** is a string identifying the response to be used by other plugins
- **parsed** is the `parsed` argument passed to the handler
- **data** is the `data` argument passed to the handler
- additional arguments can be used to provide input for other plugins

#### Retrieve an existing handler

To override existing commands you should first cache the existing command, so you can use it in your own command handler.

    server.getCommandHandler(name) -> Function

Where

- **name** is the function name

Example

```javascript
const list = server.getCommandHandler('LIST');
server.setCommandHandler('LIST', function (connection, parsed, data, callback) {
    // do something
    console.log('Received LIST request');
    // run the cached command
    list(connection, parsed, data, callback);
});
```

#### Reroute input from the client

If your plugin needs to get direct input from the client, you can reroute the incoming data by defining a `connection.inputHandler` function. The function gets input data as complete lines (without the linebreaks). Once you want to reroute the input back to the command handler, just clear the function.

```
connection.inputHandler = function(line){
    console.log(line);
    connection.inputHandler = false;
}
```

See [idle.ts](https://github.com/postalsys/imapkit/blob/master/src/plugins/idle.ts) for an example

Raw output, such as a `+` continuation request, goes through `connection.write(data)`, and `connection.end()` closes the connection once all output is written. Do not use `connection.socket` for this, a COMPRESS layer (`connection.transport`) sits between the protocol and the socket.

#### Reset session state

UNAUTHENTICATE (RFC 8437) returns a connection to the Not Authenticated state. A plugin that keeps per-session state on the connection object adds a handler that clears it:

```javascript
server.resetHandlers.push(function (connection) {
    connection.mySessionState = false;
});
```

#### Override output

Any response sent to the client can be overridden or cancelled by other handlers. You should append your handler to `server.outputHandlers` array. If something is being sent to the client, the response object is passed through all handlers in this array.

Output handlers are meant for extensions that change valid responses. They run before the core finishes the response (response codes like `EXPUNGEISSUED`, mailbox names, the 7-bit status text) and before the compiler, which refuses output that is not valid IMAP. To make the server send something wrong on purpose, use [script rules](#scripted-faults) instead, they see the final bytes.

    server.outputHandlers.push(function(connection, /* arguments from connection.send */){})

`response` arguments from `connection.send` is an object and thus any modifications will be passed on. If `skipResponse` property is added to the response object, the data is not sent to the client.

```javascript
// All untagged responses are ignored and not passed to the client
server.outputHandlers.push(function (connection, response, description) {
    if (response.tag === '*') {
        response.skipResponse = true;
        console.log('Ignoring untagged response for %s', description);
    }
});
```

#### Other extension points

- `server.messageHandlers` and `server.mailboxHandlers` run on every message and mailbox when it is loaded from storage or created, `(server, message, mailbox)` and `(server, mailbox)`
- `server.statusHandlers[ITEM]` returns the value of a STATUS item that a plugin adds to `server.allowedStatus`, `(connection, mailbox)`
- `server.appendChecks` are consulted before APPEND, COPY and MOVE add messages to a mailbox, `(connection, mailbox, messages, options)`. A check returns nothing to allow it, or `{ code, text }` to fail the command with a tagged `NO [code] text` (`{ code, text, soft: true }` only sends an untagged `NO` warning)
- `server.closedChecks` are consulted when SELECT or EXAMINE closes the selected mailbox, `(connection)`. If any returns true, `* OK [CLOSED]` marks where the responses for the new mailbox start
- `server.copyHandlers` run when COPY, MOVE or RENAME INBOX copies a message, `(server, source, properties, mailbox)`. Properties set on `properties` are given to the copy before the message handlers run

#### Other possible operations

It is possible to append messages to a mailbox; create, delete and rename mailboxes; change authentication state and so on through the `server` and `connection` methods and properties. See existing command handlers and plugins for examples.

# License

Copyright (c) 2013-2026 Postal Systems OÜ

Licensed under the MIT license.
