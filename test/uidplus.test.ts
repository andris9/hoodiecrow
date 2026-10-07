import { describe, it } from 'node:test';
import assert from 'node:assert';
import { setupServer } from './helpers/index.js';

describe('ImapKit tests', () => {
    const ctx = setupServer(() => ({
        plugins: 'UIDPLUS',
        id: {
            name: 'imapkit',
            version: '0.1'
        },
        storage: {
            INBOX: {
                messages: [
                    {
                        raw: 'Subject: hello 1\r\n\r\nWorld 1!',
                        internaldate: '14-Sep-2013 21:22:28 -0300',
                        flags: '\\Deleted'
                    },
                    {
                        raw: 'Subject: hello 1\r\n\r\nWorld 2!'
                    }
                ]
            },
            '': {
                folders: {
                    target: {
                        messages: [
                            {
                                raw: 'Subject: hello 3\r\n\r\nWorld 3!'
                            }
                        ]
                    }
                }
            }
        }
    }));

    it('UID EXPUNGE', (t, done) => {
        const cmds = ['A1 CAPABILITY', 'A2 LOGIN testuser testpass', 'A3 SELECT INBOX', 'A4 UID EXPUNGE 1:2', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            // only the message with the \\Deleted flag is expunged
            assert.ok(resp.indexOf('\r\n* 1 EXPUNGE\r\nA4 OK') >= 0, resp);
            assert.ok(resp.indexOf('\r\n* 2 EXPUNGE\r\n') < 0, resp);
            const messages = ctx.server.getMailbox('INBOX')!.messages;
            assert.equal(messages.length, 1);
            assert.equal(messages[0].uid, 2);
            done();
        });
    });

    it('UID EXPUNGE ignores messages without \\Deleted', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 UID EXPUNGE 2', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('EXPUNGE\r\n') < 0, resp);
            assert.ok(resp.indexOf('\r\nA3 OK') >= 0, resp);
            assert.equal(ctx.server.getMailbox('INBOX')!.messages.length, 2);
            done();
        });
    });

    it('UID EXPUNGE fails in a read-only mailbox', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 EXAMINE INBOX', 'A3 UID EXPUNGE 1', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.match(resp, /^A3 NO \[CLIENTBUG\] /m);
            assert.equal(ctx.server.getMailbox('INBOX')!.messages.length, 2);
            done();
        });
    });

    it('UID COPY with no matching messages has no COPYUID', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 UID COPY 100 target', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\nA3 OK') >= 0, resp);
            assert.ok(resp.indexOf('COPYUID') < 0, resp);
            done();
        });
    });

    it('APPEND', (t, done) => {
        const message = 'From: sender <sender@example.com>\r\nTo: receiver@example.com\r\nSubject: HELLO!\r\n\r\nWORLD!';
        const cmds = ['A1 CAPABILITY', 'A2 LOGIN testuser testpass', 'A3 SELECT INBOX', 'A4 APPEND INBOX {' + message.length + '}\r\n' + message, 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA2 OK') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('\nA4 OK [APPENDUID 1 3]') >= 0);
            done();
        });
    });

    it('UID COPY STRING', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 UID COPY 1:* "target"', 'A4 SELECT target', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\nA3 OK [COPYUID 1 1,2 2,3]') >= 0);
            assert.equal((resp.match(/\* 3 EXISTS/gm) || []).length, 1);
            done();
        });
    });

    it('UID COPY ATOM', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 UID COPY 1:* target', 'A4 SELECT target', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\nA3 OK [COPYUID 1 1,2 2,3]') >= 0);
            assert.equal((resp.match(/\* 3 EXISTS/gm) || []).length, 1);
            done();
        });
    });
});
