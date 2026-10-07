'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');

describe('Search tests', () => {
    const ctx = setupServer(() => ({
        plugins: ['ID', 'STARTTLS' /*, "LOGINDISABLED"*/, 'AUTH-PLAIN', 'NAMESPACE', 'IDLE', 'ENABLE', 'CONDSTORE', 'XTOYBIRD'],
        id: {
            name: 'imapkit',
            version: '0.1'
        },
        storage: {
            INBOX: {
                messages: [
                    {
                        uid: 61,
                        raw: 'Subject: hello 1\r\n\r\nWorld 1!',
                        internaldate: '14-Sep-2013 18:22:28 +0300',
                        flags: ['\\Flagged']
                    },
                    {
                        uid: 62,
                        raw: 'Subject: hello 2\r\nCC: test\r\n\r\nWorld 2!',
                        flags: ['\\Recent', '\\Seen', 'MyFlag']
                    },
                    {
                        uid: 63,
                        raw: 'Subject: hello 3\r\nDate: Fri, 13 Sep 2013 15:01:00 +0300\r\nBCC: test\r\n\r\nWorld 3!',
                        flags: ['\\Draft']
                    },
                    {
                        uid: 64,
                        raw:
                            'From: sender name <sender@example.com>\r\n' +
                            'To: Receiver name <receiver@example.com>\r\n' +
                            'Subject: hello 4\r\n' +
                            'Message-Id: <abcde>\r\n' +
                            'Date: Fri, 13 Sep 2013 15:01:00 +0300\r\n' +
                            '\r\n' +
                            'World 4!',
                        internaldate: '13-Sep-2013 18:22:28 +0300'
                    },
                    {
                        uid: 65,
                        raw: 'Subject: hello 5\r\nfrom: test\r\n\r\nWorld 5!',
                        flags: ['\\Deleted', '\\Recent']
                    },
                    {
                        raw: 'Subject: hello 6\r\n\r\nWorld 6!',
                        flags: '\\Answered',
                        uid: 66
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

    it('SEARCH ALL', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 UID SEARCH ALL', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 61 62 63 64 65 66\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH OR', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 UID SEARCH OR KEYWORD "MyFlag" 5:6', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 62 65 66\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });
});
