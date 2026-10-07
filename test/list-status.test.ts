// LIST-STATUS, RFC 5819 (https://www.rfc-editor.org/rfc/rfc5819.txt)

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { setupServer } from './helpers/index.js';
import { openSession } from './helpers/session.js';

const LOGIN = 'A1 LOGIN testuser testpass';

const storage = () => ({
    INBOX: {
        messages: [
            { raw: 'Subject: one\r\n\r\nWorld', flags: ['\\Seen'] },
            { raw: 'Subject: two\r\n\r\nWorld' },
            { raw: 'Subject: three\r\n\r\nWorld', flags: ['\\Recent'] }
        ]
    },
    '': {
        separator: '/',
        folders: {
            Fruit: {
                subscribed: false,
                folders: {
                    Banana: { subscribed: true, messages: [{ raw: 'Subject: banana\r\n\r\nYellow', flags: ['\\Seen'] }] }
                }
            },
            'Sent mail': { messages: [{ raw: 'Subject: sent\r\n\r\nGone' }] },
            Placeholder: { flags: ['\\Noselect'], folders: { Child: {} } }
        }
    }
});

describe('LIST-STATUS', () => {
    const ctx = setupServer(() => ({ plugins: ['LIST-STATUS', 'CONDSTORE'], storage: storage() }));

    const run = (commands: string[], callback: (resp: string) => void) => ctx.run([LOGIN, ...commands, 'ZZ LOGOUT'], resp => callback(resp.toString('binary')));

    it('advertises LIST-STATUS and loads LIST-EXTENDED', (t, done) => {
        run(['A2 CAPABILITY'], resp => {
            assert.match(resp, /^\* CAPABILITY .*\bLIST-STATUS\b/m);
            assert.match(resp, /^\* CAPABILITY .*\bLIST-EXTENDED\b/m);
            done();
        });
    });

    it('sends a STATUS response after the LIST response of every mailbox (RFC 5819 section 2)', (t, done) => {
        run(['A2 LIST "" "%" RETURN (STATUS (MESSAGES UNSEEN))'], resp => {
            assert.match(
                resp,
                new RegExp(
                    [
                        'A1 OK [^\\r]*',
                        '\\* LIST \\(\\\\HasNoChildren\\) "/" "INBOX"',
                        '\\* STATUS INBOX \\(MESSAGES 3 UNSEEN 2\\)',
                        '\\* LIST \\(\\\\HasChildren\\) "/" "Fruit"',
                        '\\* STATUS Fruit \\(MESSAGES 0 UNSEEN 0\\)',
                        '\\* LIST \\(\\\\HasNoChildren\\) "/" "Sent mail"',
                        '\\* STATUS "Sent mail" \\(MESSAGES 1 UNSEEN 1\\)',
                        // RFC 5819 section 2: no STATUS for a mailbox that can not be selected
                        '\\* LIST \\(\\\\NonExistent \\\\HasChildren\\) "/" "Placeholder"',
                        'A2 OK '
                    ].join('\\r\\n')
                )
            );
            done();
        });
    });

    it('gives the same values as the STATUS command', (t, done) => {
        run(
            [
                'A2 STATUS INBOX (MESSAGES RECENT UIDNEXT UIDVALIDITY UNSEEN HIGHESTMODSEQ)',
                'A3 LIST "" "INBOX" RETURN (STATUS (MESSAGES RECENT UIDNEXT UIDVALIDITY UNSEEN HIGHESTMODSEQ))'
            ],
            resp => {
                const values = [...resp.matchAll(/^\* STATUS INBOX (\(.*\))\r$/gm)].map(match => match[1]);
                assert.strictEqual(values.length, 2, resp);
                assert.strictEqual(values[0], values[1]);
                assert.match(values[0], /HIGHESTMODSEQ [1-9]/);
                done();
            }
        );
    });

    it('sends no STATUS for a mailbox listed only for CHILDINFO (RFC 5819 section 3)', (t, done) => {
        run(['A2 LIST (SUBSCRIBED RECURSIVEMATCH) "" "%" RETURN (STATUS (MESSAGES))'], resp => {
            assert.match(resp, /^\* LIST \(\\HasChildren\) "\/" "Fruit" \("CHILDINFO" \("SUBSCRIBED"\)\)\r\n\* LIST/m);
            assert.doesNotMatch(resp, /^\* STATUS Fruit/m);
            assert.match(resp, /^\* LIST \(\\Subscribed \\HasNoChildren\) "\/" "INBOX"\r\n\* STATUS INBOX \(MESSAGES 3\)\r\n/m);
            done();
        });
    });

    it('works with the other return options', (t, done) => {
        run(['A2 LIST "" "Fruit/*" RETURN (CHILDREN STATUS (MESSAGES) SUBSCRIBED)'], resp => {
            assert.match(resp, /^\* LIST \(\\Subscribed \\HasNoChildren\) "\/" "Fruit\/Banana"\r\n\* STATUS Fruit\/Banana \(MESSAGES 1\)\r\nA2 OK/m);
            done();
        });
    });

    it('reports the selected mailbox too (RFC 9051 section 6.3.11)', (t, done) => {
        run(['A2 SELECT INBOX', 'A3 STORE 2 +FLAGS (\\Seen)', 'A4 LIST "" "INBOX" RETURN (STATUS (MESSAGES UNSEEN RECENT))'], resp => {
            // the session that selected the mailbox owns the \Recent message
            assert.match(resp, /^\* STATUS INBOX \(MESSAGES 3 UNSEEN 1 RECENT 1\)\r\nA4 OK/m);
            done();
        });
    });

    it('quotes mailbox names that are not atoms', (t, done) => {
        run(['A2 CREATE "NIL"', 'A3 CREATE "\\\\Foo"', 'A4 STATUS "NIL" (MESSAGES)', 'A5 LIST "" "\\\\Foo" RETURN (STATUS (MESSAGES))'], resp => {
            assert.match(resp, /^\* STATUS "NIL" \(MESSAGES 0\)\r\nA4 OK/m);
            assert.match(resp, /^\* STATUS "\\\\Foo" \(MESSAGES 0\)\r\nA5 OK/m);
            done();
        });
    });

    it('accepts a repeated STATUS option with the same items (RFC 5258 section 3)', (t, done) => {
        run(['A2 LIST "" "INBOX" RETURN (STATUS (MESSAGES) STATUS (messages))'], resp => {
            assert.match(resp, /^\* STATUS INBOX \(MESSAGES 3\)\r\nA2 OK/m);
            done();
        });
    });

    it('rejects invalid STATUS return options (RFC 5819 section 4)', (t, done) => {
        run(
            [
                'A2 LIST "" "%" RETURN (STATUS)',
                'A3 LIST "" "%" RETURN (STATUS ())',
                'A4 LIST "" "%" RETURN (STATUS (FOO))',
                'A5 LIST "" "%" RETURN (STATUS (MESSAGES) STATUS (UNSEEN))',
                'A6 LIST "" "%" RETURN (STATUS ("MESSAGES"))',
                // STATUS=SIZE is not loaded, DELETED is IMAP4rev2 only
                'A7 LIST "" "%" RETURN (STATUS (SIZE))',
                'A8 LIST "" "%" RETURN (STATUS (DELETED))'
            ],
            resp => {
                for (const tag of ['A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8']) {
                    assert.match(resp, new RegExp('^' + tag + ' BAD ', 'm'));
                }
                assert.doesNotMatch(resp, /^\* (LIST|STATUS)/m);
                done();
            }
        );
    });

    it('reports changes made by another session', (t, done) => {
        const port = ctx.port;
        openSession(port, first => {
            openSession(port, second => {
                first.run('S1 LOGIN testuser testpass', () => {
                    first.run('S2 SELECT INBOX', () => {
                        second.run('T1 LOGIN testuser testpass', () => {
                            second.run('T2 APPEND INBOX {14}\r\nSubject: x\r\n\r\n', () => {
                                first.run('S3 LIST "" "INBOX" RETURN (STATUS (MESSAGES UIDNEXT))', resp => {
                                    // the STATUS response has the new count, EXISTS follows before the tagged response
                                    assert.match(resp, /^\* STATUS INBOX \(MESSAGES 4 UIDNEXT 5\)\r\n\* 4 EXISTS\r\n/m);
                                    first.close();
                                    second.close();
                                    done();
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});

describe('LIST-EXTENDED without LIST-STATUS', () => {
    const ctx = setupServer(() => ({ plugins: ['LIST-EXTENDED'], storage: storage() }));

    it('rejects the STATUS return option (RFC 5258 section 3)', (t, done) => {
        ctx.run([LOGIN, 'A2 LIST "" "%" RETURN (STATUS (MESSAGES))', 'ZZ LOGOUT'], resp => {
            assert.match(resp.toString(), /^A2 BAD /m);
            done();
        });
    });
});

describe('LIST-STATUS loaded together with LIST-EXTENDED', () => {
    for (const plugins of [
        ['LIST-EXTENDED', 'LIST-STATUS'],
        ['LIST-STATUS', 'LIST-EXTENDED']
    ]) {
        const ctx = setupServer(() => ({ plugins, storage: storage() }));

        it(plugins.join(', '), (t, done) => {
            ctx.run([LOGIN, 'A2 CAPABILITY', 'A3 LIST "" "INBOX" RETURN (STATUS (MESSAGES))', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.strictEqual(resp.match(/LIST-EXTENDED/g).length, 1);
                assert.match(resp, /^\* LIST \(\\HasNoChildren\) "\/" "INBOX"\r\n\* STATUS INBOX \(MESSAGES 3\)\r\nA3 OK/m);
                done();
            });
        });
    }
});
