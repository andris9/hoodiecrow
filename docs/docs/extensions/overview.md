---
title: Extensions Overview
sidebar_position: 1
description: How to enable ImapKit plugins, which IMAP extensions each built-in plugin implements, and what the core IMAP4rev1 server supports without any plugin.
---

# Extensions overview

ImapKit implements IMAP4rev1 ([RFC 3501](https://www.rfc-editor.org/rfc/rfc3501)) in its core. Every IMAP extension, including IMAP4rev2 itself, is a plugin that you turn on per server instance. A server without plugins is a plain IMAP4rev1 server, so you can test how your client behaves against a minimal server and against a server with every extension, using the same storage.

## Enabling plugins

Pass the plugin names in the `plugins` option:

```javascript
import imapkit from 'imapkit';

const server = imapkit({
    plugins: ['IDLE', 'MOVE', 'UIDPLUS', 'CONDSTORE', 'ENABLE']
});
await server.start(1143);
```

From the command line, use `--plugin` (repeated or comma separated) or the `IMAPKIT_PLUGINS` environment variable. A config file given with `--config` can list them in its `plugins` array too. See [Command line](../getting-started/command-line.md).

```bash
imapkit -p 1143 --plugin=IDLE,MOVE --plugin=CONDSTORE
IMAPKIT_PLUGINS=IDLE,MOVE imapkit -p 1143
```

Plugins are loaded when the server is created. They can not be loaded or unloaded while it runs.

### Plugin names

- Names are case-insensitive: `IDLE`, `idle` and `Idle` all load the same plugin.
- The name is the plugin's file name (`status-size`, `x-gm-ext-1`, `literalplus`), and the capability spelling works too where it differs: `LITERAL+`, `LITERAL-`, `AUTH=PLAIN`, `AUTH=XOAUTH2`, `AUTH=OAUTHBEARER`, `COMPRESS=DEFLATE`, `STATUS=SIZE`, `SORT=DISPLAY`, `THREAD=ORDEREDSUBJECT`, `THREAD=REFERENCES`, `UTF8=ACCEPT`, `CONTEXT=SEARCH` and `CONTEXT=SORT`.
- A plugin listed more than once is loaded once.
- An unknown name throws an error that lists the available plugins:

```text
Unknown plugin "FOO". Available plugins: acl, appendlimit, auth-plain, binary, ...
```

- Besides names, `plugins` accepts functions, which is how [custom plugins](../reference/custom-plugins.md) are loaded.

### Plugins that load other plugins

Some extensions are defined on top of others, so their plugins load what they need. The load order does not matter.

| Plugin                                                  | Also loads                                                                                                                                                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IMAP4rev2`                                             | ENABLE, NAMESPACE, UNSELECT, UIDPLUS, ESEARCH, SEARCHRES, IDLE, SASL-IR, LIST-EXTENDED, LIST-STATUS, MOVE, BINARY, SPECIAL-USE, STATUS=SIZE, AUTH=PLAIN, and LITERAL- unless LITERAL+ is loaded |
| `QRESYNC`                                               | ENABLE, CONDSTORE                                                                                                                                                                               |
| `UIDONLY`, `UTF8=ACCEPT`                                | ENABLE                                                                                                                                                                                          |
| `SEARCHRES`, `PARTIAL`, `MULTISEARCH`, `CONTEXT=SEARCH` | ESEARCH                                                                                                                                                                                         |
| `ESORT`                                                 | SORT, ESEARCH                                                                                                                                                                                   |
| `CONTEXT=SORT`                                          | ESORT, SORT, ESEARCH, CONTEXT=SEARCH                                                                                                                                                            |
| `SORT=DISPLAY`                                          | SORT                                                                                                                                                                                            |
| `LIST-STATUS`                                           | LIST-EXTENDED                                                                                                                                                                                   |

Plugins that can be turned on with `ENABLE` (CONDSTORE, QRESYNC, UIDONLY, UTF8=ACCEPT, IMAP4rev2, METADATA, METADATA-SERVER) work in any order with the ENABLE plugin. CONDSTORE also works without ENABLE, through `SELECT ... (CONDSTORE)` and the other commands that turn it on.

Some plugins only add to others when both are loaded: LIST-MYRIGHTS comes with ACL plus LIST-EXTENDED, the `SPECIAL-USE` LIST options combine with LIST-EXTENDED, `/private/specialuse` comes with METADATA plus SPECIAL-USE, and so on. Each page below lists these combinations.

### Combinations that throw

A few extensions exclude each other, and loading both throws an error when the server is created:

| Combination                    | Error                                                                         | Reason                                                 |
| ------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| `LITERAL+` and `LITERAL-`      | `LITERAL- can not be enabled together with LITERAL+` (or the other way round) | RFC 7888 section 5: a server must not advertise both   |
| `MESSAGELIMIT` and `SAVELIMIT` | `SAVELIMIT can not be enabled together with MESSAGELIMIT`                     | RFC 9738 section 3: a server advertises one of the two |

IMAP4rev2 loads LITERAL- only when LITERAL+ is not loaded, and a LITERAL+ loaded after it replaces that implied LITERAL-, so `['IMAP4rev2', 'LITERAL+']` works.

### Self-contained plugins

A plugin that is not loaded leaves no trace. Without CONDSTORE, messages have no MODSEQ value and `SELECT INBOX (CONDSTORE)` is answered with `BAD`. Without MOVE, `MOVE` is an unknown command. This lets you check that your client only uses what the server advertises.

The `no-uidplus` and `no-move` [quirk presets](../faults/quirk-presets.md) remove UIDPLUS and MOVE even when the plugin list names them.

### Capabilities

Every loaded plugin adds its capability to the `CAPABILITY` response, after `IMAP4rev1`. Some capabilities depend on the session state. For example `AUTH=PLAIN`, `SASL-IR` and `LOGINDISABLED` are only listed before login, `STARTTLS` only on a connection without TLS:

```text
C: A1 CAPABILITY
S: * CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR
S: A1 OK Completed
C: A2 AUTHENTICATE PLAIN AHRlc3R1c2VyAHRlc3RwYXNz
S: A2 OK User logged in
C: A3 CAPABILITY
S: * CAPABILITY IMAP4rev1
S: A3 OK Completed
```

## Built-in plugins

| Plugin                  | Capability                                                                         | RFC                                                                                            | Summary                                                       | Page                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `ACL`                   | `ACL`, `RIGHTS=texk`, `LIST-MYRIGHTS`                                              | [4314](https://www.rfc-editor.org/rfc/rfc4314), [8440](https://www.rfc-editor.org/rfc/rfc8440) | Access control lists, enforced for users other than the owner | [Access control](./access-control.md)                                             |
| `APPENDLIMIT`           | `APPENDLIMIT`, `APPENDLIMIT=<n>`                                                   | [7889](https://www.rfc-editor.org/rfc/rfc7889)                                                 | Largest message APPEND accepts, per server or per mailbox     | [Messages](./messages.md#appendlimit)                                             |
| `AUTH-PLAIN`            | `AUTH=PLAIN`                                                                       | [4616](https://www.rfc-editor.org/rfc/rfc4616)                                                 | `AUTHENTICATE PLAIN`                                          | [Authentication and transport](./authentication-and-transport.md#authplain)       |
| `BINARY`                | `BINARY`                                                                           | [3516](https://www.rfc-editor.org/rfc/rfc3516)                                                 | Decoded body parts in FETCH, literal8 messages in APPEND      | [Messages](./messages.md#binary)                                                  |
| `CATENATE`              | `CATENATE`, `URL-PARTIAL`                                                          | [4469](https://www.rfc-editor.org/rfc/rfc4469), [5550](https://www.rfc-editor.org/rfc/rfc5550) | APPEND builds a message from literals and IMAP URLs           | [Messages](./messages.md#catenate)                                                |
| `COMPRESS`              | `COMPRESS=DEFLATE`                                                                 | [4978](https://www.rfc-editor.org/rfc/rfc4978)                                                 | DEFLATE compression of the connection                         | [Authentication and transport](./authentication-and-transport.md#compressdeflate) |
| `CONDSTORE`             | `CONDSTORE`                                                                        | [7162](https://www.rfc-editor.org/rfc/rfc7162)                                                 | Mod-sequences, `CHANGEDSINCE`, `UNCHANGEDSINCE`               | [Synchronization](./synchronization.md#condstore)                                 |
| `CONTEXT-SEARCH`        | `CONTEXT=SEARCH`                                                                   | [5267](https://www.rfc-editor.org/rfc/rfc5267)                                                 | Updating search results, `CANCELUPDATE`                       | [Search and sort](./search-and-sort.md#contextsearch-and-contextsort)             |
| `CONTEXT-SORT`          | `CONTEXT=SORT`                                                                     | [5267](https://www.rfc-editor.org/rfc/rfc5267)                                                 | Updating sort results                                         | [Search and sort](./search-and-sort.md#contextsearch-and-contextsort)             |
| `CREATE-SPECIAL-USE`    | `CREATE-SPECIAL-USE`                                                               | [6154](https://www.rfc-editor.org/rfc/rfc6154)                                                 | `CREATE name (USE (...))`                                     | [Mailboxes](./mailboxes.md#create-special-use)                                    |
| `ENABLE`                | `ENABLE`                                                                           | [5161](https://www.rfc-editor.org/rfc/rfc5161)                                                 | The ENABLE command                                            | [Synchronization](./synchronization.md#enable)                                    |
| `ESEARCH`               | `ESEARCH`                                                                          | [4731](https://www.rfc-editor.org/rfc/rfc4731)                                                 | `SEARCH RETURN (MIN MAX ALL COUNT)`                           | [Search and sort](./search-and-sort.md#esearch)                                   |
| `ESORT`                 | `ESORT`                                                                            | [5267](https://www.rfc-editor.org/rfc/rfc5267)                                                 | `SORT RETURN (...)`                                           | [Search and sort](./search-and-sort.md#esort)                                     |
| `ID`                    | `ID`                                                                               | [2971](https://www.rfc-editor.org/rfc/rfc2971)                                                 | The ID command                                                | [Authentication and transport](./authentication-and-transport.md#id)              |
| `IDLE`                  | `IDLE`                                                                             | [2177](https://www.rfc-editor.org/rfc/rfc2177)                                                 | Push notifications while idling                               | [Synchronization](./synchronization.md#idle)                                      |
| `IMAP4rev2`             | `IMAP4rev2`                                                                        | [9051](https://www.rfc-editor.org/rfc/rfc9051)                                                 | IMAP4rev2 for sessions that ENABLE it                         | [IMAP4rev2](./imap4rev2.md)                                                       |
| `LIST-EXTENDED`         | `LIST-EXTENDED`                                                                    | [5258](https://www.rfc-editor.org/rfc/rfc5258)                                                 | LIST selection and return options                             | [Mailboxes](./mailboxes.md#list-extended)                                         |
| `LIST-STATUS`           | `LIST-STATUS`                                                                      | [5819](https://www.rfc-editor.org/rfc/rfc5819)                                                 | `LIST ... RETURN (STATUS (...))`                              | [Mailboxes](./mailboxes.md#list-status)                                           |
| `LITERALMINUS`          | `LITERAL-`                                                                         | [7888](https://www.rfc-editor.org/rfc/rfc7888)                                                 | Non-synchronizing literals up to 4096 octets                  | [Messages](./messages.md#literal-and-literal-)                                    |
| `LITERALPLUS`           | `LITERAL+`                                                                         | [7888](https://www.rfc-editor.org/rfc/rfc7888)                                                 | Non-synchronizing literals of any size                        | [Messages](./messages.md#literal-and-literal-)                                    |
| `LOGINDISABLED`         | `LOGINDISABLED`                                                                    | [3501](https://www.rfc-editor.org/rfc/rfc3501)                                                 | LOGIN refused without TLS                                     | [Authentication and transport](./authentication-and-transport.md#logindisabled)   |
| `MESSAGELIMIT`          | `MESSAGELIMIT=<n>`                                                                 | [9738](https://www.rfc-editor.org/rfc/rfc9738)                                                 | Commands work on at most n messages                           | [Messages](./messages.md#messagelimit-and-savelimit)                              |
| `METADATA`              | `METADATA`                                                                         | [5464](https://www.rfc-editor.org/rfc/rfc5464)                                                 | Server and mailbox annotations                                | [Metadata and quota](./metadata-and-quota.md#metadata)                            |
| `METADATA-SERVER`       | `METADATA-SERVER`                                                                  | [5464](https://www.rfc-editor.org/rfc/rfc5464)                                                 | Server annotations only                                       | [Metadata and quota](./metadata-and-quota.md#metadata-server)                     |
| `MOVE`                  | `MOVE`                                                                             | [6851](https://www.rfc-editor.org/rfc/rfc6851)                                                 | `MOVE` and `UID MOVE`                                         | [Messages](./messages.md#move)                                                    |
| `MULTIAPPEND`           | `MULTIAPPEND`                                                                      | [3502](https://www.rfc-editor.org/rfc/rfc3502)                                                 | Several messages in one APPEND                                | [Messages](./messages.md#multiappend)                                             |
| `MULTISEARCH`           | `MULTISEARCH`                                                                      | [7377](https://www.rfc-editor.org/rfc/rfc7377)                                                 | The ESEARCH command over several mailboxes                    | [Search and sort](./search-and-sort.md#multisearch)                               |
| `NAMESPACE`             | `NAMESPACE`                                                                        | [2342](https://www.rfc-editor.org/rfc/rfc2342)                                                 | The NAMESPACE command                                         | [Mailboxes](./mailboxes.md#namespace)                                             |
| `NOTIFY`                | `NOTIFY`                                                                           | [5465](https://www.rfc-editor.org/rfc/rfc5465)                                                 | Events for the selected and other mailboxes                   | [Synchronization](./synchronization.md#notify)                                    |
| `OAUTHBEARER`           | `AUTH=OAUTHBEARER`                                                                 | [7628](https://www.rfc-editor.org/rfc/rfc7628)                                                 | OAuth 2.0 bearer token login                                  | [Authentication and transport](./authentication-and-transport.md#oauthbearer)     |
| `OBJECTID`              | `OBJECTID`                                                                         | [8474](https://www.rfc-editor.org/rfc/rfc8474)                                                 | `MAILBOXID`, `EMAILID`, `THREADID`                            | [Synchronization](./synchronization.md#objectid)                                  |
| `PARTIAL`               | `PARTIAL`                                                                          | [9394](https://www.rfc-editor.org/rfc/rfc9394)                                                 | Paged SEARCH results and FETCH                                | [Search and sort](./search-and-sort.md#partial)                                   |
| `PREVIEW`               | `PREVIEW`                                                                          | [8970](https://www.rfc-editor.org/rfc/rfc8970)                                                 | The PREVIEW FETCH item                                        | [Messages](./messages.md#preview)                                                 |
| `QRESYNC`               | `QRESYNC`                                                                          | [7162](https://www.rfc-editor.org/rfc/rfc7162)                                                 | Quick resynchronization, `VANISHED`                           | [Synchronization](./synchronization.md#qresync)                                   |
| `QUOTA`                 | `QUOTA`, `QUOTA=RES-STORAGE`, `QUOTA=RES-MESSAGE`, `QUOTA=RES-MAILBOX`, `QUOTASET` | [9208](https://www.rfc-editor.org/rfc/rfc9208)                                                 | Quota roots, limits and `OVERQUOTA`                           | [Metadata and quota](./metadata-and-quota.md#quota)                               |
| `REPLACE`               | `REPLACE`                                                                          | [8508](https://www.rfc-editor.org/rfc/rfc8508)                                                 | `REPLACE` and `UID REPLACE`                                   | [Messages](./messages.md#replace)                                                 |
| `SASL-IR`               | `SASL-IR`                                                                          | [4959](https://www.rfc-editor.org/rfc/rfc4959)                                                 | Initial response in AUTHENTICATE                              | [Authentication and transport](./authentication-and-transport.md#sasl-ir)         |
| `SAVEDATE`              | `SAVEDATE`                                                                         | [8514](https://www.rfc-editor.org/rfc/rfc8514)                                                 | The save date of a message                                    | [Messages](./messages.md#savedate)                                                |
| `SAVELIMIT`             | `SAVELIMIT=<n>`                                                                    | [9738](https://www.rfc-editor.org/rfc/rfc9738)                                                 | COPY and APPEND of at most n messages                         | [Messages](./messages.md#messagelimit-and-savelimit)                              |
| `SEARCHRES`             | `SEARCHRES`                                                                        | [5182](https://www.rfc-editor.org/rfc/rfc5182)                                                 | `SEARCH RETURN (SAVE)` and `$`                                | [Search and sort](./search-and-sort.md#searchres)                                 |
| `SORT`                  | `SORT`                                                                             | [5256](https://www.rfc-editor.org/rfc/rfc5256)                                                 | `SORT` and `UID SORT`                                         | [Search and sort](./search-and-sort.md#sort)                                      |
| `SORT-DISPLAY`          | `SORT=DISPLAY`                                                                     | [5957](https://www.rfc-editor.org/rfc/rfc5957)                                                 | `DISPLAYFROM` and `DISPLAYTO` sort keys                       | [Search and sort](./search-and-sort.md#sortdisplay)                               |
| `SPECIAL-USE`           | `SPECIAL-USE`                                                                      | [6154](https://www.rfc-editor.org/rfc/rfc6154)                                                 | Special-use mailbox attributes                                | [Mailboxes](./mailboxes.md#special-use)                                           |
| `STARTTLS`              | `STARTTLS`                                                                         | [3501](https://www.rfc-editor.org/rfc/rfc3501)                                                 | The STARTTLS command                                          | [Authentication and transport](./authentication-and-transport.md#starttls)        |
| `STATUS-SIZE`           | `STATUS=SIZE`                                                                      | [8438](https://www.rfc-editor.org/rfc/rfc8438)                                                 | The SIZE STATUS item                                          | [Mailboxes](./mailboxes.md#statussize)                                            |
| `THREAD-ORDEREDSUBJECT` | `THREAD=ORDEREDSUBJECT`                                                            | [5256](https://www.rfc-editor.org/rfc/rfc5256)                                                 | THREAD with the ORDEREDSUBJECT algorithm                      | [Search and sort](./search-and-sort.md#thread)                                    |
| `THREAD-REFERENCES`     | `THREAD=REFERENCES`                                                                | [5256](https://www.rfc-editor.org/rfc/rfc5256)                                                 | THREAD with the REFERENCES algorithm                          | [Search and sort](./search-and-sort.md#thread)                                    |
| `UIDONLY`               | `UIDONLY`                                                                          | [9586](https://www.rfc-editor.org/rfc/rfc9586)                                                 | No message sequence numbers after ENABLE                      | [Synchronization](./synchronization.md#uidonly)                                   |
| `UIDPLUS`               | `UIDPLUS`                                                                          | [4315](https://www.rfc-editor.org/rfc/rfc4315)                                                 | `APPENDUID`, `COPYUID`, `UID EXPUNGE`                         | [Messages](./messages.md#uidplus)                                                 |
| `UNAUTHENTICATE`        | `UNAUTHENTICATE`                                                                   | [8437](https://www.rfc-editor.org/rfc/rfc8437)                                                 | Back to the Not Authenticated state                           | [Authentication and transport](./authentication-and-transport.md#unauthenticate)  |
| `UNSELECT`              | `UNSELECT`                                                                         | [3691](https://www.rfc-editor.org/rfc/rfc3691)                                                 | Close a mailbox without expunging                             | [Mailboxes](./mailboxes.md#unselect)                                              |
| `UTF8-ACCEPT`           | `UTF8=ACCEPT`                                                                      | [9755](https://www.rfc-editor.org/rfc/rfc9755)                                                 | UTF-8 mailbox names and strings after ENABLE                  | [Messages](./messages.md#utf8accept)                                              |
| `X-GM-EXT-1`            | `X-GM-EXT-1`                                                                       | [Gmail](https://developers.google.com/workspace/gmail/imap/imap-extensions)                    | Gmail message ids, thread ids, labels and `X-GM-RAW`          | [Gmail](./gmail.md)                                                               |
| `XOAUTH2`               | `AUTH=XOAUTH2`                                                                     | [Google](https://developers.google.com/gmail/imap/xoauth2-protocol)                            | Gmail style OAuth 2.0 login                                   | [Authentication and transport](./authentication-and-transport.md#xoauth2)         |

The Plugin column shows the file name spelling. The capability spellings listed under [Plugin names](#plugin-names) work as well, and so do the spellings with `=` for the names that have it (`CONTEXT=SEARCH`, `SORT=DISPLAY`, `STATUS=SIZE`, `UTF8=ACCEPT` ...). `imapkit --help` prints the same list with a short description of every plugin.

## What core IMAP4rev1 supports

Without any plugin, ImapKit supports every RFC 3501 command: `CAPABILITY`, `NOOP`, `LOGOUT`, `LOGIN`, `AUTHENTICATE` (no mechanism is built in, so it answers `NO Unsupported authentication mechanism` until an AUTH plugin is loaded), `SELECT`, `EXAMINE`, `CREATE`, `DELETE`, `RENAME`, `SUBSCRIBE`, `UNSUBSCRIBE`, `LIST`, `LSUB`, `STATUS`, `APPEND`, `CHECK`, `CLOSE`, `EXPUNGE`, `SEARCH`, `FETCH`, `STORE`, `COPY` and the `UID` variants of `COPY`, `FETCH`, `STORE` and `SEARCH`. `STARTTLS` is a plugin.

Some choices that the RFCs leave to the server:

- The subscription list holds names, not mailboxes (RFC 3501 section 6.3.6). DELETE does not unsubscribe, so LSUB and `LIST (SUBSCRIBED)` keep listing the name until UNSUBSCRIBE, and a mailbox created again under that name is subscribed. RENAME leaves the subscription with the old name. A mailbox from the storage object is subscribed unless it has `"subscribed": false`, a new mailbox is not. SUBSCRIBE refuses names that are not mailboxes, UNSUBSCRIBE accepts any name.
- CREATE `a/b` also creates `a` as a normal mailbox if it does not exist (RFC 3501 section 6.3.3). An existing `\Noselect` level stays `\Noselect`.
- DELETE of a mailbox with children leaves a `\Noselect` level that keeps nothing but the children. CREATE of that name makes a new mailbox with a new UIDVALIDITY.
- A keyword stays in the FLAGS and PERMANENTFLAGS of a mailbox once a message in it had the keyword, also after that message is expunged (RFC 3501 section 7.2.6).
- SEARCH, SORT and THREAD support the `US-ASCII` and `UTF-8` charsets. Any other charset gets `NO [BADCHARSET (US-ASCII UTF-8)]`.

The [Mailboxes](./mailboxes.md#core-list-lsub-and-subscriptions) page shows these in transcripts, and [Strict by design](../guides/strict-by-design.md) lists what the core refuses.
