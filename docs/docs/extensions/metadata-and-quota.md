---
title: Metadata and Quota
sidebar_position: 7
description: The METADATA, METADATA-SERVER and QUOTA plugins of ImapKit, with the metadata, metadataMaxSize, metadataMaxEntries, metadataPrivate and quota server options.
---

# Metadata and quota

| Plugin            | Capability                                                                         | RFC                                                |
| ----------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------- |
| `METADATA`        | `METADATA`                                                                         | [RFC 5464](https://www.rfc-editor.org/rfc/rfc5464) |
| `METADATA-SERVER` | `METADATA-SERVER`                                                                  | [RFC 5464](https://www.rfc-editor.org/rfc/rfc5464) |
| `QUOTA`           | `QUOTA`, `QUOTA=RES-STORAGE`, `QUOTA=RES-MESSAGE`, `QUOTA=RES-MAILBOX`, `QUOTASET` | [RFC 9208](https://www.rfc-editor.org/rfc/rfc9208) |

APPENDLIMIT, the other size limit a server can announce, is on the [Messages](./messages.md#appendlimit) page.

## METADATA

Adds `GETMETADATA` and `SETMETADATA` for server annotations (mailbox name `""`) and mailbox annotations. Loads ENABLE, which [RFC 5464 section 4.1](https://www.rfc-editor.org/rfc/rfc5464#section-4.1) requires for the unsolicited METADATA responses.

| Option               | Default | Effect                                                                     |
| -------------------- | ------- | -------------------------------------------------------------------------- |
| `metadata`           | none    | Initial server annotations, an object of entry names and string values     |
| `metadataMaxSize`    | `65536` | Largest value in octets. A larger value gets `NO [METADATA MAXSIZE n]`     |
| `metadataMaxEntries` | `100`   | Entries per mailbox, and for the server. Above it, `NO [METADATA TOOMANY]` |
| `metadataPrivate`    | `true`  | `false` refuses `/private` entries with `NO [METADATA NOPRIVATE]`          |

Initial mailbox annotations come from a `metadata` object on the mailbox in the storage:

```javascript
const server = imapkit({
    plugins: ['METADATA', 'SPECIAL-USE'],
    metadata: { '/shared/admin': 'mailto:admin@example.com' },
    metadataMaxSize: 16,
    storage: {
        INBOX: { metadata: { '/private/comment': 'My inbox' } },
        '': { separator: '/', folders: { Sent: { 'special-use': '\\Sent' } } }
    }
});
```

```text
C: A3 GETMETADATA "" /shared/admin
S: * METADATA "" (/shared/admin "mailto:admin@example.com")
S: A3 OK GETMETADATA completed
C: A4 GETMETADATA INBOX (/private/comment /shared/comment)
S: * METADATA INBOX (/private/comment "My inbox" /shared/comment NIL)
S: A4 OK GETMETADATA completed
C: A5 SETMETADATA INBOX (/shared/comment "Team inbox")
S: A5 OK SETMETADATA completed
C: A6 GETMETADATA (DEPTH infinity) INBOX /shared
S: * METADATA INBOX (/shared/comment "Team inbox")
S: A6 OK GETMETADATA completed
C: A7 SETMETADATA INBOX (/shared/comment "This value is too long")
S: A7 NO [METADATA MAXSIZE 16] Value of /shared/comment is too large
C: A8 SETMETADATA "" (/shared/admin "x")
S: A8 NO [CANNOT] The /shared/admin entry is read-only
C: A9 GETMETADATA Sent /private/specialuse
S: * METADATA Sent (/private/specialuse "\\Sent")
S: A9 OK GETMETADATA completed
C: A10 SETMETADATA INBOX (/shared/comment//x "a")
S: A10 BAD Entry name must not contain consecutive "/" characters
C: A11 SETMETADATA INBOX (/shared/comment NIL)
S: A11 OK SETMETADATA completed
```

What is implemented:

- GETMETADATA takes the `MAXSIZE` and `DEPTH` (`0`, `1`, `infinity`) options before the mailbox name. Values larger than MAXSIZE are left out and the tagged OK reports the size of the largest one with `[METADATA LONGENTRIES n]`.
- SETMETADATA with `NIL` removes an entry.
- Values can be binary: SETMETADATA takes a literal8 (`~{n}`), and values with NUL octets are sent back as a literal8.
- `/shared/admin` on the server is read-only (`NO [CANNOT]`).
- RENAME moves the annotations of a mailbox, renaming INBOX copies them (RFC 5464 section 4.1). DELETE removes them.
- After `ENABLE METADATA`, changes made by other sessions are announced with unsolicited `METADATA` responses.
- With SPECIAL-USE loaded, the read-only `/private/specialuse` entry shows the special-use attributes of a mailbox (RFC 6154 section 4).
- With NOTIFY loaded, the `MailboxMetadataChange` and `ServerMetadataChange` events are available.
- With ACL loaded, mailbox annotations need the rights listed on [Access control](./access-control.md#with-other-plugins).
- The control API reads and writes annotations with `server.control.getMetadata()` and `setMetadata()`, see [Plugin operations](../control-api/plugin-operations.md).

Refused with `BAD`, following RFC 5464 section 3.2: entry names with `//`, a trailing `/`, `*`, `%`, 8-bit or control characters, or a scope other than `/private` or `/shared`; values that are atoms or use bare CR or LF as line ends; empty entry or option lists; and GETMETADATA options after the mailbox name (errata 2785):

```text
C: A4 GETMETADATA INBOX (DEPTH 1) /shared
S: A4 BAD GETMETADATA expects options, a mailbox name and entries
```

## METADATA-SERVER

The same as METADATA (it loads ENABLE too), but only for server annotations (mailbox name `""`). A mailbox annotation command gets `NO`. The same options apply, and `ENABLE METADATA-SERVER` turns on unsolicited responses. When METADATA is loaded too, only `METADATA` is advertised.

```javascript
const server = imapkit({ plugins: ['METADATA-SERVER'], metadataPrivate: false });
```

```text
C: A2 CAPABILITY
S: * CAPABILITY IMAP4rev1 METADATA-SERVER
S: A2 OK Completed
C: A3 SETMETADATA "" (/private/comment "x")
S: A3 NO [METADATA NOPRIVATE] Private annotations are not supported
C: A4 GETMETADATA INBOX /private/comment
S: A4 NO Mailbox annotations are not supported, only server annotations
```

## QUOTA

Adds `GETQUOTA`, `GETQUOTAROOT` and `SETQUOTA`, the `STORAGE`, `MESSAGE` and `MAILBOX` resources, and the `DELETED` and `DELETED-STORAGE` STATUS items. INBOX and the personal namespaces share one quota root, other namespaces have none.

Configure it with the `quota` server option:

```javascript
const server = imapkit({
    plugins: ['QUOTA'],
    quota: {
        root: 'User quota', // name of the quota root, this is the default
        STORAGE: 10240, // in units of 1024 octets
        MESSAGE: 1000,
        MAILBOX: 100,
        soft: false
    }
});
```

A resource that is missing from the option is not limited. Without the option there are no limits at all, and an invalid limit throws when the server is created.

- APPEND, COPY and MOVE (from outside the quota root) fail with `NO [OVERQUOTA]` when they would go over a limit, and CREATE or RENAME of INBOX when they would go over the MAILBOX limit. Nothing is stored then.
- With `soft: true` these commands succeed, with an untagged `NO [OVERQUOTA]` warning.
- With REPLACE, only the net usage counts (RFC 8508 section 3.4).
- `SETQUOTA` replaces all limits of the root at runtime (RFC 9208 section 4.1.3). Unknown resources, or a resource named twice, get `NO [CANNOT]`, and a quota root other than the one configured gets `NO [NONEXISTENT]`.
- The control API reads and changes the quota with `server.control.getQuota()` and `setQuota()`, see [Plugin operations](../control-api/plugin-operations.md).

With `quota: { STORAGE: 1, MESSAGE: 5, MAILBOX: 100 }` and the four message INBOX used elsewhere in these docs:

```text
C: A2 CAPABILITY
S: * CAPABILITY IMAP4rev1 QUOTA QUOTA=RES-STORAGE QUOTA=RES-MESSAGE QUOTA=RES-MAILBOX QUOTASET
S: A2 OK Completed
C: A3 GETQUOTAROOT INBOX
S: * QUOTAROOT INBOX "User quota"
S: * QUOTA "User quota" (STORAGE 1 1 MESSAGE 4 5 MAILBOX 7 100)
S: A3 OK GETQUOTAROOT completed
C: A6 SETQUOTA "User quota" (STORAGE 100)
S: * QUOTA "User quota" (STORAGE 1 100)
S: A6 OK SETQUOTA completed
C: A7 APPEND INBOX {20}
S: + Go ahead
C: Subject: hi
C:
C: hello
S: A7 OK APPEND Completed
C: A8 STATUS INBOX (MESSAGES DELETED DELETED-STORAGE)
S: * STATUS INBOX (MESSAGES 5 DELETED 0 DELETED-STORAGE 0)
S: A8 OK Status completed
```

With `quota: { STORAGE: 1 }` (1024 octets) and an empty INBOX, a 2000 octet message does not fit:

```text
C: A2 APPEND INBOX {2000}
S: + Go ahead
C: ...
S: A2 NO [OVERQUOTA] Quota exceeded
```

With `quota: { MESSAGE: 4, soft: true }`, the fifth message is stored with a warning:

```text
C: A2 APPEND INBOX {20}
S: + Go ahead
C: Subject: hi
C:
C: hello
S: * NO [OVERQUOTA] Soft quota has been exceeded
S: A2 OK APPEND Completed
```

With ACL loaded, GETQUOTAROOT only lists the MAILBOX resource when the user lacks `r` on the mailbox, and SETQUOTA needs `a` on every mailbox of the quota root (RFC 9208 section 6).
