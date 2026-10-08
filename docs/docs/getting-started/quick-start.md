---
sidebar_position: 2
title: Quick Start
---

# Quick Start

Start a server on a free port, connect your client, and change the server state from the test:

```javascript title="test/client.test.js"
import { test } from 'node:test';
import assert from 'node:assert';
import imapkit from 'imapkit';

test('client sees a new message', async () => {
    const server = imapkit({ plugins: ['IDLE'] });
    const port = await server.start();

    // ... connect your IMAP client to 127.0.0.1:port as testuser / testpass

    const { uid } = server.control.addMessage('INBOX', {
        raw: 'Subject: hello\r\n\r\nHi!\r\n',
        flags: ['\\Seen']
    });
    assert.strictEqual(uid, 1);

    await server.stop();
});
```

Every server starts from the `storage` option, or from an empty INBOX, so tests never depend on each other.
