'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');

describe('Hoodiecrow tests', () => {
    const ctx = setupServer(() => ({
        plugins: ['NAMESPACE'],
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
                        raw: 'Subject: hello 2\r\n\r\nWorld 2!',
                        flags: ['\\Seen']
                    },
                    {
                        raw: 'Subject: hello 3\r\n\r\nWorld 3!'
                    },
                    {
                        raw:
                            'From: sender name <sender@example.com>\r\n' +
                            'To: Receiver name <receiver@example.com>\r\n' +
                            'Subject: hello 4\r\n' +
                            'Message-Id: <abcde>\r\n' +
                            'Date: Fri, 13 Sep 2013 15:01:00 +0300\r\n' +
                            '\r\n' +
                            'World 4!'
                    },
                    {
                        raw: 'Subject: hello 5\r\n\r\nWorld 5!'
                    },
                    {
                        raw: 'Subject: hello 6\r\n\r\nWorld 6!'
                    }
                ]
            },
            '': {
                folders: {
                    Test: {
                        subscribed: false
                    }
                }
            },
            '#news.': {
                type: 'shared',
                separator: '.',
                folders: {
                    world: {}
                }
            },
            '#juke?': {
                type: 'shared',
                separator: '?'
            }
        }
    }));

    it('Namespace', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 CAPABILITY', 'A3 NAMESPACE', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.match(/^\* CAPABILITY\b.*?\bNAMESPACE\b/m));
            assert.ok(resp.indexOf('\n* NAMESPACE (("" "/")) NIL (("#news." ".") ("#juke?" "?"))\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('LIST separator', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 CAPABILITY', 'A3 LIST "" ""', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.equal((resp.match(/^\* LIST\b/gm) || []).length, 1);
            assert.ok(resp.indexOf('\n* LIST (\\Noselect) "/" ""\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('LIST default namespace', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 CAPABILITY', 'A3 LIST "" "*"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.equal((resp.match(/^\* LIST\b/gm) || []).length, 2);
            assert.ok(resp.indexOf('\n* LIST (\\HasNoChildren) "/" "INBOX"\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('LIST #news namespace', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 CAPABILITY', 'A3 LIST "#news." "*"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.equal((resp.match(/^\* LIST\b/gm) || []).length, 1);
            assert.ok(resp.indexOf('\n* LIST (\\HasNoChildren) "." "#news.world"\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('LSUB all', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 CAPABILITY', 'A3 LSUB "" "*"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.equal((resp.match(/^\* LSUB\b/gm) || []).length, 1);
            assert.ok(resp.indexOf('\n* LSUB (\\HasNoChildren) "/" "INBOX"\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });
});
