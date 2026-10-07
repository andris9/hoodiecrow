'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');

function storage() {
    return {
        INBOX: {
            messages: [
                { raw: 'Subject: hello 1\r\n\r\nWorld 1!', flags: ['\\Seen'] },
                { raw: 'Subject: hello 2\r\n\r\nWorld 2!', MODSEQ: 100 },
                { raw: 'Subject: hello 3\r\n\r\nWorld 3!' }
            ]
        },
        '': {
            folders: {
                empty: {}
            }
        }
    };
}

describe('CONDSTORE', () => {
    describe('with ENABLE loaded after CONDSTORE', () => {
        const ctx = setupServer(() => ({
            plugins: ['CONDSTORE', 'ENABLE'],
            storage: storage()
        }));

        it('ENABLE CONDSTORE sends ENABLED', (t, done) => {
            const cmds = ['A1 LOGIN testuser testpass', 'A2 ENABLE CONDSTORE X-UNKNOWN', 'A3 ENABLE CONDSTORE', 'ZZ LOGOUT'];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('\r\n* ENABLED CONDSTORE\r\nA2 OK') >= 0, resp);
                // already enabled, nothing new to report
                assert.ok(resp.indexOf('\r\n* ENABLED\r\nA3 OK') >= 0, resp);
                done();
            });
        });

        it('ENABLE CONDSTORE turns on MODSEQ in STORE responses', (t, done) => {
            const cmds = ['A1 LOGIN testuser testpass', 'A2 ENABLE CONDSTORE', 'A3 SELECT INBOX', 'A4 STORE 1 +FLAGS (\\Flagged)', 'ZZ LOGOUT'];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('\r\n* ENABLED CONDSTORE\r\nA2 OK') >= 0, resp);
                assert.ok(resp.indexOf('\r\n* 1 FETCH (FLAGS (\\Seen \\Flagged) MODSEQ (102) UID 1)\r\n') >= 0, resp);
                done();
            });
        });

        // RFC 5161 section 3.1: clients MUST NOT issue ENABLE once they SELECT/EXAMINE a mailbox
        it('ENABLE after SELECT is refused', (t, done) => {
            const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 ENABLE CONDSTORE', 'A4 CLOSE', 'A5 ENABLE CONDSTORE', 'ZZ LOGOUT'];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(/^A3 BAD/m.test(resp), resp);
                assert.ok(/^A5 BAD/m.test(resp), resp);
                done();
            });
        });
    });

    describe('without ENABLE', () => {
        const ctx = setupServer(() => ({
            plugins: ['CONDSTORE'],
            storage: storage()
        }));

        it('keeps MODSEQ values from storage and reports HIGHESTMODSEQ', (t, done) => {
            const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 FETCH 1:* (MODSEQ)', 'ZZ LOGOUT'];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('\r\n* OK [HIGHESTMODSEQ 101]\r\n') >= 0, resp);
                assert.ok(resp.indexOf('\r\n* 1 FETCH (MODSEQ (2))\r\n') >= 0, resp);
                assert.ok(resp.indexOf('\r\n* 2 FETCH (MODSEQ (100))\r\n') >= 0, resp);
                assert.ok(resp.indexOf('\r\n* 3 FETCH (MODSEQ (101))\r\n') >= 0, resp);
                done();
            });
        });

        it('reports a positive HIGHESTMODSEQ for an empty mailbox', (t, done) => {
            const cmds = ['A1 LOGIN testuser testpass', 'A2 STATUS empty (MESSAGES HIGHESTMODSEQ)', 'A3 SELECT empty', 'ZZ LOGOUT'];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('\r\n* STATUS empty (MESSAGES 0 HIGHESTMODSEQ 1)\r\n') >= 0, resp);
                assert.ok(resp.indexOf('\r\n* OK [HIGHESTMODSEQ 1]\r\n') >= 0, resp);
                done();
            });
        });

        it('includes MODSEQ in STORE responses once enabled, also after a plain SELECT', (t, done) => {
            const cmds = [
                'A1 LOGIN testuser testpass',
                'A2 SELECT INBOX (CONDSTORE)',
                'A3 SELECT INBOX',
                'A4 STORE 3 +FLAGS (\\Flagged)',
                'A5 STORE 3 +FLAGS.SILENT (\\Answered)',
                'ZZ LOGOUT'
            ];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('\r\n* 3 FETCH (FLAGS (\\Flagged) MODSEQ (102) UID 3)\r\nA4 OK') >= 0, resp);
                assert.ok(resp.indexOf('\r\n* 3 FETCH (UID 3 MODSEQ (103))\r\nA5 OK') >= 0, resp);
                done();
            });
        });

        it('does not include MODSEQ in STORE responses when not enabled', (t, done) => {
            const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 STORE 3 +FLAGS (\\Flagged)', 'A4 FETCH 3 (MODSEQ)', 'ZZ LOGOUT'];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('\r\n* 3 FETCH (FLAGS (\\Flagged))\r\nA3 OK') >= 0, resp);
                assert.ok(resp.indexOf('\r\n* 3 FETCH (MODSEQ (102))\r\nA4 OK') >= 0, resp);
                done();
            });
        });

        it('does not bump MODSEQ when nothing changed', (t, done) => {
            const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX (CONDSTORE)', 'A3 STORE 1 +FLAGS (\\Seen)', 'ZZ LOGOUT'];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('\r\n* 1 FETCH (FLAGS (\\Seen) MODSEQ (2) UID 1)\r\nA3 OK') >= 0, resp);
                assert.strictEqual(ctx.server.getMailbox('INBOX').HIGHESTMODSEQ, 101);
                done();
            });
        });

        it('UNCHANGEDSINCE reports failed messages with MODIFIED and does not change them', (t, done) => {
            const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 STORE 1:3 (UNCHANGEDSINCE 100) +FLAGS.SILENT (\\Deleted)', 'ZZ LOGOUT'];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('\r\n* 1 FETCH (UID 1 MODSEQ (102))\r\n* 2 FETCH (UID 2 MODSEQ (103))\r\nA3 OK [MODIFIED 3]') >= 0, resp);
                const messages = ctx.server.getMailbox('INBOX').messages;
                assert.deepStrictEqual(messages[2].flags, []);
                assert.strictEqual(messages[2].MODSEQ, 101);
                done();
            });
        });

        it('UID STORE UNCHANGEDSINCE reports UIDs with MODIFIED', (t, done) => {
            const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 UID STORE 1:3 (UNCHANGEDSINCE 100) +FLAGS (\\Deleted)', 'ZZ LOGOUT'];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('\r\nA3 OK [MODIFIED 3]') >= 0, resp);
                assert.ok(resp.indexOf('UID 3') < 0, resp);
                assert.strictEqual(ctx.server.getMailbox('INBOX').messages[2].MODSEQ, 101);
                done();
            });
        });

        it('rejects an invalid UNCHANGEDSINCE value', (t, done) => {
            const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 STORE 1 (UNCHANGEDSINCE abc) +FLAGS (\\Deleted)', 'ZZ LOGOUT'];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('\r\nA3 BAD') >= 0, resp);
                done();
            });
        });

        it('FETCH CHANGEDSINCE returns changed messages with MODSEQ', (t, done) => {
            const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 FETCH 1:* (FLAGS) (CHANGEDSINCE 2)', 'ZZ LOGOUT'];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('* 1 FETCH') < 0, resp);
                assert.ok(resp.indexOf('\r\n* 2 FETCH (FLAGS () MODSEQ (100))\r\n') >= 0, resp);
                assert.ok(resp.indexOf('\r\n* 3 FETCH (FLAGS () MODSEQ (101))\r\n') >= 0, resp);
                done();
            });
        });

        it('FETCH that sets \\Seen bumps MODSEQ', (t, done) => {
            const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 FETCH 3 (BODY[] MODSEQ)', 'ZZ LOGOUT'];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('World 3! MODSEQ (102) FLAGS (\\Seen) UID 3)\r\nA3 OK') >= 0, resp);
                done();
            });
        });

        it('EXPUNGE bumps HIGHESTMODSEQ', (t, done) => {
            const cmds = [
                'A1 LOGIN testuser testpass',
                'A2 SELECT INBOX',
                'A3 STORE 1 +FLAGS.SILENT (\\Deleted)',
                'A4 EXPUNGE',
                'A5 SELECT INBOX',
                'ZZ LOGOUT'
            ];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('\r\n* OK [HIGHESTMODSEQ 103]\r\n') >= 0, resp);
                done();
            });
        });

        it('appended messages get a new MODSEQ', (t, done) => {
            const message = 'Subject: new\r\n\r\nnew';
            const cmds = [
                'A1 LOGIN testuser testpass',
                'A2 APPEND empty {' + message.length + '}\r\n' + message,
                'A3 STATUS empty (HIGHESTMODSEQ)',
                'ZZ LOGOUT'
            ];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('\r\n* STATUS empty (HIGHESTMODSEQ 2)\r\n') >= 0, resp);
                done();
            });
        });
    });
});
