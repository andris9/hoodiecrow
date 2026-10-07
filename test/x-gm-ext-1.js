'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const hoodiecrow = require('../lib/server');
const { setupServer } = require('./helpers');

describe('Hoodiecrow tests', () => {
    const ctx = setupServer(() => ({
        plugins: ['X-GM-EXT-1'],
        storage: {
            INBOX: {
                messages: [
                    {
                        raw: 'Subject: hello 1\r\n\r\nWorld 1!',
                        flags: ['\\Seen']
                    },
                    {
                        raw: 'Subject: hello 1\r\n\r\nWorld 1!',
                        flags: ['\\Seen', '\\Deleted']
                    }
                ]
            },
            '': {
                folders: {
                    target: {}
                }
            }
        }
    }));

    it('advertises X-GM-EXT-1', (t, done) => {
        const cmds = ['A1 CAPABILITY', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(/\* CAPABILITY [^\r\n]* X-GM-EXT-1/.test(resp), resp);
            done();
        });
    });

    it('STORE +X-GM-LABELS.SILENT', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 SELECT INBOX',
            'A3 STORE 1 +X-GM-LABELS.SILENT (foo)',
            'A4 STORE 1 -X-GM-LABELS.SILENT (\\Inbox)',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA3 OK') >= 0, resp);
            assert.ok(resp.indexOf('\nA4 OK') >= 0, resp);
            assert.ok(resp.indexOf('FETCH') < 0, resp);
            assert.deepStrictEqual(ctx.server.getMailbox('INBOX').messages[0]['X-GM-LABELS'], ['foo']);
            done();
        });
    });

    it('COPY keeps X-GM-MSGID', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 COPY 2 target', 'A4 SELECT target', 'A5 FETCH 1 X-GM-MSGID', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* 1 FETCH (X-GM-MSGID 1278455344230334867)\r\n') >= 0, resp);
            done();
        });
    });

    it('FETCH X-GM-MSGID', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 FETCH 1:2 X-GM-MSGID', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();

            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('\n* 1 FETCH (X-GM-MSGID 1278455344230334866)\r\n' + '* 2 FETCH (X-GM-MSGID 1278455344230334867)\r\n') >= 0);

            done();
        });
    });

    it('SEARCH X-GM-MSGID', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH X-GM-MSGID 1278455344230334867', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('\n* SEARCH 2\r\n') >= 0);

            done();
        });
    });

    it('SEARCH X-GM-LABELS', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 FETCH 1:2 X-GM-LABELS', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('\n* 1 FETCH (X-GM-LABELS (\\Inbox))\r\n' + '* 2 FETCH (X-GM-LABELS (\\Inbox))\r\n') >= 0);

            done();
        });
    });

    it('STORE +X-GM-LABELS', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 STORE 1 +X-GM-LABELS (foo)', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('\n* 1 FETCH (X-GM-LABELS (\\Inbox foo))\r\n') >= 0);

            done();
        });
    });

    it('STORE -X-GM-LABELS', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 STORE 1 -X-GM-LABELS (\\Inbox)', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('\n* 1 FETCH (X-GM-LABELS ())\r\n') >= 0);

            done();
        });
    });

    it('STORE X-GM-LABELS', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 STORE 1 X-GM-LABELS (tere vana "kere pere")', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('\n* 1 FETCH (X-GM-LABELS (tere vana "kere pere"))\r\n') >= 0);

            done();
        });
    });
});

describe('X-GM-MSGID with shared storage', () => {
    it('does not reuse values already in storage', () => {
        const storage = { INBOX: { messages: [{ raw: 'Subject: a\r\n\r\na' }] } };
        hoodiecrow({ plugins: ['X-GM-EXT-1'], storage });
        storage.INBOX.messages.push({ raw: 'Subject: b\r\n\r\nb' });
        const second = hoodiecrow({ plugins: ['X-GM-EXT-1'], storage });
        const message = second.appendMessage('INBOX', [], false, 'Subject: c\r\n\r\nc').message;
        const ids = second.getMailbox('INBOX').messages.map(message => message['X-GM-MSGID']);
        assert.strictEqual(new Set(ids).size, 3);
        assert.strictEqual(message['X-GM-MSGID'], '1278455344230334868');
    });
});
