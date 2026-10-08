---
title: Mailboxes
sidebar_position: 5
description: Core LIST, LSUB and subscription behavior in ImapKit, and the NAMESPACE, LIST-EXTENDED, LIST-STATUS, SPECIAL-USE, CREATE-SPECIAL-USE, STATUS=SIZE and UNSELECT plugins.
---

# Mailboxes

| Plugin               | Capability           | RFC                                                |
| -------------------- | -------------------- | -------------------------------------------------- |
| `NAMESPACE`          | `NAMESPACE`          | [RFC 2342](https://www.rfc-editor.org/rfc/rfc2342) |
| `LIST-EXTENDED`      | `LIST-EXTENDED`      | [RFC 5258](https://www.rfc-editor.org/rfc/rfc5258) |
| `LIST-STATUS`        | `LIST-STATUS`        | [RFC 5819](https://www.rfc-editor.org/rfc/rfc5819) |
| `SPECIAL-USE`        | `SPECIAL-USE`        | [RFC 6154](https://www.rfc-editor.org/rfc/rfc6154) |
| `CREATE-SPECIAL-USE` | `CREATE-SPECIAL-USE` | [RFC 6154](https://www.rfc-editor.org/rfc/rfc6154) |
| `STATUS=SIZE`        | `STATUS=SIZE`        | [RFC 8438](https://www.rfc-editor.org/rfc/rfc8438) |
| `UNSELECT`           | `UNSELECT`           | [RFC 3691](https://www.rfc-editor.org/rfc/rfc3691) |

The mailbox tree comes from the `storage` option, see [Storage](../guides/storage.md). The transcripts on this page use this storage:

```javascript
const storage = {
    INBOX: { messages: [/* four messages */] },
    '': {
        separator: '/',
        folders: {
            Archive: { 'special-use': '\\Archive' },
            Sent: { 'special-use': '\\Sent' },
            Trash: { 'special-use': '\\Trash' },
            Projects: { folders: { Alpha: {}, Beta: { subscribed: false } } }
        }
    }
};
```

## Core LIST, LSUB and subscriptions

Without plugins, LIST and LSUB follow RFC 3501. `\HasChildren` and `\HasNoChildren` are always sent.

- The subscription list holds names, not mailboxes (RFC 3501 section 6.3.6). A mailbox from the storage is subscribed unless it has `"subscribed": false`, a mailbox created later is not.
- DELETE does not unsubscribe, so LSUB keeps listing the name until UNSUBSCRIBE, and a mailbox created again under that name is subscribed. RENAME leaves the subscription with the old name.
- SUBSCRIBE refuses names that are not mailboxes, UNSUBSCRIBE accepts any name.
- LSUB sends the LIST attributes of an existing mailbox, without `\Noselect`, and `()` for a subscribed name that is no longer a mailbox.
- LIST concatenates the reference and the pattern as they are, without inserting a hierarchy delimiter (RFC 9051 section 6.3.9).

```text
C: A2 LIST "" "*"
S: * LIST (\HasNoChildren) "/" "INBOX"
S: * LIST (\HasNoChildren) "/" "Archive"
S: * LIST (\HasNoChildren) "/" "Sent"
S: * LIST (\HasNoChildren) "/" "Trash"
S: * LIST (\HasChildren) "/" "Projects"
S: * LIST (\HasNoChildren) "/" "Projects/Alpha"
S: * LIST (\HasNoChildren) "/" "Projects/Beta"
S: A2 OK Completed
C: A3 LSUB "" "*"
S: * LSUB (\HasNoChildren) "/" "INBOX"
S: * LSUB (\HasNoChildren) "/" "Archive"
S: * LSUB (\HasNoChildren) "/" "Sent"
S: * LSUB (\HasNoChildren) "/" "Trash"
S: * LSUB (\HasChildren) "/" "Projects"
S: * LSUB (\HasNoChildren) "/" "Projects/Alpha"
S: A3 OK Completed
C: A4 DELETE Projects/Alpha
S: A4 OK DELETE completed
C: A5 LSUB "" "Projects/*"
S: * LSUB () "/" "Projects/Alpha"
S: A5 OK Completed
C: A6 SUBSCRIBE Nope
S: A6 NO [NONEXISTENT] Mailbox does not exist
C: A7 UNSUBSCRIBE Nope
S: A7 OK UNSUBSCRIBE completed
```

CREATE `a/b` also creates `a` as a normal mailbox, DELETE of a mailbox with children leaves a `\Noselect` level, and mailbox names must be valid modified UTF-7. STATUS of the selected mailbox works but carries `[CLIENTBUG]`, as RFC 2683 section 3.1.1 asks clients not to do it:

```text
C: A4 STATUS INBOX (MESSAGES)
S: * STATUS INBOX (MESSAGES 4)
S: A4 OK [CLIENTBUG] Status completed, STATUS SHOULD NOT be used on the selected mailbox
```

## NAMESPACE

Adds the `NAMESPACE` command. The personal, other users' and shared namespaces come from the keys of the storage object and their `type` (`personal`, which is the default, `user` or `shared`). The `INBOX` key is a mailbox, not a namespace.

With the default storage (`INBOX` and `""` with `/` as separator):

```text
C: A2 NAMESPACE
S: * NAMESPACE (("" "/")) NIL NIL
S: A2 OK Completed
```

With a Cyrus style storage:

```json
{
    "INBOX": {},
    "INBOX.": {},
    "user.": { "type": "user" },
    "": { "type": "shared" }
}
```

```text
C: A2 NAMESPACE
S: * NAMESPACE (("INBOX." ".")) (("user." ".")) (("" "/"))
S: A2 OK Completed
```

Namespace prefixes are converted for the session like mailbox names (modified UTF-7, or UTF-8 after `ENABLE UTF8=ACCEPT`). Anonymous namespaces are not supported.

## LIST-EXTENDED

Adds the extended LIST syntax of RFC 5258:

- selection options `SUBSCRIBED`, `REMOTE` (there are no remote mailboxes, so it changes nothing) and `RECURSIVEMATCH`
- return options `SUBSCRIBED` and `CHILDREN` (children attributes are always returned)
- several mailbox patterns in one command, `LIST "" ("INBOX" "Projects/%")`
- the `CHILDINFO` extended data item
- `\Noselect` mailboxes are listed as `\NonExistent`, also subscribed names that are not mailboxes

The plain RFC 3501 LIST is not changed. With [SPECIAL-USE](#special-use) loaded, the `SPECIAL-USE` selection and return options combine with the others, with [LIST-STATUS](#list-status) the `STATUS` return option, and with [ACL](./access-control.md) the `MYRIGHTS` return option (LIST-MYRIGHTS).

```text
C: A2 LIST (SUBSCRIBED) "" "*" RETURN (CHILDREN)
S: * LIST (\Subscribed \HasNoChildren) "/" "INBOX"
S: * LIST (\Subscribed \HasNoChildren \Archive) "/" "Archive"
S: * LIST (\Subscribed \HasNoChildren \Sent) "/" "Sent"
S: * LIST (\Subscribed \HasNoChildren \Trash) "/" "Trash"
S: * LIST (\Subscribed \HasChildren) "/" "Projects"
S: * LIST (\Subscribed \HasNoChildren) "/" "Projects/Alpha"
S: A2 OK Completed
C: A3 LIST "" ("INBOX" "Projects/%")
S: * LIST (\HasNoChildren) "/" "INBOX"
S: * LIST (\HasNoChildren) "/" "Projects/Alpha"
S: * LIST (\HasNoChildren) "/" "Projects/Beta"
S: A3 OK Completed
C: A7 LIST (SUBSCRIBED RECURSIVEMATCH) "" "%" RETURN (CHILDREN)
S: * LIST (\Subscribed \HasNoChildren) "/" "INBOX"
S: * LIST (\Subscribed \HasNoChildren \Archive) "/" "Archive"
S: * LIST (\Subscribed \HasNoChildren \Sent) "/" "Sent"
S: * LIST (\Subscribed \HasNoChildren \Trash) "/" "Trash"
S: * LIST (\Subscribed \HasChildren) "/" "Projects" ("CHILDINFO" ("SUBSCRIBED"))
S: A7 OK Completed
```

(This server has SPECIAL-USE loaded too, which adds `\Archive`, `\Sent` and `\Trash`.)

Refused with `BAD`:

- unknown selection or return options, and options with values they do not take
- `RECURSIVEMATCH` without a base option like `SUBSCRIBED`, also `(SPECIAL-USE RECURSIVEMATCH)` (RFC 6154 section 6)
- an empty pattern list
- a repeated `STATUS` return option with different items

```text
C: A5 LIST (RECURSIVEMATCH) "" "*"
S: A5 BAD RECURSIVEMATCH must be used together with a selection option like SUBSCRIBED
C: A6 LIST "" ()
S: A6 BAD LIST expects a mailbox pattern or a list of patterns
```

## LIST-STATUS

Loads LIST-EXTENDED and adds the `STATUS` return option of RFC 5819. A STATUS response follows the LIST response of every selectable mailbox that matches the selection criteria, including the selected mailbox. Mailboxes listed only for CHILDINFO or as `\NonExistent` get none. Every STATUS item works here, also those added by plugins (`SIZE`, `HIGHESTMODSEQ`, `APPENDLIMIT`, `MAILBOXID` ...). Invalid items are `BAD`.

```text
C: A2 LIST "" "%" RETURN (STATUS (MESSAGES UNSEEN SIZE))
S: * LIST (\HasNoChildren) "/" "INBOX"
S: * STATUS INBOX (MESSAGES 4 UNSEEN 3 SIZE 787)
S: * LIST (\HasNoChildren) "/" "Archive"
S: * STATUS Archive (MESSAGES 0 UNSEEN 0 SIZE 0)
S: * LIST (\HasNoChildren) "/" "Sent"
S: * STATUS Sent (MESSAGES 0 UNSEEN 0 SIZE 0)
S: * LIST (\HasNoChildren) "/" "Trash"
S: * STATUS Trash (MESSAGES 0 UNSEEN 0 SIZE 0)
S: * LIST (\HasChildren) "/" "Projects"
S: * STATUS Projects (MESSAGES 0 UNSEEN 0 SIZE 0)
S: A2 OK Completed
C: A4 LIST "" "%" RETURN (STATUS (FOO))
S: A4 BAD Invalid status element (1)
```

With ACL, mailboxes without the `r` right get no STATUS response and are listed with `\Noselect` (RFC 5819 section 2).

## SPECIAL-USE

Adds the special-use attributes of RFC 6154 to LIST and LSUB responses. A mailbox in the storage gets them from its `special-use` property, a string or an array:

```json
{ "Sent Mail": { "special-use": "\\Sent" } }
```

- Without LIST-EXTENDED, `LIST (SPECIAL-USE) "" "*"` lists only the special-use mailboxes and `RETURN (SPECIAL-USE)` is accepted.
- With LIST-EXTENDED, `SPECIAL-USE` is a selection option that implies the return option, and both combine with the other LIST options.
- With [METADATA](./metadata-and-quota.md#metadata), the read-only `/private/specialuse` entry of a mailbox shows its attributes (RFC 6154 section 4).
- After `ENABLE IMAP4rev2`, the untagged LIST response of SELECT includes them.
- The control API can change them at runtime: `server.control.setSpecialUse(path, ['\\Sent'])`, which accepts `\All`, `\Archive`, `\Drafts`, `\Flagged`, `\Junk`, `\Sent`, `\Trash` and `\Important` (RFC 8457). See [Plugin operations](../control-api/plugin-operations.md).

```text
C: A4 LIST (SPECIAL-USE) "" "*"
S: * LIST (\HasNoChildren \Archive) "/" "Archive"
S: * LIST (\HasNoChildren \Sent) "/" "Sent"
S: * LIST (\HasNoChildren \Trash) "/" "Trash"
S: A4 OK Completed
```

## CREATE-SPECIAL-USE

Lets CREATE set special-use attributes: `CREATE name (USE (\Drafts))`. Attribute names are matched case-insensitively and stored in their canonical form.

The allowed attributes are `\Archive`, `\Drafts`, `\Flagged`, `\Junk`, `\Sent` and `\Trash` by default. The `special-use` server option replaces the list:

```javascript
const server = imapkit({
    plugins: ['SPECIAL-USE', 'CREATE-SPECIAL-USE'],
    'special-use': ['\\Drafts', '\\Sent', '\\Trash', '\\Important']
});
```

An attribute that is not allowed gets `NO [USEATTR]`, and an attribute that is not an atom or a string gets `BAD`. Load SPECIAL-USE as well so that LIST shows the attributes.

```text
C: A2 CREATE Drafts (USE (\Drafts))
S: A2 OK CREATE completed
C: A3 CREATE Stuff (USE (\Important))
S: A3 NO [USEATTR] \Important not supported
C: A4 LIST "" "Drafts"
S: * LIST (\HasNoChildren \Drafts) "/" "Drafts"
S: A4 OK Completed
```

## STATUS=SIZE

Adds the `SIZE` STATUS item: the sum of the RFC822.SIZE values of the messages in the mailbox. It works with LIST-STATUS too.

```text
C: A3 STATUS INBOX (SIZE MESSAGES)
S: * STATUS INBOX (SIZE 787 MESSAGES 4)
S: A3 OK Status completed
```

## UNSELECT

Adds `UNSELECT`, which closes the selected mailbox like CLOSE but without expunging `\Deleted` messages. It is valid in the selected state only and takes no arguments.

```text
C: A3 STORE 1 +FLAGS (\Deleted)
S: * 1 FETCH (FLAGS (\Seen \Deleted))
S: A3 OK STORE completed
C: A4 UNSELECT
S: A4 OK Mailbox closed
C: A5 SELECT INBOX
S: ...
S: * 4 EXISTS
S: ...
S: A5 OK [READ-WRITE] Completed
C: A6 UNSELECT x
S: A6 BAD UNSELECT does not take any arguments
```
