'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');

describe('Hoodiecrow tests', () => {
    const ctx = setupServer(() => ({
        plugins: ['ID', 'STARTTLS' /*, "LOGINDISABLED"*/, 'AUTH-PLAIN', 'NAMESPACE', 'IDLE', 'ENABLE', 'CONDSTORE', 'XTOYBIRD'],
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

    it('Mark as Seen', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 UID FETCH 2 BODY[]', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();

            assert.ok(resp.indexOf('* 2 FETCH (BODY[] {28}\r\n' + 'Subject: hello 2\r\n' + '\r\n' + 'World 2! FLAGS (\\Seen) UID 2)\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);

            done();
        });
    });
});
