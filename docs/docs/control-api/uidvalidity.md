---
title: UIDVALIDITY Resets
sidebar_position: 3
description: Give a mailbox a new UIDVALIDITY and renumber, shuffle or shift its UIDs with resetUidValidity(), to test how a client resynchronizes its cache.
---

# UIDVALIDITY resets

A client that caches messages by UID must check UIDVALIDITY every time it selects a mailbox. When the value changes, every cached UID is meaningless and the client has to throw its cache away and sync again ([RFC 3501 section 2.3.1.1](https://www.rfc-editor.org/rfc/rfc3501#section-2.3.1.1), [RFC 9051 section 2.3.1.1](https://www.rfc-editor.org/rfc/rfc9051#section-2.3.1.1)). Real servers do this after a mailbox is restored from a backup, rebuilt or migrated, which is rare enough that the code path often goes untested. `resetUidValidity()` makes it happen on demand.

## resetUidValidity(path, options)

```typescript
resetUidValidity(
    path: string,
    options?: { uidvalidity?: number; uids?: 'keep' | 'renumber' | 'shuffle' | 'offset'; offset?: number; seed?: number }
): { uidvalidity: number; uidnext: number; uids: { uid: number; newUid: number }[] }
```

| Option        | Description                                                                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uidvalidity` | the new UIDVALIDITY. It must be an integer greater than the current value and below 2^32. Default: one above every UIDVALIDITY the server has used, so it is unique as well |
| `uids`        | what happens to the UIDs: `keep` (default), `renumber`, `shuffle` or `offset`, see below                                                                                    |
| `offset`      | extra gap for `offset`, a non-negative integer. Default `0`                                                                                                                 |
| `seed`        | an integer that fixes the `shuffle` order, so a test is repeatable. Default: a random order                                                                                 |

Returns the new UIDVALIDITY and UIDNEXT, and `uids`, which maps every old UID to its new one in the old order.

**Errors:** `NONEXISTENT` for a missing or `\Noselect` mailbox, `INVALID` for a UIDVALIDITY that is not greater than the current one (`UIDVALIDITY must be an integer above 1 and below 2^32`), an unknown `uids` mode, a negative or fractional `offset` or a seed that is not an integer.

## The UID modes

The examples start from a mailbox with UIDs 1, 3 and 4 (UID 2 was expunged), UIDNEXT 5 and UIDVALIDITY 1.

| Mode       | New UIDs                                                                | Result of the example                                                              |
| ---------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `keep`     | unchanged                                                               | `1→1, 3→3, 4→4`, UIDNEXT 5                                                         |
| `renumber` | 1 to n in the current order, UIDNEXT n+1                                | `1→1, 3→2, 4→3`, UIDNEXT 4                                                         |
| `shuffle`  | 1 to n in a random order (repeatable with `seed`), UIDNEXT n+1          | with `seed: 42`: `1→3, 3→1, 4→2`, UIDNEXT 4                                        |
| `offset`   | every UID plus (old UIDNEXT - 1 + `offset`), UIDNEXT moves the same way | `1→5, 3→7, 4→8`, UIDNEXT 9. With `offset: 100`: `1→105, 3→107, 4→108`, UIDNEXT 109 |

```javascript
server.control.resetUidValidity('INBOX', { uids: 'shuffle', seed: 42 });
```

```javascript
{
  uidvalidity: 2,
  uidnext: 4,
  uids: [ { uid: 1, newUid: 3 }, { uid: 3, newUid: 1 }, { uid: 4, newUid: 2 } ]
}
```

With `shuffle`, the messages are reordered by their new UIDs, so the sequence numbers change too. The other modes keep the order.

### Why each mode is useful

Each mode catches a different kind of client bug:

- **`keep`**: only UIDVALIDITY changes. A correct client still discards its cache and downloads everything again. A client that ignores UIDVALIDITY looks fine here, since its cached UIDs still point to the same messages. Use it to check that the client notices the change at all, for example by counting the FETCH commands it sends.
- **`renumber`**: UIDs become 1 to n, like a server that rebuilt its index. Cached UIDs above n find nothing, lower ones find other messages. Shows up clients that look up messages by a cached UID without checking UIDVALIDITY.
- **`shuffle`**: every old UID points to a different message of the same mailbox. A client that keeps its cache shows the wrong subject for a message, sets flags on the wrong message or deletes the wrong one, all without any error. This is the most dangerous case, use `seed` to make a failure repeatable.
- **`offset`**: every UID moves above the old UIDNEXT, so no old UID points to any message. A client that keeps its cache sees empty FETCH results for everything it knows, and every message looks new.

## What sessions see

A UID must not change during a session, so every session that has the mailbox selected is disconnected right away:

```
* BYE UIDVALIDITY of the selected mailbox changed
```

Sessions that have other mailboxes selected, or none, are not affected. The client has to reconnect and select the mailbox again, and then it sees the new value:

```
* OK [UIDVALIDITY 2] UIDs valid
* OK [UIDNEXT 4] Predicted next UID
```

## CONDSTORE and QRESYNC

The mod-sequences of the messages stay as they are, they move with the messages to their new UIDs, and HIGHESTMODSEQ does not change. This matters for clients that use [CONDSTORE and QRESYNC](../extensions/synchronization.md):

- A QRESYNC client that sends `SELECT INBOX (QRESYNC (1 3 1:4))` with the old UIDVALIDITY gets a plain SELECT answer, with no VANISHED and no FETCH responses, as [RFC 7162 section 3.2.5](https://www.rfc-editor.org/rfc/rfc7162#section-3.2.5) requires for a UIDVALIDITY that does not match (the server ignores the other parameters). The client must notice the new `UIDVALIDITY` in the response and do a full sync.
- A client that compares only HIGHESTMODSEQ with its cached value sees the same number as before and may conclude that nothing changed. [RFC 7162 section 3.1.2.1](https://www.rfc-editor.org/rfc/rfc7162#section-3.1.2.1) says the client MUST delete its cached HIGHESTMODSEQ when UIDVALIDITY changed. Testing with `shuffle` makes this bug visible: the client's cached flags and envelopes belong to other messages.

A real session after a `shuffle` reset, reconnecting with QRESYNC and its old state:

```
A3 SELECT INBOX (QRESYNC (1 3 1:4))
* FLAGS (\Answered \Flagged \Draft \Deleted \Seen)
* OK [PERMANENTFLAGS (\Answered \Flagged \Draft \Deleted \Seen \*)] Flags permitted
* 3 EXISTS
* 0 RECENT
* OK [UNSEEN 1] First unseen message
* OK [UIDVALIDITY 2] UIDs valid
* OK [UIDNEXT 4] Predicted next UID
* OK [HIGHESTMODSEQ 6] Highest
A3 OK [READ-WRITE] Completed
```

## Example: test a client's resync

```javascript
import imapkit from 'imapkit';
import assert from 'node:assert';

const server = imapkit({ plugins: ['IDLE', 'QRESYNC'] });
const port = await server.start();
for (let i = 1; i <= 3; i++) {
    server.control.addMessage('INBOX', { raw: `Subject: message ${i}\r\n\r\n${i}\r\n` });
}

// 1. the client syncs INBOX and caches it
// 2. the store changes under it
const { uidvalidity } = server.control.resetUidValidity('INBOX', { uids: 'shuffle', seed: 1 });
// 3. the client was disconnected with BYE, it reconnects and syncs again
// 4. the client's view must match the server
const expected = server.control.listMessages('INBOX', { raw: true });
// compare expected[i].uid and expected[i].raw with what the client shows, and the client's UIDVALIDITY with uidvalidity

await server.stop();
```

The same operation over HTTP is `POST /v1/mailboxes/{path}/uidvalidity`, see [REST endpoints](../rest-api/endpoints.md#reset-uidvalidity).
