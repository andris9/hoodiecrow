'use strict';

// OBJECTID, RFC 8474 (https://www.rfc-editor.org/rfc/rfc8474.txt)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const imapkit = require('../lib/server');
const { setupServer } = require('./helpers');
const { openSession } = require('./helpers/session');

const LOGIN = 'L1 LOGIN testuser testpass';

function storage() {
    return {
        INBOX: {
            messages: [
                { raw: 'Message-ID: <a@example.com>\r\nSubject: A\r\n\r\nfirst' },
                { raw: 'Message-ID: <b@example.com>\r\nIn-Reply-To: <a@example.com>\r\nSubject: Re: A\r\n\r\nreply' },
                { raw: 'Message-ID: <c@example.com>\r\nSubject: C\r\n\r\nother' },
                {
                    raw: 'Message-ID: <d@example.com>\r\nReferences: <a@example.com>\r\n <b@example.com>\r\nSubject: Re: A\r\n\r\nfolded references'
                }
            ]
        },
        '': {
            folders: {
                Archive: {
                    MAILBOXID: 'Farchive',
                    messages: [{ raw: 'Subject: kept\r\n\r\nstored ids', EMAILID: 'Mstored', THREADID: 'Tstored' }]
                }
            }
        }
    };
}

describe('OBJECTID', () => {
    const ctx = setupServer(() => ({ plugins: ['OBJECTID', 'UIDPLUS', 'MOVE'], storage: storage() }));

    // RFC 8474 section 3
    it('advertises OBJECTID', (t, done) => {
        ctx.run([LOGIN, 'A1 CAPABILITY', 'ZZ LOGOUT'], resp => {
            assert.match(resp.toString(), /^\* CAPABILITY .*\bOBJECTID\b/m);
            done();
        });
    });

    // RFC 8474 section 4.2: an untagged OK [MAILBOXID] on every successful SELECT and EXAMINE
    it('SELECT and EXAMINE report the MAILBOXID', (t, done) => {
        ctx.run([LOGIN, 'A1 SELECT INBOX', 'A2 EXAMINE Archive', 'A3 SELECT Nope', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^\* OK \[MAILBOXID \(F1\)\] Ok\r\nA1 OK \[READ-WRITE\]/m);
            assert.match(resp, /^\* OK \[MAILBOXID \(Farchive\)\] Ok\r\nA2 OK \[READ-ONLY\]/m);
            assert.match(resp, /^A3 NO /m);
            assert.strictEqual(resp.match(/MAILBOXID/g).length, 2);
            done();
        });
    });

    // RFC 8474 sections 4.1 and 4.3
    it('CREATE reports the MAILBOXID of the new mailbox, STATUS returns it', (t, done) => {
        ctx.run([LOGIN, 'A1 CREATE foo/', 'A2 STATUS foo (MAILBOXID MESSAGES)', 'A3 STATUS Archive (MAILBOXID)', 'A4 CREATE foo', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            const id = resp.match(/^A1 OK \[MAILBOXID \(([A-Za-z0-9_-]+)\)\] /m);
            assert.ok(id, resp);
            assert.notStrictEqual(id[1], 'F1');
            assert.match(resp, new RegExp('^\\* STATUS foo \\(MAILBOXID \\(' + id[1] + '\\) MESSAGES 0\\)', 'm'));
            assert.match(resp, /^\* STATUS Archive \(MAILBOXID \(Farchive\)\)/m);
            assert.match(resp, /^A4 NO \[ALREADYEXISTS\] [^[]*$/m);
            done();
        });
    });

    // RFC 8474 section 4: the id stays with a renamed mailbox, a re-created mailbox is a new one
    it('keeps the MAILBOXID on RENAME and never reuses it', (t, done) => {
        ctx.run(
            [
                LOGIN,
                'A1 RENAME Archive Old',
                'A2 STATUS Old (MAILBOXID)',
                'A3 CREATE Archive',
                'A4 DELETE Old',
                'A5 CREATE Old',
                'A6 RENAME INBOX Saved',
                'A7 STATUS INBOX (MAILBOXID)',
                'A8 STATUS Saved (MAILBOXID)',
                'ZZ LOGOUT'
            ],
            resp => {
                resp = resp.toString();
                assert.match(resp, /^\* STATUS Old \(MAILBOXID \(Farchive\)\)/m);
                assert.match(resp, /^A3 OK \[MAILBOXID \(F\d+\)\] /m);
                assert.match(resp, /^A5 OK \[MAILBOXID \(F\d+\)\] /m);
                assert.doesNotMatch(resp, /^A5 OK \[MAILBOXID \(Farchive\)\]/m);
                // RFC 8474 section 8.2: renaming INBOX moves the messages to a new mailbox
                assert.match(resp, /^\* STATUS INBOX \(MAILBOXID \(F1\)\)/m);
                assert.doesNotMatch(resp, /^\* STATUS Saved \(MAILBOXID \(F1\)\)/m);
                const ids = resp.match(/MAILBOXID \(F\d+\)/g);
                assert.strictEqual(new Set(ids).size, ids.length, resp);
                done();
            }
        );
    });

    // a mailbox that is deleted while it has children stays as a \Noselect placeholder, creating it again makes a new mailbox
    it('gives a re-created placeholder a new MAILBOXID', (t, done) => {
        ctx.run([LOGIN, 'A1 CREATE p/c', 'A2 STATUS p (MAILBOXID)', 'A3 DELETE p', 'A4 CREATE p', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            const old = resp.match(/^\* STATUS p \(MAILBOXID \((F\d+)\)\)/m)[1];
            const created = resp.match(/^A4 OK \[MAILBOXID \((F\d+)\)\]/m)[1];
            assert.notStrictEqual(old, created);
            done();
        });
    });

    // RFC 8474 sections 5.2 and 5.3: threads by In-Reply-To and References, folded headers included
    it('FETCH returns EMAILID and THREADID', (t, done) => {
        ctx.run([LOGIN, 'L2 SELECT INBOX', 'A1 FETCH 1:* (EMAILID THREADID)', 'A2 UID FETCH 1 EMAILID', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^\* 1 FETCH \(EMAILID \(M1\) THREADID \(T1\)\)/m);
            assert.match(resp, /^\* 2 FETCH \(EMAILID \(M2\) THREADID \(T1\)\)/m);
            assert.match(resp, /^\* 3 FETCH \(EMAILID \(M3\) THREADID \(T2\)\)/m);
            assert.match(resp, /^\* 4 FETCH \(EMAILID \(M4\) THREADID \(T1\)\)/m);
            assert.match(resp, /^\* 1 FETCH \(EMAILID \(M1\) UID 1\)/m);
            done();
        });
    });

    it('uses ids from storage', (t, done) => {
        ctx.run([LOGIN, 'L2 SELECT Archive', 'A1 FETCH 1 (EMAILID THREADID)', 'ZZ LOGOUT'], resp => {
            assert.match(resp.toString(), /^\* 1 FETCH \(EMAILID \(Mstored\) THREADID \(Tstored\)\)/m);
            done();
        });
    });

    // RFC 8474 section 5.1: the copy in the COPYUID pairing has the EMAILID of the source, for COPY and MOVE
    it('COPY and MOVE keep EMAILID and THREADID', (t, done) => {
        ctx.run(
            [LOGIN, 'L2 SELECT INBOX', 'A1 COPY 2 Archive', 'A2 MOVE 3 Archive', 'A3 SELECT Archive', 'A4 FETCH 1:* (UID EMAILID THREADID)', 'ZZ LOGOUT'],
            resp => {
                resp = resp.toString();
                assert.match(resp, /^A1 OK \[COPYUID 1 2 2\]/m);
                assert.match(resp, /^\* 2 FETCH \(UID 2 EMAILID \(M2\) THREADID \(T1\)\)/m);
                assert.match(resp, /^\* 3 FETCH \(UID 3 EMAILID \(M3\) THREADID \(T2\)\)/m);
                done();
            }
        );
    });

    // replies that arrive later join the thread, new messages get new ids
    it('APPEND assigns new ids and threads replies', (t, done) => {
        ctx.run(
            [
                LOGIN,
                'A1 APPEND INBOX {66}\r\nMessage-ID: <e@example.com>\r\nIn-Reply-To: <c@example.com>\r\n\r\nreply',
                'A2 APPEND INBOX {11}\r\nno headers!',
                'L2 SELECT INBOX',
                'A3 FETCH 5:6 (EMAILID THREADID)',
                'ZZ LOGOUT'
            ],
            resp => {
                resp = resp.toString();
                assert.match(resp, /^\* 5 FETCH \(EMAILID \(M\d+\) THREADID \(T2\)\)/m);
                assert.match(resp, /^\* 6 FETCH \(EMAILID \(M\d+\) THREADID \(T\d+\)\)/m);
                const emailIds = resp.match(/EMAILID \((M\d+)\)/g);
                assert.notStrictEqual(emailIds[0], emailIds[1]);
                assert.doesNotMatch(resp, /^\* 6 FETCH \(EMAILID \(M\d+\) THREADID \(T[12]\)\)/m);
                done();
            }
        );
    });

    // RFC 8474 section 6
    it('SEARCH by EMAILID and THREADID', (t, done) => {
        ctx.run(
            [
                LOGIN,
                'L2 SELECT INBOX',
                'A1 SEARCH EMAILID M2',
                'A2 SEARCH THREADID T1',
                'A3 UID SEARCH OR EMAILID M3 EMAILID M4',
                'A4 SEARCH THREADID m1',
                'ZZ LOGOUT'
            ],
            resp => {
                resp = resp.toString();
                assert.match(resp, /^\* SEARCH 2\r\nA1 OK/m);
                assert.match(resp, /^\* SEARCH 1 2 4\r\nA2 OK/m);
                assert.match(resp, /^\* SEARCH 3 4\r\nA3 OK/m);
                // object identifiers are case sensitive
                assert.match(resp, /^\* SEARCH\r\nA4 OK/m);
                done();
            }
        );
    });

    // RFC 8474 section 7: search-key =/ "EMAILID" SP objectid, objectid = 1*255(ALPHA / DIGIT / "_" / "-")
    it('SEARCH refuses invalid object identifiers', (t, done) => {
        ctx.run(
            [
                LOGIN,
                'L2 SELECT INBOX',
                'A1 SEARCH EMAILID "M 1"',
                'A2 SEARCH THREADID ""',
                'A3 SEARCH EMAILID ' + 'M'.repeat(256),
                'A4 SEARCH EMAILID',
                'ZZ LOGOUT'
            ],
            resp => {
                resp = resp.toString();
                assert.match(resp, /^A1 BAD /m);
                assert.match(resp, /^A2 BAD /m);
                assert.match(resp, /^A3 BAD /m);
                assert.match(resp, /^A4 BAD /m);
                done();
            }
        );
    });

    // other sessions see the same ids
    it('ids are shared between sessions', (t, done) => {
        openSession(ctx.server.address().port, first => {
            openSession(ctx.server.address().port, second => {
                first.run(LOGIN, () => {
                    second.run(LOGIN, () => {
                        first.run('A1 CREATE shared', created => {
                            second.run('B1 STATUS shared (MAILBOXID)', status => {
                                const id = created.match(/MAILBOXID \((F\d+)\)/)[1];
                                assert.match(status, new RegExp('^\\* STATUS shared \\(MAILBOXID \\(' + id + '\\)\\)', 'm'));
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

    it('refuses invalid or conflicting ids in storage', () => {
        const build = (inbox, folders) => () => imapkit({ plugins: ['OBJECTID'], storage: { INBOX: inbox, '': { folders: folders || {} } } });
        assert.throws(build({ MAILBOXID: 'with space' }), /Invalid MAILBOXID/);
        assert.throws(build({}, { a: { MAILBOXID: 'Fx' }, b: { MAILBOXID: 'Fx' } }), /Duplicate MAILBOXID/);
        assert.throws(build({ messages: [{ raw: 'x', EMAILID: 'M.1' }] }), /Invalid EMAILID/);
        assert.throws(build({ messages: [{ raw: 'x', THREADID: 'x'.repeat(256) }] }), /Invalid THREADID/);
        assert.throws(build({ messages: [{ raw: 'x', EMAILID: 'Same', THREADID: 'Same' }] }), /already used/);
        assert.throws(
            build({
                messages: [
                    { raw: 'x', EMAILID: 'Mx', THREADID: 'T1' },
                    { raw: 'x', EMAILID: 'Mx', THREADID: 'T2' }
                ]
            }),
            /same THREADID/
        );
    });

    it('leaves no trace without the plugin', (t, done) => {
        const server = imapkit({ storage: storage() });
        assert.strictEqual(server.getMailbox('INBOX').MAILBOXID, undefined);
        assert.strictEqual(server.getMailbox('INBOX').messages[0].EMAILID, undefined);
        done();
    });
});

describe('OBJECTID with LIST-STATUS', () => {
    const ctx = setupServer(() => ({ plugins: ['OBJECTID', 'LIST-STATUS'], storage: storage() }));

    // RFC 8474 section 4.3: MAILBOXID with the STATUS return option of LIST (RFC 5819)
    it('returns MAILBOXID with LIST', (t, done) => {
        ctx.run([LOGIN, 'A1 LIST "" "*" RETURN (STATUS (MAILBOXID MESSAGES))', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^\* STATUS INBOX \(MAILBOXID \(F1\) MESSAGES 4\)\r\n/m);
            assert.match(resp, /^\* STATUS Archive \(MAILBOXID \(Farchive\) MESSAGES 1\)\r\n/m);
            done();
        });
    });
});

// X-GM-EXT-1 and OBJECTID group the same messages into threads, in any load order
for (const plugins of [
    ['X-GM-EXT-1', 'OBJECTID'],
    ['OBJECTID', 'X-GM-EXT-1']
]) {
    describe('OBJECTID with X-GM-EXT-1 (' + plugins.join(', ') + ')', () => {
        const ctx = setupServer(() => ({ plugins, storage: storage() }));

        it('gives the messages of a THREADID the same X-GM-THRID', (t, done) => {
            const message = 'Message-ID: <e@example.com>\r\nIn-Reply-To: <d@example.com>\r\n\r\nlate reply';
            const cmds = [
                LOGIN,
                'A1 APPEND INBOX {' + message.length + '}\r\n' + message,
                'A2 EXAMINE INBOX',
                'A3 FETCH 1:* (THREADID X-GM-MSGID X-GM-THRID)',
                'ZZ LOGOUT'
            ];
            ctx.run(cmds, resp => {
                resp = resp.toString();
                const rows = [...resp.matchAll(/^\* (\d+) FETCH \(THREADID \((\w+)\) X-GM-MSGID (\d+) X-GM-THRID (\d+)\)\r$/gm)].map(m => ({
                    thread: m[2],
                    msgid: m[3],
                    thrid: m[4]
                }));
                assert.strictEqual(rows.length, 5, resp);
                // messages 1, 2, 4 and the appended 5 are one thread, the X-GM-THRID is the X-GM-MSGID of message 1
                [1, 3, 4].forEach(i => {
                    assert.strictEqual(rows[i].thread, rows[0].thread);
                    assert.strictEqual(rows[i].thrid, rows[0].msgid);
                });
                assert.notStrictEqual(rows[2].thread, rows[0].thread);
                assert.strictEqual(rows[2].thrid, rows[2].msgid);
                done();
            });
        });
    });
}

describe('OBJECTID without the plugin', () => {
    const ctx = setupServer(() => ({ storage: storage() }));

    it('refuses the new items', (t, done) => {
        ctx.run([LOGIN, 'A1 STATUS INBOX (MAILBOXID)', 'L2 SELECT INBOX', 'A2 FETCH 1 EMAILID', 'A3 SEARCH THREADID T1', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^A1 BAD /m);
            assert.match(resp, /^A2 BAD /m);
            assert.match(resp, /^A3 BAD /m);
            assert.doesNotMatch(resp, /MAILBOXID \(/);
            done();
        });
    });
});
