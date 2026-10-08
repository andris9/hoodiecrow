import { describe, it } from 'node:test';
import assert from 'node:assert';
import { setupServer } from './helpers/index.js';

describe('Search tests', () => {
    const ctx = setupServer(() => ({
        plugins: ['ID', 'STARTTLS' /*, "LOGINDISABLED"*/, 'AUTH-PLAIN', 'NAMESPACE', 'IDLE', 'ENABLE', 'CONDSTORE'],
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
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH ALL', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 1 2 3 4 5 6\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH ANSWERED', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH ANSWERED', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 6\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH <SEQUENCE>', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH 1:3,5:*', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 1 2 3 5 6\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH BCC', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH BCC "test"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 3\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH BEFORE', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH BEFORE "14-Sep-2013"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 4\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH BODY', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH BODY "World 3"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 3\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH CC', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH CC "test"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 2\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH DELETED', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH DELETED', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 5\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH DRAFT', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH DRAFT', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 3\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH FLAGGED', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH FLAGGED', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 1\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH FROM', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH FROM "test"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 5\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH HEADER', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH HEADER "message-id" "abcd"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 4\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH KEYWORD', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH KEYWORD "MyFlag"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 2\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH LARGER', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH LARGER 34', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 2 3 4 5\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH NEW', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH NEW', 'A3 SEARCH RECENT UNSEEN', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.equal((resp.match(/\n\* SEARCH 5\r\n/g) || []).length, 2);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH NOT', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH NOT KEYWORD "MyFlag"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 1 3 4 5 6\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH OLD', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH OLD', 'A3 SEARCH NOT RECENT', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.equal((resp.match(/\n\* SEARCH 1 3 4 6\r\n/g) || []).length, 2);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH ON', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH ON "14-Sep-2013"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 1\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH OR', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH OR KEYWORD "MyFlag" 5:6', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 2 5 6\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH RECENT', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH RECENT', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 2 5\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH SEEN', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH SEEN', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 2\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH SENTBEFORE', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH SENTBEFORE "14-Sep-2013"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 3 4\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH SENTON', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 SELECT INBOX',
            'A3 SEARCH SENTON "13-Sep-2013"',
            'A4 SEARCH SENTBEFORE "13-Sep-2013"',
            'A5 SEARCH SENTON "13-Sep-2014"',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 3 4\r\nA3 OK') >= 0);
            // the year of the Date header counts too
            assert.ok(resp.indexOf('\n* SEARCH\r\nA4 OK') >= 0);
            assert.ok(resp.indexOf('\n* SEARCH\r\nA5 OK') >= 0);
            done();
        });
    });

    it('SEARCH SENTSINCE', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH SENTSINCE "14-Sep-2013"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 1 2 5 6\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH SINCE', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH SINCE "14-Sep-2013"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 1 2 3 5 6\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH SMALLER', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH SMALLER 34', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 1 6\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH SUBJECT', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH SUBJECT "hello 2"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 2\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH TEXT', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH TEXT "hello 2"', 'A4 SEARCH TEXT "world 5"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 2\r\n') >= 0);
            assert.ok(resp.indexOf('\n* SEARCH 5\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('\nA4 OK') >= 0);
            done();
        });
    });

    it('SEARCH TO', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH TO "receiver"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 4\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH UID', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH UID 66', 'A4 SEARCH UID 1:*', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 6\r\n') >= 0);
            assert.ok(resp.indexOf('\n* SEARCH 1 2 3 4 5 6\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('\nA4 OK') >= 0);
            done();
        });
    });

    it('SEARCH UNANSWERED', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH UNANSWERED', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 1 2 3 4 5\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH UNDELETED', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH UNDELETED', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 1 2 3 4 6\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH UNDRAFT', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH UNDRAFT', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 1 2 4 5 6\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH UNFLAGGED', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH UNFLAGGED', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 2 3 4 5 6\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH UNKEYWORD', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH UNKEYWORD "MyFlag"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 1 3 4 5 6\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH UNSEEN', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH UNSEEN', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 1 3 4 5 6\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('SEARCH INVALID', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 SELECT INBOX',
            'A3 SEARCH ABCDE',
            'A4 SEARCH HEADER X-Foo',
            'A5 SEARCH ON 32-Jan-2020',
            'A6 SEARCH LARGER abc',
            'A7 SEARCH NOT',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA3 BAD Invalid search key ABCDE\r\n') >= 0, resp);
            assert.ok(resp.indexOf('\nA4 BAD') >= 0);
            assert.ok(resp.indexOf('\nA5 BAD') >= 0);
            assert.ok(resp.indexOf('\nA6 BAD') >= 0);
            assert.ok(resp.indexOf('\nA7 BAD') >= 0);
            assert.ok(resp.indexOf('    at ') < 0);
            done();
        });
    });

    it('SEARCH with no matches', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 SELECT INBOX',
            'A3 SEARCH SUBJECT "no such subject"',
            'A4 UID SEARCH SUBJECT "no such subject"',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH\r\nA3 OK') >= 0, resp);
            assert.ok(resp.indexOf('\n* SEARCH\r\nA4 OK') >= 0);
            done();
        });
    });

    it('SEARCH with parenthesized keys', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 SELECT INBOX',
            'A3 SEARCH (OR SUBJECT "hello 1" SUBJECT "hello 2") UNSEEN',
            'A4 SEARCH NOT (SEEN DELETED)',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 1\r\nA3 OK') >= 0, resp);
            assert.ok(resp.indexOf('\n* SEARCH 1 2 3 4 5 6\r\nA4 OK') >= 0);
            done();
        });
    });

    it('SEARCH CHARSET', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 SELECT INBOX',
            'A3 SEARCH CHARSET UTF-8 SUBJECT "hello 2"',
            'A4 SEARCH CHARSET X-UNKNOWN SUBJECT "hello 2"',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 2\r\nA3 OK') >= 0, resp);
            assert.ok(resp.indexOf('\nA4 NO [BADCHARSET (US-ASCII UTF-8)]') >= 0);
            done();
        });
    });

    it('SEARCH LARGER and SMALLER are strict', (t, done) => {
        // message 1 is 28 bytes
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH LARGER 28 SMALLER 30', 'A4 SEARCH LARGER 27 SMALLER 29', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH\r\nA3 OK') >= 0, resp);
            assert.ok(resp.indexOf('\n* SEARCH 1 6\r\nA4 OK') >= 0);
            done();
        });
    });
});

describe('Search with unusual data', () => {
    const ctx = setupServer(() => ({
        storage: {
            INBOX: {
                messages: [
                    {
                        raw: 'Subject: folded\r\n subject line\r\nX-Foo: bar\r\n\r\nbody',
                        internaldate: 'not a date'
                    },
                    {
                        raw: 'Subject: second\r\nDate: Mon, 5 Oct 26 10:00:00 +0300\r\n\r\nbody',
                        internaldate: '06-Oct-2026 10:00:00 +0300'
                    },
                    {
                        raw: 'Subject: =?UTF-8?Q?R=C3=A9servation?=\r\nFrom: =?ISO-8859-1?B?SvZyZw==?= <jorg@example.com>\r\nX-Note: =?UTF-8?Q?caf=C3?=\r\n =?UTF-8?Q?=A9?=\r\n\r\nbody',
                        internaldate: '01-Jan-2020 10:00:00 +0000'
                    }
                ]
            }
        }
    }));

    it('a bad internal date does not break date searches', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH SINCE 1-Oct-2026', 'A4 SEARCH SENTON 5-Oct-2026', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 2\r\nA3 OK') >= 0, resp);
            assert.ok(resp.indexOf('\n* SEARCH 2\r\nA4 OK') >= 0);
            done();
        });
    });

    it('header values are unfolded', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH SUBJECT "folded subject"', 'A4 SEARCH HEADER X-Foo ""', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\n* SEARCH 1\r\nA3 OK') >= 0, resp);
            assert.ok(resp.indexOf('\n* SEARCH 1\r\nA4 OK') >= 0);
            done();
        });
    });

    it('header values are compared after decoding encoded words', (t, done) => {
        // RFC 3501 and RFC 9051 section 6.4.4: [MIME-HDRS] strings in headers MUST be decoded before comparing text
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 SELECT INBOX',
            'A3 SEARCH CHARSET UTF-8 SUBJECT {12}\r\nR\xc3\xa9servation',
            'A4 SEARCH CHARSET UTF-8 FROM {5}\r\nJ\xc3\xb6rg',
            'A5 SEARCH CHARSET UTF-8 HEADER X-Note {5}\r\ncaf\xc3\xa9',
            'A6 SEARCH SUBJECT reservation',
            'A7 SEARCH SUBJECT "=?UTF-8?Q?"',
            'A8 SEARCH SUBJECT SERVATION FROM jorg@example.com',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.match(resp, /^\* SEARCH 3\r\nA3 OK/m);
            assert.match(resp, /^\* SEARCH 3\r\nA4 OK/m);
            assert.match(resp, /^\* SEARCH 3\r\nA5 OK/m);
            assert.match(resp, /^\* SEARCH\r\nA6 OK/m);
            assert.match(resp, /^\* SEARCH\r\nA7 OK/m);
            assert.match(resp, /^\* SEARCH 3\r\nA8 OK/m);
            done();
        });
    });
});
