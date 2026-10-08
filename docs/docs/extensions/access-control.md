---
title: Access Control
sidebar_position: 6
description: The ACL plugin of ImapKit, with LIST-MYRIGHTS, the aclOwner option, ACLs in storage and how the rights of users other than the owner are enforced.
---

# Access control

|               |                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| Plugin        | `ACL`                                                                                                  |
| Capabilities  | `ACL`, `RIGHTS=texk`, and `LIST-MYRIGHTS` when LIST-EXTENDED is loaded                                 |
| RFC           | [RFC 4314](https://www.rfc-editor.org/rfc/rfc4314), [RFC 8440](https://www.rfc-editor.org/rfc/rfc8440) |
| Server option | `aclOwner` (default `"testuser"`)                                                                      |
| Commands      | `SETACL`, `DELETEACL`, `GETACL`, `LISTRIGHTS`, `MYRIGHTS`, and the `MYRIGHTS` return option of LIST    |

ImapKit has a single mailbox tree that every user shares (see [Authentication](../guides/authentication.md)). With the ACL plugin, the owner has every right on every mailbox, and every other user only gets what the ACL of a mailbox grants them. This is how you test a client against shared mailboxes, read-only folders and permission errors.

## Setting up users and ACLs

The owner is the user named by the `aclOwner` option, `testuser` by default. Add other users with the `users` option, and give them rights with the `acl` property of a mailbox in the storage:

```javascript
const server = imapkit({
    plugins: ['ACL', 'LIST-EXTENDED'],
    users: {
        testuser: { password: 'testpass' },
        otheruser: { password: 'secret' }
    },
    storage: {
        INBOX: { acl: { otheruser: 'lr', anyone: 'l' }, messages: [/* four messages */] },
        '': {
            separator: '/',
            folders: {
                Archive: { acl: { otheruser: 'lrswite' } },
                Shared: { acl: { otheruser: 'lrswikte', '-otheruser': 't' } },
                Sent: {}
            }
        }
    }
});
```

A user other than the owner gets the rights granted to their user name and to `anyone`, minus the negative rights of `-username` and `-anyone` (RFC 4314 section 2). An invalid ACL in the storage is not checked when the server is created: the first command that needs the ACL of that mailbox fails with `NO [SERVERBUG]`.

ACLs can also be changed with SETACL and DELETEACL, or from your test with the control API (`server.control.getAcl()`, `setAcl()`, `deleteAcl()`, see [Plugin operations](../control-api/plugin-operations.md)).

## Rights

| Right | Meaning                                            |
| ----- | -------------------------------------------------- |
| `l`   | lookup: the mailbox is visible in LIST and LSUB    |
| `r`   | read: SELECT, EXAMINE and STATUS                   |
| `s`   | keep the `\Seen` flag                              |
| `w`   | write flags other than `\Seen` and `\Deleted`      |
| `i`   | insert: APPEND, COPY and MOVE into the mailbox     |
| `p`   | post (accepted and listed, there is no submission) |
| `k`   | create mailboxes below this one                    |
| `x`   | delete the mailbox, rename it                      |
| `t`   | set and clear `\Deleted`                           |
| `e`   | expunge                                            |
| `a`   | administer: change the ACL                         |

`RIGHTS=texk` tells clients that `t`, `e`, `x` and `k` can be granted separately. The obsolete `c` and `d` rights are accepted as `kx` and `et`, and are added to ACL and MYRIGHTS responses (RFC 4314 section 2.1.1). Unknown rights and uppercase rights are `BAD`, and so are empty identifiers and identifiers with control characters or invalid UTF-8 (RFC 4314 section 3).

The rights of the owner can not be changed:

```text
C: A3 GETACL INBOX
S: * ACL INBOX testuser lrswipkxteacd otheruser lr anyone l
S: A3 OK Getacl complete
C: A4 SETACL Archive otheruser +a
S: A4 OK Setacl complete
C: A5 LISTRIGHTS INBOX otheruser
S: * LISTRIGHTS INBOX otheruser "" l r s w i p k x t e a c d
S: A5 OK Listrights complete
C: A6 SETACL INBOX otheruser lrX
S: A6 BAD Uppercase rights are not allowed
C: A7 SETACL INBOX testuser lr
S: A7 NO [CANNOT] Rights of the mailbox owner can not be changed
```

## Enforcement

The owner bypasses every check. For other users, ImapKit enforces the rights as RFC 4314 section 4 describes:

| Command                               | Needs                                                                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| LIST, LSUB                            | mailboxes without `l` are left out                                                                                                       |
| SELECT, EXAMINE, STATUS               | `r`                                                                                                                                      |
| SUBSCRIBE                             | `l`                                                                                                                                      |
| SELECT read-write                     | any of `i`, `e`, `s`, `w`, `t`, otherwise the mailbox is opened `READ-ONLY`. PERMANENTFLAGS only lists the flags the user can change     |
| STORE                                 | `s` for `\Seen`, `t` for `\Deleted`, `w` for other flags. Only the flags the user has rights for change, and `NO [NOPERM]` if none could |
| FETCH                                 | without `s`, FETCH does not set `\Seen`                                                                                                  |
| APPEND, COPY                          | `i` on the target. Only the flags the user has rights for are kept                                                                       |
| MOVE                                  | `i` on the target, `t` and `e` on the source (RFC 6851 section 4.2)                                                                      |
| REPLACE                               | like MOVE (RFC 8508 section 4.1)                                                                                                         |
| EXPUNGE                               | `e`. CLOSE without `e` closes the mailbox without expunging                                                                              |
| CREATE                                | `k` on the nearest existing parent, so other users can not create top level mailboxes                                                    |
| DELETE                                | `x`                                                                                                                                      |
| RENAME                                | `x` on the mailbox and `k` on the new parent                                                                                             |
| GETACL, SETACL, DELETEACL, LISTRIGHTS | `a`                                                                                                                                      |
| MYRIGHTS                              | any of `l`, `r`, `i`, `k`, `x`, `a`                                                                                                      |

APPEND and REPLACE are refused before the message literal is sent. The rights on the selected mailbox are taken when it is selected. A new mailbox inherits the ACL of its parent, and DELETE removes the ACL.

Missing rights are answered with `NO [NOPERM]`. When the user does not have `l` either, the answer is the same as for a mailbox that does not exist, so the existence of the mailbox is not disclosed (RFC 4314 section 6).

Logged in as `otheruser` with the storage above:

```text
C: A2 MYRIGHTS INBOX
S: * MYRIGHTS INBOX lr
S: A2 OK Myrights complete
C: A3 LIST "" "*" RETURN (MYRIGHTS)
S: * LIST (\HasNoChildren) "/" "INBOX"
S: * MYRIGHTS INBOX lr
S: * LIST (\HasNoChildren) "/" "Archive"
S: * MYRIGHTS Archive lrswited
S: * LIST (\HasNoChildren) "/" "Shared"
S: * MYRIGHTS Shared lrswikecd
S: A3 OK Completed
C: A4 SELECT INBOX
S: * FLAGS (\Answered \Flagged \Draft \Deleted \Seen)
S: * OK [PERMANENTFLAGS ()] No permanent flags permitted
S: * 4 EXISTS
S: * 0 RECENT
S: * OK [UNSEEN 2] First unseen message
S: * OK [UIDVALIDITY 1] UIDs valid
S: * OK [UIDNEXT 5] Predicted next UID
S: A4 OK [READ-ONLY] Completed
C: A5 STORE 2 +FLAGS (\Flagged)
S: A5 NO [CLIENTBUG] Mailbox is read-only
C: A6 GETACL INBOX
S: A6 NO [NOPERM] Permission denied
C: A7 SELECT Sent
S: A7 NO [NONEXISTENT] Mailbox does not exist
C: A8 CREATE Mine
S: A8 NO [NOPERM] Permission denied
```

`Sent` has no ACL, so `otheruser` does not have `l` and gets the same answer as for a missing mailbox. INBOX opens read-only, as `lr` holds none of `i`, `e`, `s`, `w` and `t`.

## With other plugins

| Plugin        | Effect                                                                                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LIST-EXTENDED | LIST-MYRIGHTS: the `MYRIGHTS` return option of LIST (RFC 8440)                                                                                                                    |
| LIST-STATUS   | mailboxes without `r` get no STATUS response and are listed with `\Noselect` (RFC 5819 section 2)                                                                                 |
| METADATA      | GETMETADATA and SETMETADATA on a mailbox need `l` and any of `r`, `s`, `w`, `i`, `p` (RFC 5464 section 3.3). Unsolicited METADATA responses only go to sessions with these rights |
| QUOTA         | GETQUOTAROOT only lists the MAILBOX resource without `r` on the mailbox. SETQUOTA needs `a` on every mailbox of the quota root (RFC 9208 section 6)                               |
| MULTISEARCH   | mailboxes without `r` are skipped, and without `l` unless named under `mailboxes` or as a subtree root                                                                            |
| NOTIFY        | only mailboxes with `l` and `r` are reported, granting or revoking `l` counts as a MailboxName event                                                                              |
| CATENATE      | URLs of mailboxes the user can not read are refused with `NO [BADURL]`                                                                                                            |

The ACL plugin wraps the commands of other plugins too (MOVE, UID EXPUNGE, REPLACE ...), in any load order.
