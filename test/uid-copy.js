'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');

describe('Hoodiecrow tests', () => {
    const ctx = setupServer(() => ({
        plugins: 'UNSELECT',
        id: {
            name: 'hoodiecrow',
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
                    target: {}
                }
            }
        }
    }));

    it('UID COPY STRING', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 UID COPY 1:* "target"', 'A4 SELECT "target"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\nA3 OK') >= 0);
            assert.equal((resp.match(/\* 2 EXISTS/gm) || []).length, 2);
            done();
        });
    });

    it('UID COPY ATOM', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 UID COPY 1:* target', 'A4 SELECT target', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\nA3 OK') >= 0);
            assert.equal((resp.match(/\* 2 EXISTS/gm) || []).length, 2);
            done();
        });
    });
});
