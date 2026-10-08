// A client test that uses the control API (README "Control API"): the server state changes from the test, and the
// client must notice. Run with `node --test examples/control-api.js` after `npm install imapkit imapflow`.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import imapkit from 'imapkit';
import { ImapFlow } from 'imapflow';

describe('client against ImapKit', () => {
    let server;
    let port;

    before(async () => {
        server = imapkit({ plugins: ['IDLE', 'CONDSTORE', 'QRESYNC', 'UIDPLUS', 'MOVE'] });
        port = await server.start();
    });

    after(() => server.stop());

    it('sees a new message while idling', async () => {
        const client = new ImapFlow({ host: '127.0.0.1', port, secure: false, auth: { user: 'testuser', pass: 'testpass' }, logger: false });
        await client.connect();
        await client.mailboxOpen('INBOX');

        // wait until the client idles, then deliver a message
        const idling = new Promise(resolve => {
            const listener = event => {
                if (event.type === 'waiting' && event.command === 'IDLE') {
                    server.off('session', listener);
                    resolve();
                }
            };
            server.on('session', listener);
        });
        const exists = new Promise(resolve => client.once('exists', resolve));
        // ImapFlow starts IDLE on its own after 15 seconds, start it now
        client.idle();
        await idling;
        const { uid } = server.control.addMessage('INBOX', { raw: 'Subject: hello\r\n\r\nHi!\r\n' });

        const event = await exists;
        assert.strictEqual(event.count, 1);
        assert.strictEqual(uid, 1);
        await client.logout();
    });

    it('notices a UIDVALIDITY change', async () => {
        server.control.addMessage('INBOX', { raw: 'Subject: second\r\n\r\n2\r\n' });
        const oldValidity = server.control.getMailbox('INBOX').uidvalidity;
        // every old UID now points to another message, a client that ignores UIDVALIDITY shows wrong mail
        server.control.resetUidValidity('INBOX', { uids: 'shuffle', seed: 1 });

        const client = new ImapFlow({ host: '127.0.0.1', port, secure: false, auth: { user: 'testuser', pass: 'testpass' }, logger: false });
        await client.connect();
        const mailbox = await client.mailboxOpen('INBOX');
        assert.ok(Number(mailbox.uidValidity) > oldValidity);
        await client.logout();
    });
});
