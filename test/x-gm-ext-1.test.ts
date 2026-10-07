import { describe, it } from 'node:test';
import assert from 'node:assert';
import imapkit from '../src/server.js';
import { setupServer } from './helpers/index.js';

describe('ImapKit tests', () => {
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
            assert.deepStrictEqual(ctx.server.getMailbox('INBOX')!.messages[0]['X-GM-LABELS'], ['foo']);
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

    // labels are astrings: a literal is a label, and so is the atom NIL
    it('STORE +X-GM-LABELS with a literal and NIL', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 SELECT INBOX',
            'A3 STORE 1 +X-GM-LABELS ({7}\r\nTwo Low nil)',
            'A4 STORE 1 -X-GM-LABELS {7}\r\nTwo Low',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.match(resp, /^\* 1 FETCH \(X-GM-LABELS \(\\Inbox "Two Low" "nil"\)\)\r\nA3 OK/m);
            assert.match(resp, /^\* 1 FETCH \(X-GM-LABELS \(\\Inbox "nil"\)\)\r\nA4 OK/m);
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

    it('X-GM-THRID', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 FETCH 1 (X-GM-MSGID X-GM-THRID)', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            const match = resp.match(/\* 1 FETCH \(X-GM-MSGID (\d+) X-GM-THRID (\d+)\)/);
            assert.ok(match, resp);
            // without threading data a message is its own thread
            assert.strictEqual(match[1], match[2]);

            ctx.run(['B1 LOGIN testuser testpass', 'B2 SELECT INBOX', 'B3 SEARCH X-GM-THRID ' + match[2]], resp => {
                resp = resp.toString();
                assert.ok(/^\* SEARCH 1\r$/m.test(resp), resp);
                done();
            });
        });
    });

    describe('X-GM-MSGID with shared storage', () => {
        it('does not reuse values already in storage', () => {
            const storage = { INBOX: { messages: [{ raw: 'Subject: a\r\n\r\na' }] } };
            imapkit({ plugins: ['X-GM-EXT-1'], storage });
            storage.INBOX.messages.push({ raw: 'Subject: b\r\n\r\nb' });
            const second = imapkit({ plugins: ['X-GM-EXT-1'], storage });
            const message = second.appendMessage('INBOX', [], false, 'Subject: c\r\n\r\nc').message;
            const ids = second.getMailbox('INBOX')!.messages.map(message => message['X-GM-MSGID']);
            assert.strictEqual(new Set(ids).size, 3);
            assert.strictEqual(message['X-GM-MSGID'], '1278455344230334868');
        });
    });
});

// https://developers.google.com/workspace/gmail/imap/imap-extensions
describe('X-GM-EXT-1 labels and search', () => {
    const ctx = setupServer(() => ({
        plugins: ['X-GM-EXT-1', 'UTF8=ACCEPT'],
        storage: {
            INBOX: {
                messages: [
                    { raw: 'From: Bob <bob@example.com>\r\nSubject: hello world\r\nDate: Mon, 05 Oct 2026 10:00:00 +0000\r\n\r\nhi', flags: ['\\Seen'] },
                    {
                        raw: 'From: alice@example.com\r\nSubject: other\r\nMessage-ID: <x@example.com>\r\n\r\nzzz body text with more words',
                        internaldate: '01-Jan-2020 00:00:00 +0000',
                        flags: ['\\Flagged']
                    }
                ]
            },
            '': {
                folders: {
                    '\\Back': { messages: ['Subject: a\r\n\r\na'] },
                    '&BBYEMARA-': { messages: ['Subject: b\r\n\r\nb'] },
                    Sent: { 'special-use': '\\Sent', messages: ['Subject: s\r\n\r\ns'] }
                }
            }
        }
    }));

    const run = (commands: string[], callback: (resp: string) => void) =>
        ctx.run(['A1 LOGIN testuser testpass', ...commands, 'ZZ LOGOUT'], resp => callback(resp.toString('binary')));

    // labels are ASTRINGs, system labels are atoms that start with "\"
    it('sends label names like mailbox names', (t, done) => {
        run(
            [
                'A2 SELECT INBOX',
                'A3 STORE 1 +X-GM-LABELS ("\\\\Back" "Muy Importante" &BBYEMARA- \\Important "NIL")',
                'A4 SELECT "\\\\Back"',
                'A5 FETCH 1 X-GM-LABELS',
                'A6 SELECT Sent',
                'A7 FETCH 1 X-GM-LABELS'
            ],
            resp => {
                assert.match(resp, /^\* 1 FETCH \(X-GM-LABELS \(\\Inbox "\\\\Back" "Muy Importante" &BBYEMARA- \\Important "NIL"\)\)\r$/m);
                // a mailbox name that starts with "\" is not a system label
                assert.match(resp, /^\* 1 FETCH \(X-GM-LABELS \("\\\\Back"\)\)\r\nA5 OK/m);
                assert.match(resp, /^\* 1 FETCH \(X-GM-LABELS \(\\Sent\)\)\r\nA7 OK/m);
                done();
            }
        );
    });

    // RFC 9755: after ENABLE UTF8=ACCEPT mailbox names, and so label names, are UTF-8
    it('sends and takes label names as UTF-8 after ENABLE UTF8=ACCEPT', (t, done) => {
        const name = Buffer.from('Жар', 'utf-8').toString('binary');
        run(
            [
                'A2 ENABLE UTF8=ACCEPT',
                'A3 SELECT "' + name + '"',
                'A4 FETCH 1 X-GM-LABELS',
                'A5 STORE 1 X-GM-LABELS ("' + name + '")',
                'A6 SEARCH X-GM-LABELS "' + name + '"'
            ],
            resp => {
                assert.match(resp, new RegExp('^\\* 1 FETCH \\(X-GM-LABELS \\("' + name + '"\\)\\)\\r\\nA4 OK', 'm'));
                assert.match(resp, /^A5 OK/m);
                assert.deepStrictEqual(ctx.server.getMailbox('&BBYEMARA-')!.messages[0]['X-GM-LABELS'], ['&BBYEMARA-']);
                assert.match(resp, /^\* SEARCH 1\r\nA6 OK/m);
                done();
            }
        );
    });

    it('refuses label names that are not valid mailbox names, without changing anything', (t, done) => {
        run(['A2 SELECT INBOX', 'A3 STORE 1 X-GM-LABELS (fine "&Jjo")', 'A4 FETCH 1 X-GM-LABELS'], resp => {
            assert.match(resp, /^A3 BAD /m);
            assert.match(resp, /^\* 1 FETCH \(X-GM-LABELS \(\\Inbox\)\)\r\nA4 OK/m);
            done();
        });
    });

    it('searches by label', (t, done) => {
        run(['A2 SELECT INBOX', 'A3 STORE 2 +X-GM-LABELS.SILENT (foo)', 'A4 SEARCH X-GM-LABELS foo', 'A5 SEARCH X-GM-LABELS \\inbox'], resp => {
            assert.match(resp, /^\* SEARCH 2\r\nA4 OK/m);
            // system labels match without case
            assert.match(resp, /^\* SEARCH 1 2\r\nA5 OK/m);
            done();
        });
    });

    it('checks X-GM-MSGID and X-GM-THRID search values', (t, done) => {
        run(['A2 SELECT INBOX', 'A3 SEARCH X-GM-MSGID abc', 'A4 SEARCH X-GM-THRID 18446744073709551616', 'A5 SEARCH X-GM-MSGID 18446744073709551615'], resp => {
            assert.match(resp, /^A3 BAD /m);
            assert.match(resp, /^A4 BAD /m);
            assert.match(resp, /^\* SEARCH\r\nA5 OK/m);
            done();
        });
    });

    it('supports a subset of the Gmail search syntax with X-GM-RAW', (t, done) => {
        const cases: Record<string, string> = {
            'from:bob is:read': '1',
            'zzz OR hello': '1 2',
            '-from:bob': '2',
            'subject:\\"hello world\\" in:inbox': '1',
            '\\"more words\\"': '2',
            '(from:bob OR from:alice) -{zzz hello}': '',
            'rfc822msgid:<x@example.com> larger:10': '2',
            'smaller:1k is:starred': '2',
            'before:2021/01/01': '2',
            'after:2021-01-01': '1',
            'in:anywhere': '1 2',
            ' hello  ': '1',
            '-subject:\\"hello world\\"': '2',
            'label:Muy': '',
            'http://example.com': '',
            '__proto__:x constructor:y': ''
        };
        const queries = Object.keys(cases);
        run(['A2 SELECT INBOX'].concat(queries.map((query, i) => 'Q' + i + ' SEARCH X-GM-RAW "' + query + '"')), resp => {
            queries.forEach((query, i) => {
                assert.match(resp, new RegExp('^\\* SEARCH' + (cases[query] ? ' ' + cases[query] : '') + '\\r\\nQ' + i + ' OK', 'm'), query);
            });
            done();
        });
    });

    it('refuses X-GM-RAW queries it can not run', (t, done) => {
        run(
            [
                'A2 SELECT INBOX',
                'A3 SEARCH X-GM-RAW "has:attachment"',
                'A4 SEARCH X-GM-RAW "(from:bob"',
                'A5 SEARCH X-GM-RAW ""',
                'A6 SEARCH X-GM-RAW "larger:big"',
                'A7 SEARCH X-GM-RAW "after:2021/02/30"'
            ],
            resp => {
                // unsupported Gmail operators are refused instead of giving a wrong result
                assert.match(resp, /^A3 NO /m);
                for (const tag of ['A4', 'A5', 'A6', 'A7']) {
                    assert.match(resp, new RegExp('^' + tag + ' BAD ', 'm'));
                }
                done();
            }
        );
    });
});
