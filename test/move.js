'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');

describe('Hoodiecrow tests', () => {
    const ctx = setupServer(() => ({
        plugins: ['UIDPLUS', 'MOVE'],
        id: {
            name: 'hoodiecrow',
            version: '0.1'
        },
        storage: {
            INBOX: {
                messages: [
                    {
                        raw: 'Subject: hello 1\r\n\r\nWorld 1!',
                        internaldate: '14-Sep-2013 21:22:28 -0300'
                    },
                    {
                        raw: 'Subject: hello 1\r\n\r\nWorld 2!'
                    },
                    {
                        raw: 'Subject: hello 1\r\n\r\nWorld 3!'
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

    it('MOVE', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 MOVE 1:2 "target"', 'A4 SELECT target', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\n* OK [COPYUID 1 1,2 2,3]') >= 0);
            assert.equal(ctx.server.getMailbox('INBOX').messages.length, 1);
            assert.equal(ctx.server.getMailbox('target').messages.length, 3);
            done();
        });
    });

    it('UID MOVE', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 UID MOVE 1:2 target', 'A4 SELECT target', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\n* OK [COPYUID 1 1,2 2,3]') >= 0);
            assert.equal(ctx.server.getMailbox('INBOX').messages.length, 1);
            assert.equal(ctx.server.getMailbox('target').messages.length, 3);
            done();
        });
    });
    it('MOVE into the selected mailbox reports EXISTS', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 MOVE 1 INBOX', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\n* OK [COPYUID 1 1 4] Copied\r\n* 4 EXISTS\r\n* 1 EXPUNGE\r\nA3 OK') >= 0, resp);
            assert.equal(ctx.server.getMailbox('INBOX').messages.length, 3);
            done();
        });
    });

    it('MOVE to a missing mailbox returns TRYCREATE', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 MOVE 1 nosuch', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\nA3 NO [TRYCREATE]') >= 0, resp);
            assert.equal(ctx.server.getMailbox('INBOX').messages.length, 3);
            done();
        });
    });

    it('MOVE to a \\Noselect mailbox fails', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 CREATE parent/child', 'A3 DELETE parent', 'A4 SELECT INBOX', 'A5 MOVE 1 parent', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\nA5 NO') >= 0, resp);
            assert.equal(ctx.server.getMailbox('INBOX').messages.length, 3);
            done();
        });
    });

    it('MOVE fails in a read-only mailbox', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 EXAMINE INBOX', 'A3 MOVE 1 target', 'A4 UID MOVE 1 target', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\nA3 NO') >= 0, resp);
            assert.ok(resp.indexOf('\r\nA4 NO') >= 0, resp);
            assert.equal(ctx.server.getMailbox('INBOX').messages.length, 3);
            assert.equal(ctx.server.getMailbox('target').messages.length, 1);
            done();
        });
    });
});
