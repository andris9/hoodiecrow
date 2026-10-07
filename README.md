# Hoodiecrow

![Hoodiecrow](https://raw.githubusercontent.com/postalsys/hoodiecrow-imap/master/hoodiecrow_actual.jpg)

## About

Hoodiecrow is a scriptable IMAP server for client integration testing. It offers [IMAP4ver1](http://tools.ietf.org/html/rfc3501) support and some optional plugins that can be turned on and off. Nothing is ever written to disk, so when you restart the server, the original state is restored.

[![Run Tests](https://github.com/postalsys/hoodiecrow-imap/actions/workflows/test.yml/badge.svg)](https://github.com/postalsys/hoodiecrow-imap/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/hoodiecrow-imap)](https://www.npmjs.com/package/hoodiecrow-imap)
[![license](https://img.shields.io/npm/l/hoodiecrow-imap)](https://github.com/postalsys/hoodiecrow-imap/blob/master/LICENSE)

Hoodiecrow requires Node.js 20 or newer.

> Hoodiecrow is maintained by the team behind **[EmailEngine](https://emailengine.app/?utm_source=hoodiecrow-readme&utm_medium=readme&utm_campaign=oss-docs&utm_content=note)**, a self-hosted email API that turns Gmail, Microsoft 365, and IMAP accounts into REST endpoints, with managed OAuth2 and webhooks for incoming mail. If you need a production email integration rather than a mock IMAP server for tests, start there.

# Usage

### Run as a standalone server

To run Hoodiecrow you need [Node.js](http://nodejs.org/) in your machine. Node should work on almost any platform, so Hoodiecrow should too.

If you have Node.js installed, install Hoodiecrow with the `npm` command and run it:

```bash
npm install -g hoodiecrow-imap
sudo hoodiecrow
```

Sudo is needed to bind to port 143. If you choose to use a higher port, say 1143 (`hoodiecrow -p 1143`), you do not need to use sudo.

`hoodiecrow` command also provides an incoming SMTP server which appends all incoming messages
automatically to INBOX. To use it, use _smtpPort_ option (`hoodiecrow --smtpPort=1025`).

> **Protip** Running `hoodiecrow --help` displays useful information about command line options for Hoodiecrow and some sample configuration data.

After you have started Hoodiecrow server, you can point your IMAP client to `localhost:143`. Use `"testuser"` as user name and `"testpass"` as password to log in to the server.

### Include as a Node.js module

Add `hoodiecrow-imap` dependency

```bash
npm install hoodiecrow-imap
```

Create and start an IMAP server

```javascript
const hoodiecrow = require('hoodiecrow-imap');
const server = hoodiecrow(options);
server.listen(143);
```

See [complete.js](https://github.com/postalsys/hoodiecrow-imap/blob/master/examples/complete.js) for an example.

## Scope

Hoodiecrow is a single user / multiple connections IMAP server that uses a JSON object as its directory and messages structure. Nothing is read from or written to disk and the entire directory structure is instantiated every time the server is started, eg. changes made through the IMAP protocol (adding/removing messages/flags etc) are not saved permanently. This should ensure that you can write integration tests for clients in a way where a new fresh server with unmodified data is started for every test.

Several clients can connect to the server simultanously but all the clients share the same user account, even if login credentials are different. The ACL plugin can limit what users other than the owner can do (see [ACL](#acl)).

Hoodiecrow is extendable, any command can be overwritten, plugins can be added etc (see command folder for built in command examples and plugin folder for plugin examples).

## Strict by design

Hoodiecrow is meant for developing standards compliant IMAP clients, so it follows the RFCs strictly instead of accepting whatever clients send. Most production servers are lenient, which hides client bugs until the client meets a stricter server. Hoodiecrow answers these with `BAD` (or `NO` where the RFC requires it):

- commands sent in the wrong state (RFC 3501 section 3), for example `FETCH` before `SELECT` or `LOGIN` after login
- arguments to commands that take none (`NOOP x`, `CLOSE x`), missing or extra arguments, and values that break the RFC 3501 grammar
- command lines that end with a bare LF instead of CRLF
- literal data sent before the server's `+` continuation request (RFC 3501 section 4.3); `{n+}` is only accepted when LITERAL+ or LITERAL- is enabled, and with LITERAL- only up to 4096 octets, a larger one is answered with `BAD [TOOBIG]` (RFC 7888 section 5)
- literals for unknown commands, or for commands that can not run in the current state, are refused without a continuation request
- mailbox names that are not valid modified UTF-7 (RFC 3501 section 5.1.3), including 8-bit names
- invalid sequence sets (`0`, `abc`), flags that are not atoms, `\Recent` in STORE or APPEND, invalid dates
- 8-bit SEARCH strings without `CHARSET UTF-8`, invalid UTF-8, unsupported charsets (`NO [BADCHARSET]`)
- SORT and THREAD (RFC 5256 section 5) with a charset that is not an atom or a quoted string, an empty sort criteria list, `REVERSE` that is not followed by a sort key (`REVERSE REVERSE DATE`), or a threading algorithm that is not an atom
- invalid base64 in SASL exchanges, and anything other than `DONE` while IDLE
- OAUTHBEARER client responses that break the RFC 7628 or GS2 (RFC 5801) grammar, and anything other than a single `%x01` after an OAUTHBEARER error result
- commands pipelined after `COMPRESS` (RFC 4978 section 3), and `COMPRESS` while compression is active (`BAD [COMPRESSIONACTIVE]`)
- pipelined commands that RFC 3501 section 5.5 calls ambiguous, for example `CHECK` followed by `FETCH` without waiting for the `CHECK` result
- `ENABLE` after `SELECT` or `EXAMINE` (RFC 5161 section 3.1), and `ID` lists that break the RFC 2971 limits
- unknown `SEARCH RETURN` options or `RETURN` after `CHARSET` (RFC 4466 section 2.6.1), `$` combined with numbers, and `SEARCH MODSEQ` values or entry names that break the RFC 7162 grammar
- extended LIST commands (RFC 5258) with unknown options, `RECURSIVEMATCH` without a base option like `SUBSCRIBED` (also `(SPECIAL-USE RECURSIVEMATCH)`, RFC 6154 section 6), an empty pattern list, options with values they do not take, a repeated `STATUS` return option with different items, and invalid `STATUS` items (RFC 5819)
- METADATA entry names that break RFC 5464 section 3.2 (`//`, a trailing `/`, `*`, `%`, 8-bit or control characters, a scope other than `/private` or `/shared`), values that are atoms or use bare CR or LF as line ends, empty entry or option lists, and GETMETADATA options after the mailbox name (errata 2785)
- unknown or uppercase ACL rights, and empty identifiers or identifiers with control characters or invalid UTF-8 (RFC 4314 section 3)
- more than one message in `APPEND` without MULTIAPPEND, and with MULTIAPPEND a zero-length message literal cancels the whole `APPEND` with `NO` (RFC 3502)
- CATENATE URLs that are not absolute-path references (`/INBOX/;UID=1`), including relative-path references like `;UID=1` that RFC 5092 section 7.2 forbids, and URLs of message parts that do not exist (`NO [BADURL ...]`)

Responses follow the grammar strictly too: strings that can not be quoted are sent as literals.

## Authentication

An user can always login with username `"testuser"` and password `"testpass"`. Any other credentials can be added as needed.

## Status

### IMAP4rev1

All commands are supported but might be a bit buggy

### Supported Plugins

Plugins can be enabled when starting the server but can not be unloaded or loaded when the server is already running.
All plugins are self contained and not tied to core. If you do not enable a plugin, no trace of it is left
to the system. For example, if you do not enable CONDSTORE, messages do not have a MODSEQ value set.
Plugin names are case insensitive and capability spellings like `LITERAL+` or `AUTH=PLAIN` are accepted too.
An unknown plugin name throws an error, and a plugin listed more than once is loaded only once.

- **ACL** Adds ACL [RFC4314] capability with `RIGHTS=texk` (SETACL, DELETEACL, GETACL, LISTRIGHTS and MYRIGHTS), and LIST-MYRIGHTS [RFC8440] when LIST-EXTENDED is loaded. See [ACL](#acl) below
- **APPENDLIMIT** Adds APPENDLIMIT [RFC7889] capability. The server option `appendLimit` (octets) sets the limit for every mailbox and is advertised as `APPENDLIMIT=<n>`. A mailbox in the storage can set its own `appendLimit` (a number, or `null` for no limit), then the capability is advertised without a value and clients read the limits with `STATUS (APPENDLIMIT)`. Larger messages in APPEND and REPLACE fail with `NO [TOOBIG]`, synchronizing literals are refused before the client sends them
- **AUTH-PLAIN** Adds AUTH=PLAIN capability. Supports SASL-IR [RFC4959] as well
- **COMPRESS** Adds COMPRESS=DEFLATE [RFC4978] capability. Raw DEFLATE in both directions after the tagged OK, every burst of responses ends with a sync flush
- **CATENATE** Adds CATENATE [RFC4469] and URL-PARTIAL [RFC5550] capabilities. APPEND (and REPLACE) can build a message from literals and IMAP URLs of messages or message parts on the server. Only absolute-path URLs are accepted, for example `/INBOX;UIDVALIDITY=1/;UID=2/;SECTION=1.MIME/;PARTIAL=0.100`, other URLs and URLs that do not resolve fail with `NO [BADURL ...]`. A message over the literal size limit fails with `NO [TOOBIG]`. Plugins can refuse URLs of a mailbox through `server.urlAccessChecks`
- **CONDSTORE** Adds CONDSTORE [RFC7162] support, including the `SEARCH MODSEQ` search key
- **CREATE-SPECIAL-USE** Enables CREATE-SPECIAL-USE [RFC6154] capability. Allowed special flags can be set with server option `"special-use"`
- **ESEARCH** Adds ESEARCH [RFC4731] capability: `SEARCH RETURN (MIN MAX ALL COUNT)` and `UID SEARCH RETURN (...)` answer with an ESEARCH response. With CONDSTORE the response includes `MODSEQ` for a `MODSEQ` search
- **ENABLE** Adds ENABLE capability [RFC5161]. Can be loaded in any order with the plugins it enables (eg. CONDSTORE)
- **ID** Adds ID [RFC2971] capability
- **IDLE** Adds IDLE [RFC2177] capability
- **LIST-EXTENDED** Adds LIST-EXTENDED [RFC5258]: selection options `SUBSCRIBED`, `REMOTE` (there are no remote mailboxes) and `RECURSIVEMATCH`, return options `SUBSCRIBED` and `CHILDREN`, multiple mailbox patterns and the `CHILDINFO` extended data item. `\Noselect` mailboxes are listed as `\NonExistent` in extended LIST responses. With SPECIAL-USE loaded, the `SPECIAL-USE` selection and return options [RFC6154] combine with the other options. The plain RFC 3501 LIST is not changed
- **LIST-STATUS** Adds LIST-STATUS [RFC5819], the `STATUS` return option of LIST. Loads LIST-EXTENDED as well
- **LITERALMINUS** Enables LITERAL- [RFC7888] capability: non-synchronizing literals up to 4096 octets. A larger one is read and dropped, and the command is answered with `BAD [TOOBIG]`. Can not be loaded together with LITERALPLUS
- **LITERALPLUS** Enables LITERAL+ [RFC7888] capability. Can not be loaded together with LITERALMINUS
- **LOGINDISABLED** Disables LOGIN support for unencrypted connections
- **METADATA** Adds METADATA [RFC5464] capability (GETMETADATA and SETMETADATA) for server and mailbox annotations. Initial mailbox entries come from a `metadata` object on the mailbox in storage (`"INBOX": { "metadata": { "/private/comment": "My comment" } }`), server entries from the `metadata` option. Server options `metadataMaxSize` (largest value in octets, default 65536), `metadataMaxEntries` (entries per mailbox and for the server, default 100) and `metadataPrivate: false` (refuse `/private` entries with `[METADATA NOPRIVATE]`) let you test the client's error handling. `/shared/admin` on the server is read-only. Annotations move with RENAME (renaming INBOX copies them), DELETE removes them. After `ENABLE METADATA` (needs the ENABLE plugin), changes made by other sessions are announced with unsolicited `METADATA` responses. With SPECIAL-USE loaded, the read-only `/private/specialuse` entry shows the special-use attributes of a mailbox (RFC 6154 section 4). Values are text, binary values (`literal8`) are not supported
- **METADATA-SERVER** Same as METADATA, but only for server annotations (mailbox name `""`)
- **MOVE** Adds MOVE [RFC6851] capability (MOVE and UID MOVE commands)
- **MULTIAPPEND** Adds MULTIAPPEND [RFC3502] capability. APPEND takes several messages and appends all or none of them. With UIDPLUS, APPENDUID lists the UIDs as a UID set
- **NAMESPACE** Adds NAMESPACE [RFC2342] capability
- **OAUTHBEARER** Adds AUTH=OAUTHBEARER [RFC7628] capability, with or without SASL-IR. Uses the same credentials as XOAUTH2: access token `"testtoken"`, the authzid in the GS2 header (`n,a=testuser,`) is optional. A failed login gets the JSON error result as a continuation request (`invalid_token` or `invalid_request`), the client must answer it with `AQ==` (a single `%x01`)
- **OBJECTID** Adds OBJECTID [RFC8474] capability: `MAILBOXID` for CREATE, SELECT, EXAMINE and STATUS, `EMAILID` and `THREADID` for FETCH and SEARCH. Ids are generated (`F1`, `M1`, `T1`, ...) unless the storage sets a `MAILBOXID` for a mailbox or an `EMAILID` / `THREADID` for a message. COPY, MOVE and RENAME INBOX keep the EMAILID and THREADID of a message. Messages are threaded by their `Message-ID`, `In-Reply-To` and `References` headers across all mailboxes, a message joins the thread of the nearest known parent when it is added
- **PREVIEW** Adds PREVIEW [RFC8970] capability (the PREVIEW FETCH data item with the LAZY modifier). Previews are generated from the first text/plain or text/html part (text/plain preferred in multipart/alternative, attachments, attached messages and encrypted content are skipped): transfer encoding and charset are decoded, HTML markup and quoted text are removed, whitespace is collapsed and the result is cut to 200 characters. A message in storage can set its own `"preview"` string instead. `PREVIEW (LAZY)` returns NIL until the preview of the message has been generated by a FETCH without LAZY, or comes from storage
- **QUOTA** Adds QUOTA [RFC9208] capability with `GETQUOTA`, `GETQUOTAROOT`, `SETQUOTA` (`QUOTASET`), the `STORAGE`, `MESSAGE` and `MAILBOX` resources and the `DELETED` and `DELETED-STORAGE` STATUS items. INBOX and the personal namespaces share one quota root, other namespaces have none. Configure it with the `quota` server option, eg. `{ "root": "User quota", "STORAGE": 10240, "MESSAGE": 1000, "MAILBOX": 100, "soft": false }` (STORAGE is in units of 1024 octets, a missing resource is not limited). APPEND, COPY and MOVE (from outside the quota root) fail with `NO [OVERQUOTA]` when they would go over a limit, and CREATE or RENAME INBOX when they would go over the MAILBOX limit. With `"soft": true` they succeed with an untagged `NO [OVERQUOTA]` warning instead. `SETQUOTA` changes the limits at runtime
- **REPLACE** Adds REPLACE [RFC8508] capability (REPLACE and UID REPLACE commands). With UIDPLUS, APPENDUID is sent in an untagged OK before the EXPUNGE. With QUOTA only the net usage counts (RFC 8508 section 3.4)
- **SASL-IR** Enables SASL-IR [RFC4959] capability
- **SAVEDATE** Adds SAVEDATE [RFC8514] capability: the `SAVEDATE` FETCH item and the `SAVEDBEFORE`, `SAVEDON`, `SAVEDSINCE` and `SAVEDATESUPPORTED` SEARCH keys. APPEND, COPY and MOVE set the save date to the current time, messages in storage can set it with a `SAVEDATE` value (a date-time string or a Date) and get the time the server was started otherwise. A mailbox with `"SAVEDATE": false` in storage does not support save dates: FETCH returns NIL and the SEARCH keys use the internal date
- **SEARCHRES** Adds SEARCHRES [RFC5182] capability, also loads ESEARCH: `SEARCH RETURN (SAVE)` stores the result and `$` refers to it in FETCH, STORE, COPY, MOVE, UID EXPUNGE, SEARCH and their UID variants. `$` must be used alone, not combined with numbers like `1,$`
- **SORT** Adds SORT [RFC5256] capability (SORT and UID SORT with all RFC 5256 sort keys). Strings are compared with the i;unicode-casemap collation (RFC 5051), base subjects follow RFC 5256 section 2.1 and sent dates section 2.2. With CONDSTORE, a MODSEQ search key appends the highest mod-sequence (RFC 7162 section 3.1.9). I18NLEVEL=1 is not advertised, as SEARCH matches strings with ASCII case folding only
- **SORT=DISPLAY** Adds SORT=DISPLAY [RFC5957] capability (DISPLAYFROM and DISPLAYTO sort keys), also loads SORT
- **SPECIAL-USE** Enables SPECIAL-USE [RFC6154] capability Mailboxes need to have a "special-use" property (String or Array) that will be used as extra flag for LIST and LSUB responses
- **STARTTLS** Adds STARTTLS command
- **STATUS=SIZE** Adds STATUS=SIZE [RFC8438], the `SIZE` status item (also with LIST-STATUS). The plugin file is `status-size`
- **THREAD=ORDEREDSUBJECT** Adds THREAD=ORDEREDSUBJECT [RFC5256] capability (THREAD and UID THREAD)
- **THREAD=REFERENCES** Adds THREAD=REFERENCES [RFC5256] capability (THREAD and UID THREAD), the full REFERENCES algorithm of RFC 5256 section 3. Load both THREAD plugins to support both algorithms
- **UIDPLUS** Adds UIDPLUS [RFC4315] capability (APPENDUID, COPYUID and UID EXPUNGE)
- **UNAUTHENTICATE** Adds UNAUTHENTICATE [RFC8437] capability. Returns to the Not Authenticated state and resets the session: the selected mailbox is closed without expunging, ENABLEd extensions and CONDSTORE are turned off, and COMPRESS ends after the tagged OK. TLS stays
- **UNSELECT** Adds UNSELECT [RFC3691] capability
- **X-GM-EXT-1** Adds partial support for [Gmail specific](https://developers.google.com/workspace/gmail/imap/imap-extensions) options. `X-GM-MSGID` is fully supported, `X-GM-LABELS` is partially supported (labels can be STOREd and FETCHed but setting a label does not change message behavior, for example the message does not get copied to another mailbox). `X-GM-THRID` is supported: every message is its own thread unless the storage sets an `X-GM-THRID` value for it. `X-GM-RAW` is not supported.
- **XOAUTH2** GMail XOAUTH2 login. Only works with SALS-IR, if you need non SASL-IR support as well, let me know. Use `"testuser"` as the username and `"testtoken"` as Access Token to log in.
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
- APPEND and COPY need `i` on the target and keep only the flags the user has rights for. MOVE also needs `t` and `e` on the source (RFC 6851 section 4.2)
- EXPUNGE needs `e`, CLOSE without `e` closes the mailbox without expunging
- CREATE needs `k` on the nearest existing parent (so other users can not create top level mailboxes), DELETE needs `x`, RENAME needs `x` on the mailbox and `k` on the new parent
- GETACL, SETACL, DELETEACL and LISTRIGHTS need `a`, MYRIGHTS needs any of `l`, `r`, `i`, `k`, `x`, `a`
- with LIST-STATUS, mailboxes without `r` get no STATUS response and are listed with `\Noselect` (RFC 5819 section 2)
- with METADATA, GETMETADATA and SETMETADATA on a mailbox need `l` and any of `r`, `s`, `w`, `i`, `p` (RFC 5464 section 3.3), and unsolicited METADATA responses only go to sessions with these rights
- with QUOTA, GETQUOTAROOT only lists the MAILBOX resource without `r` on the mailbox, and SETQUOTA needs `a` on every mailbox of the quota root (RFC 9208 section 6)

Missing rights are answered with `NO [NOPERM]`, or with the same error as for a mailbox that does not exist when the user does not have `l` either, so the existence of the mailbox is not disclosed (RFC 4314 section 6). The rights on the selected mailbox are taken when it is selected. A new mailbox inherits the ACL of its parent and DELETE removes the ACL. The obsolete `c` and `d` rights are accepted as `kx` and `et` and are added to ACL and MYRIGHTS responses (RFC 4314 section 2.1.1). The rights of the owner can not be changed.

## Existing XTOYBIRD commands

To use these functions, XTOYBIRD plugin needs to be enabled and the client needs to be logged in

Available commands:

- **XTOYBIRD SERVER** dumps server internals
- **XTOYBIRD CONNECTION** dumps connection internals
- **XTOYBIRD STORAGE** dumps storage as JSON
- **XTOYBIRD USERADD "username" "password"** adds or updates user
- **XTOYBIRD USERDEL "username"** removes an user
- **XTOYBIRD SHUTDOWN** Closes the server after the last client disconnects. New connections are rejected.

Example usage for XTOYBIRD STORAGE:

```
S: * Hoodiecrow ready for rumble
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

## Useful features for Hoodiecrow I'd like to see

- An ability to change UIDVALIDITY at runtime (eg. `A1 XTOYBIRD UIDVALIDITY INBOX 123` where 123 is the new UIDVALIDITY for INBOX)
- An ability to change available disk space (eg. `A1 XTOYBIRD DISKSPACE 100 50` where 100 is total disk space in bytes and 50 is available space)
- An ability to restart the server to return initial state (`A1 XTOYBIRD RESET`)
- An ability to change storage runtime by sending a JSON string describing the entire storage (`A1 XTOYBIRD UPDATE {123}\r\n{"INBOX":{...}})`)

## CONDSTORE support

- All messages have MODSEQ value
- CONDSTORE can be ENABLEd
- SELECT/EXAMINE show HIGHESTMODSEQ
- SELECT/EXAMINE support (CONDSTORE) option
- Updating flags increments MODSEQ value
- FETCH (MODSEQ) works
- FETCH (CHANGEDSINCE modseq) works
- STORE (UNCHANGEDSINCE modseq) partially works (edge cases are not covered)
- SEARCH MODSEQ works, the entry name and type are checked but ignored since MODSEQ is not stored per flag

# Known issues

- **STORE** does not emit notifications to other clients
- **MODSEQ** updates are not notified
- **addr-adl** (at-domain-list) values are not supported, NIL is always used
- **anonymous namespaces** are not supported
- **STORE** returns NO and nothing is updated if there are pending EXPUNGE messages
- **CHARSET** values other than US-ASCII and UTF-8 are not supported

# Running tests

Tests use the built-in Node.js test runner, linting uses ESLint and formatting uses Prettier.

    npm install
    npm test            # lint + all tests
    npm run test:unit   # tests only
    node --test test/fetch.js   # a single test file
    npm run format      # apply Prettier formatting

## Example configs

### Cyrus

config.json:

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

config.json:

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

## Use Hoodiecrow for testing your client

Creating your tests in Node.js is a piece of cake, you do not even need to run the `hoodiecrow` command. Here is a sample test using the built-in [Node.js test runner](https://nodejs.org/api/test.html).

```javascript
const { describe, it, beforeEach, afterEach } = require('node:test');
const hoodiecrow = require('hoodiecrow-imap');
const myIMAPClient = require('../my-imap-client');

describe('IMAP tests', () => {
    let server;

    // Executed before every test, creates a new blank IMAP server
    // on a random free port
    beforeEach((t, done) => {
        server = hoodiecrow();
        server.listen(0, done);
    });

    // Executed after every test, closes the IMAP server created for the test
    afterEach((t, done) => {
        server.close(done);
    });

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

## Creating custom plugins

A plugin can be a string as a pointer to a built in plugin or a function. Plugin function is run when the server is created and gets server instance object as an argument.

```javascript
hoodiecrow({
    // Add two plugins, built in "IDLE" and custom function
    plugin: ['IDLE', myAwesomePlugin]
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

### Plugin mehtods

#### Add a capability

    server.registerCapability(name[, availabilty])

Where

- **name** a string displayed in the capability response
- **availability** a function which returns boolean value. Executed before displaying the capability response. If the function returns true, the capability is displayed, if false then not.

Example

```javascript
// Display in CAPABILITY only in Not Authenticated state
server.registerCapability('XAUTH', function (connection) {
    return connection.state == 'Not Authenticated';
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

    Without options, a command that already exists (such as a built-in one that the handler wraps) keeps its settings.

Handler arguments

- **connection** - Session instance
- **parsed** - Input from the client in structured form (see [imap-handler](https://github.com/postalsys/imap-handler#parse-imap-commands) for reference)
- **data** - Input command as a binary string
- **callback** - callback function to run (does not take any arguments)

The command should send data to the client with `connection.send()`

    connection.send(response, description, parsed, data, /* any additional data */)

Where

- **response** is a [imap-handler](https://github.com/postalsys/imap-handler#parse-imap-commands) compatible object. To get the correct tag for responsing OK, NO or BAD, look into `parsed.tag`
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
var list = server.getCommandHandler('LIST');
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

See [idle.js](https://github.com/postalsys/hoodiecrow-imap/blob/master/lib/plugins/idle.js) for an example

Raw output, such as a `+` continuation request, goes through `connection.write(data)`, and `connection.end()` closes the connection once all output is written. Do not use `connection.socket` for this, a COMPRESS layer (`connection.transport`) sits between the protocol and the socket.

#### Reset session state

UNAUTHENTICATE (RFC 8437) returns a connection to the Not Authenticated state. A plugin that keeps per-session state on the connection object adds a handler that clears it:

```javascript
server.resetHandlers.push(function (connection) {
    connection.mySessionState = false;
});
```

#### Override output

Any response sent to the client can be overriden or cancelled by other handlers. You should append your handler to `server.outputHandlers` array. If something is being sent to the client, the response object is passed through all handlers in this array.

    server.outputHandlers.push(function(connection, /* arguments from connection.send */){})

`response` arguments from `connection.send` is an object and thus any modifications will be passed on. If `skipResponse` property is added to the response object, the data is not sent to the client.

```javascript
// All untagged responses are ignored and not passed to the client
server.outputHandlers.push(function (connection, response, description) {
    if (response.tag == '*') {
        response.skipResponse = true;
        console.log('Ignoring untagged response for %s', description);
    }
});
```

#### Other extension points

- `server.messageHandlers` and `server.mailboxHandlers` run on every message and mailbox when it is loaded from storage or created, `(server, message, mailbox)` and `(server, mailbox)`
- `server.statusHandlers[ITEM]` returns the value of a STATUS item that a plugin adds to `server.allowedStatus`, `(connection, mailbox)`
- `server.appendChecks` are consulted before APPEND, COPY and MOVE add messages to a mailbox, `(connection, mailbox, messages, options)`. A check returns nothing to allow it, or `{ code, text }` to fail the command with a tagged `NO [code] text` (`{ code, text, soft: true }` only sends an untagged `NO` warning)
- `server.copyHandlers` run when COPY, MOVE or RENAME INBOX copies a message, `(server, source, properties, mailbox)`. Properties set on `properties` are given to the copy before the message handlers run

#### Other possbile operations

It is possible to append messages to a mailbox; create, delete and rename mailboxes; change authentication state and so on through the `server` and `connection` methods and properties. See existing command handlers and plugins for examples.

# License

Copyright (c) 2013-2026 Postal Systems OÜ

Licensed under the MIT license.
