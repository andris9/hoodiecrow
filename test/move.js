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
});
