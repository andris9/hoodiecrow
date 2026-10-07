'use strict';

// THREAD=ORDEREDSUBJECT and THREAD=REFERENCES (RFC 5256)

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { setupServer } = require('./helpers');
const { openSession } = require('./helpers/session');

// the messages of the Dovecot comparison scenario, see compare/scenarios/sort-thread.txt
const compareStorage = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'compare', 'storage-sort-thread.json'), 'utf-8'));

const LOGIN = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX'];
const BOTH = ['THREAD=REFERENCES', 'THREAD=ORDEREDSUBJECT'];

const tagged = (resp, tag) => {
    const match = resp.toString('binary').match(new RegExp('^' + tag + ' (OK|NO|BAD)\\b.*$', 'm'));
    assert.ok(match, 'no tagged response for ' + tag + '\n' + resp);
    return match[0];
};

const date = day => 'Date: Mon, 0' + day + ' Jun 2026 10:00:00 +0000';
const message = (...headers) => ({ raw: headers.join('\r\n') + '\r\n\r\nbody\r\n' });

describe('THREAD', () => {
    describe('capabilities', () => {
        describe('without the plugins', () => {
            const ctx = setupServer(() => ({ storage: compareStorage() }));

            it('is an unknown command, and so is UID THREAD', (t, done) => {
                ctx.run([...LOGIN, 'A3 CAPABILITY', 'A4 THREAD REFERENCES UTF-8 ALL', 'A5 UID THREAD REFERENCES UTF-8 ALL', 'ZZ LOGOUT'], resp => {
                    resp = resp.toString('binary');
                    assert.doesNotMatch(resp, /THREAD=/);
                    assert.match(tagged(resp, 'A4'), /^A4 BAD /);
                    assert.match(tagged(resp, 'A5'), /^A5 BAD /);
                    done();
                });
            });
        });

        describe('with THREAD=ORDEREDSUBJECT only', () => {
            const ctx = setupServer(() => ({ plugins: ['THREAD=ORDEREDSUBJECT'], storage: compareStorage() }));

            it('advertises and accepts only that algorithm', (t, done) => {
                ctx.run([...LOGIN, 'A3 CAPABILITY', 'A4 THREAD REFERENCES UTF-8 ALL', 'A5 THREAD ORDEREDSUBJECT UTF-8 1:3', 'ZZ LOGOUT'], resp => {
                    resp = resp.toString('binary');
                    assert.match(resp, /^\* CAPABILITY .* THREAD=ORDEREDSUBJECT( |\r\n)/m);
                    assert.doesNotMatch(resp, /THREAD=REFERENCES/);
                    assert.match(tagged(resp, 'A4'), /^A4 BAD /);
                    assert.match(tagged(resp, 'A5'), /^A5 OK /);
                    done();
                });
            });
        });

        describe('with both algorithms', () => {
            const ctx = setupServer(() => ({ plugins: ['thread-references', 'THREAD=ORDEREDSUBJECT', 'THREAD=REFERENCES'], storage: compareStorage() }));

            it('advertises both, once', (t, done) => {
                ctx.run(['A1 CAPABILITY', 'ZZ LOGOUT'], resp => {
                    resp = resp.toString('binary');
                    assert.match(resp, /^\* CAPABILITY .*THREAD=REFERENCES/m);
                    assert.match(resp, /^\* CAPABILITY .*THREAD=ORDEREDSUBJECT/m);
                    assert.strictEqual(resp.match(/THREAD=REFERENCES/g).length, 1);
                    done();
                });
            });
        });
    });

    // Expected results were checked against Dovecot 2.4.4 with compare/scenarios/sort-thread.txt. Dovecot orders
    // messages 25 and 27 differently, as it uses their internal dates instead of the Date header with an
    // invalid or missing time (RFC 5256 section 2.2)
    describe('on the comparison messages', () => {
        const ctx = setupServer(() => ({ plugins: BOTH, storage: compareStorage() }));

        const CASES = [
            [
                'ORDEREDSUBJECT',
                'THREAD ORDEREDSUBJECT UTF-8 ALL',
                '(3 (2)(1)(15)(10)(14))(4 (6)(12)(8))(5)(7 11)(9)(13)(17)(16)(25)(27)(19 18)(28)(26)(20)(21)(22)(23)(24)(29)(30 (31)(32)(35))(33)(34)'
            ],
            [
                'REFERENCES',
                'THREAD REFERENCES UTF-8 ALL',
                '((4 (12)(8))(5)(6))((1 2 3)(15)(10 9)(14))(7 (11)(13))((17)(16))(25)(27)((19)(18))(28)(26)(20 (21)(24))(22)(23)(29)(35 (30)(31)(32)(34 33))'
            ],
            [
                'REFERENCES with search criteria, lower case algorithm and charset',
                'THREAD references utf-8 NOT SUBJECT topic',
                '((1 2 3)(15)(10 9)(14))(5)(7 (11)(13))((17)(16))(25)(27)((19)(18))(28)(26)(20 (21)(24))(22)(23)(29)(35 (30)(31)(32)(34 33))'
            ],
            ['REFERENCES with sequence numbers in the criteria', 'THREAD REFERENCES "US-ASCII" 1:5', '((4)(5))(1 2 3)']
        ];

        for (const [description, command, expected] of CASES) {
            it(description, (t, done) => {
                ctx.run([...LOGIN, 'A3 ' + command, 'ZZ LOGOUT'], resp => {
                    resp = resp.toString('binary');
                    assert.ok(resp.indexOf('\r\n* THREAD ' + expected + '\r\nA3 OK THREAD completed\r\n') >= 0, resp);
                    done();
                });
            });
        }

        it('sends an empty THREAD response when nothing matches (RFC 5256 section 5: thread-data)', (t, done) => {
            ctx.run(
                [...LOGIN, 'A3 THREAD REFERENCES US-ASCII TEXT "not in mailbox"', 'A4 THREAD ORDEREDSUBJECT UTF-8 TEXT "not in mailbox"', 'ZZ LOGOUT'],
                resp => {
                    resp = resp.toString('binary');
                    assert.ok(resp.indexOf('\r\n* THREAD\r\nA3 OK THREAD completed\r\n') >= 0, resp);
                    assert.ok(resp.indexOf('\r\n* THREAD\r\nA4 OK THREAD completed\r\n') >= 0, resp);
                    done();
                }
            );
        });
    });

    // Small mailboxes for the separate steps of the algorithms, every result was checked against Dovecot 2.4.4
    describe('algorithm steps', () => {
        const FOLDERS = {
            ordered: [
                message('Subject: Hello', date(3)),
                message('Subject: Re: hello', date(1)),
                message('Subject: other', date(2)),
                message('Subject: hello (fwd)', date(4)),
                message('Subject:', 'Date: Sun, 31 May 2026 10:00:00 +0000')
            ],
            single: [message('Subject: one', date(1), 'References: <lost@x>')],
            siblings: [message('Subject: one', date(2), 'References: <lost@x>'), message('Subject: two', date(1), 'References: <lost@x>')],
            inner: [message('Subject: one', date(1), 'Message-ID: <a@x>'), message('Subject: two', date(2), 'References: <a@x> <lost@x>')],
            reply: [message('Subject: topic', date(1)), message('Subject: Re: topic', date(2))],
            same: [message('Subject: topic', date(2)), message('Subject: topic', date(1))],
            replyfirst: [message('Subject: Re: topic', date(1)), message('Subject: topic', date(2))],
            empty: [message('Subject:', date(1)), message('Subject: Re:', date(2))],
            tree: [
                message('Subject: x', date(3), 'Message-ID: <a@x>'),
                message('Subject: y', date(1), 'Message-ID: <b@x>', 'References: <a@x>'),
                message('Subject: z', date(2), 'References: <a@x>'),
                message('Subject: w', date(4), 'References: <b@x>'),
                message('Subject: v', date(5), 'References: <b@x>')
            ],
            dummies: [
                message('Subject: topic', date(1), 'References: <lost1@x>'),
                message('Subject: topic', date(2), 'References: <lost1@x>'),
                message('Subject: Re: topic', date(3), 'References: <lost2@x>'),
                message('Subject: Re: topic', date(4), 'References: <lost2@x>')
            ],
            dummyfirst: [
                message('Subject: Re: topic', date(1), 'References: <lost1@x>'),
                message('Subject: Re: topic', date(2), 'References: <lost1@x>'),
                message('Subject: topic', date(3))
            ],
            loop: [
                message('Subject: a', date(1), 'Message-ID: <a@x>', 'References: <b@x>'),
                message('Subject: b', date(2), 'Message-ID: <b@x>', 'References: <a@x>')
            ],
            duplicate: [
                message('Subject: a', date(1), 'Message-ID: <a@x>'),
                message('Subject: b', date(2), 'Message-ID: <a@x>', 'References: <a@x>'),
                message('Subject: c', date(3), 'References: <a@x>')
            ]
        };

        const ctx = setupServer(() => {
            const folders = {};
            for (const name of Object.keys(FOLDERS)) {
                folders[name] = { messages: FOLDERS[name].map(item => Object.assign({}, item)) };
            }
            return { plugins: BOTH, storage: { INBOX: {}, '': { separator: '/', folders } } };
        });

        const CASES = [
            // [folder, description, REFERENCES result, ORDEREDSUBJECT result]
            ['ordered', 'threads by base subject, ordered by the first sent date', '(5)(3)(1 (2)(4))', '(5)(2 (1)(4))(3)'],
            ['single', 'a dummy with one child at the top level is replaced by the child (step 3)', '(1)', '(1)'],
            ['siblings', 'a dummy with several children stays at the top level (step 3)', '((2)(1))', '(2)(1)'],
            ['inner', 'a dummy below the top level is replaced by its children (step 3)', '(1 2)', '(1)(2)'],
            ['reply', 'a reply joins the thread with the same subject (step 5.C)', '(1 2)', '(1 2)'],
            ['same', 'messages with the same subject that are not replies get a dummy parent (step 5.C)', '((2)(1))', '(2 1)'],
            ['replyfirst', 'a message that is not a reply replaces a reply in the subject table (step 5.B)', '(2 1)', '(1 2)'],
            ['empty', 'empty subjects are not gathered (step 5.B.ii)', '(1)(2)', '(1 2)'],
            ['tree', 'siblings are sorted by sent date at every level (step 6)', '(1 (2 (4)(5))(3))', '(2)(3)(1)(4)(5)'],
            ['dummies', 'the children of two dummies with the same subject are merged (step 5.C)', '((1)(2)(3)(4))', '(1 (2)(3)(4))'],
            ['dummyfirst', 'a message joins a dummy with the same subject (step 5.C)', '((1)(2)(3))', '(1 (2)(3))'],
            ['loop', 'links that would introduce a loop are not created (step 1.A)', '(2 1)', '(1)(2)'],
            ['duplicate', 'a duplicate Message-ID is only used for the first message (step 1.A)', '(1 (2)(3))', '(1)(2)(3)']
        ];

        for (const [folder, description, references, orderedSubject] of CASES) {
            it(description, (t, done) => {
                ctx.run(
                    ['A1 LOGIN testuser testpass', 'A2 SELECT ' + folder, 'A3 THREAD REFERENCES UTF-8 ALL', 'A4 THREAD ORDEREDSUBJECT UTF-8 ALL', 'ZZ LOGOUT'],
                    resp => {
                        resp = resp.toString('binary');
                        assert.ok(resp.indexOf('\r\n* THREAD ' + references + '\r\nA3 OK') >= 0, resp);
                        assert.ok(resp.indexOf('\r\n* THREAD ' + orderedSubject + '\r\nA4 OK') >= 0, resp);
                        done();
                    }
                );
            });
        }
    });

    // A client can APPEND messages with any references, so threading must not recurse per level or loop forever
    describe('hostile references', () => {
        const DEPTH = 50000;
        const ids = Array.from({ length: DEPTH }, (v, i) => '<r' + i + '@x>');

        const ctx = setupServer(() => ({
            plugins: BOTH,
            storage: {
                INBOX: {},
                '': {
                    separator: '/',
                    folders: {
                        // one message with a References header that is 50000 levels deep
                        header: { messages: [message('Subject: deep', date(1), 'Message-ID: <deep@x>', 'References: ' + ids.join(' '))] },
                        // 50000 messages, each a reply to the one before
                        chain: {
                            messages: ids.map((id, i) =>
                                message('Subject: chain ' + i, date(1), 'Message-ID: ' + id, i ? 'In-Reply-To: ' + ids[i - 1] : 'X-First: yes')
                            )
                        },
                        // references that form loops, also inside one header
                        loops: {
                            messages: [
                                message('Subject: a', date(1), 'Message-ID: <a@x>', 'References: <c@x> <b@x> <a@x> <c@x>'),
                                message('Subject: b', date(2), 'Message-ID: <b@x>', 'References: <a@x> <c@x> <a@x>'),
                                message('Subject: c', date(3), 'Message-ID: <c@x>', 'References: <b@x> <c@x> <c@x>')
                            ]
                        }
                    }
                }
            }
        }));

        const thread = (folder, command) =>
            new Promise(resolve => {
                ctx.run(['A1 LOGIN testuser testpass', 'A2 SELECT ' + folder, 'A3 ' + command, 'ZZ LOGOUT'], resp => resolve(resp.toString('binary')));
            });

        it('handles a References header with 50000 Message IDs', async () => {
            const resp = await thread('header', 'THREAD REFERENCES UTF-8 ALL');
            assert.ok(resp.indexOf('\r\n* THREAD (1)\r\nA3 OK THREAD completed\r\n') >= 0, resp);
        });

        it('handles a reply chain of 50000 messages', async () => {
            const resp = await thread('chain', 'THREAD REFERENCES UTF-8 ALL');
            const expected = '* THREAD (' + Array.from({ length: DEPTH }, (v, i) => i + 1).join(' ') + ')\r\nA3 OK THREAD completed\r\n';
            assert.ok(resp.indexOf(expected) >= 0, resp.substr(0, 1000));
        });

        it('does not follow reference loops', async () => {
            const resp = await thread('loops', 'THREAD REFERENCES UTF-8 ALL');
            assert.match(resp, /^\* THREAD \(\d+ \d+ \d+\)\r\nA3 OK THREAD completed\r\n/m);
        });
    });

    describe('UIDs', () => {
        const ctx = setupServer(() => ({
            plugins: BOTH,
            storage: {
                INBOX: {
                    messages: [
                        Object.assign(message('Subject: topic', date(1), 'Message-ID: <a@x>'), { uid: 10 }),
                        Object.assign(message('Subject: Re: topic', date(2), 'References: <a@x>'), { uid: 20 }),
                        Object.assign(message('Subject: other', date(3)), { uid: 35 })
                    ]
                }
            }
        }));

        it('THREAD lists sequence numbers and UID THREAD lists UIDs (RFC 5256 section 4)', (t, done) => {
            ctx.run(
                [...LOGIN, 'A3 THREAD REFERENCES UTF-8 ALL', 'A4 UID THREAD REFERENCES UTF-8 ALL', 'A5 UID THREAD ORDEREDSUBJECT UTF-8 2:3', 'ZZ LOGOUT'],
                resp => {
                    resp = resp.toString('binary');
                    assert.ok(resp.indexOf('\r\n* THREAD (1 2)(3)\r\nA3 OK THREAD completed\r\n') >= 0, resp);
                    assert.ok(resp.indexOf('\r\n* THREAD (10 20)(35)\r\nA4 OK UID THREAD completed\r\n') >= 0, resp);
                    // the search criteria of UID THREAD use sequence numbers, like UID SEARCH
                    assert.ok(resp.indexOf('\r\n* THREAD (20)(35)\r\nA5 OK UID THREAD completed\r\n') >= 0, resp);
                    done();
                }
            );
        });
    });

    describe('errors', () => {
        const ctx = setupServer(() => ({ plugins: BOTH, storage: compareStorage() }));

        const CASES = [
            // RFC 5256 section 5: thread-alg is an atom, followed by the mandatory charset and the search criteria
            ['an unknown algorithm', 'THREAD BOGUS UTF-8 ALL', 'BAD'],
            ['a quoted algorithm', 'THREAD "REFERENCES" UTF-8 ALL', 'BAD'],
            ['a missing algorithm', 'THREAD', 'BAD'],
            ['a missing charset and search criteria', 'THREAD REFERENCES', 'BAD'],
            ['missing search criteria', 'THREAD REFERENCES UTF-8', 'BAD'],
            ['a charset given as a literal', 'THREAD REFERENCES {5}\r\nUTF-8 ALL', 'BAD'],
            ['an unknown search key', 'THREAD REFERENCES UTF-8 BOGUS', 'BAD'],
            ['an unsupported charset', 'THREAD REFERENCES KOI8-R ALL', 'NO'],
            ['the same errors in UID THREAD', 'UID THREAD BOGUS UTF-8 ALL', 'BAD']
        ];

        for (const [description, command, expected] of CASES) {
            it('answers ' + expected + ' to ' + description, (t, done) => {
                ctx.run([...LOGIN, 'A3 ' + command, 'ZZ LOGOUT'], resp => {
                    assert.match(tagged(resp, 'A3'), new RegExp('^A3 ' + expected + ' '));
                    assert.doesNotMatch(resp.toString('binary'), /^\* THREAD/m);
                    done();
                });
            });
        }

        it('reports the supported charsets with BADCHARSET (RFC 5256 section 3, RFC 3501 section 7.1)', (t, done) => {
            ctx.run([...LOGIN, 'A3 THREAD ORDEREDSUBJECT KOI8-R ALL', 'ZZ LOGOUT'], resp => {
                assert.match(tagged(resp, 'A3'), /^A3 NO \[BADCHARSET \(US-ASCII UTF-8\)\] /);
                done();
            });
        });

        it('is refused without a selected mailbox', (t, done) => {
            ctx.run(['A1 LOGIN testuser testpass', 'A2 THREAD REFERENCES UTF-8 ALL', 'A3 UID THREAD REFERENCES UTF-8 ALL', 'ZZ LOGOUT'], resp => {
                assert.match(tagged(resp, 'A2'), /^A2 BAD /);
                assert.match(tagged(resp, 'A3'), /^A3 BAD /);
                done();
            });
        });
    });

    describe('multiple sessions', () => {
        const ctx = setupServer(() => ({
            plugins: BOTH,
            storage: {
                INBOX: {
                    messages: [1, 2, 3].map(i => message('Subject: topic ' + i, date(i)))
                }
            }
        }));

        let sessions = [];
        afterEach(() => {
            sessions.forEach(session => session.close());
            sessions = [];
        });

        const open = () =>
            new Promise(resolve => {
                openSession(ctx.server.address().port, session => {
                    sessions.push(session);
                    const cmd = line => new Promise(done => session.run(line, done));
                    cmd('S1 LOGIN testuser testpass')
                        .then(() => cmd('S2 SELECT INBOX'))
                        .then(() => resolve({ cmd, session }));
                });
            });

        it('does not send EXPUNGE during THREAD, but does during UID THREAD (RFC 5256 section 3)', async () => {
            const a = await open();
            const b = await open();

            await b.cmd('B1 STORE 1 +FLAGS.SILENT (\\Deleted)');
            await b.cmd('B2 EXPUNGE');

            let output = await a.cmd('A1 THREAD ORDEREDSUBJECT UTF-8 ALL');
            // the EXPUNGE is pending, EXPUNGEISSUED tells the client (RFC 5530 section 3)
            assert.strictEqual(output, '* THREAD (1)(2)(3)\r\nA1 OK [EXPUNGEISSUED] THREAD completed\r\n');

            output = await a.cmd('A2 UID THREAD ORDEREDSUBJECT UTF-8 ALL');
            assert.match(output, /^\* THREAD \(1\)\(2\)\(3\)\r\n\* 1 EXPUNGE\r\n/);

            output = await a.cmd('A3 THREAD ORDEREDSUBJECT UTF-8 ALL');
            assert.strictEqual(output, '* THREAD (1)(2)\r\nA3 OK THREAD completed\r\n');
        });

        it('may be pipelined with FETCH, but not after UID THREAD (RFC 3501 section 5.5)', async () => {
            const { session } = await open();

            let output = await new Promise(done => session.run('P1 THREAD REFERENCES UTF-8 ALL\r\nP2 FETCH 1 FLAGS', done, 'P2'));
            assert.match(output, /^P1 OK /m);
            assert.match(output, /^P2 OK /m);

            output = await new Promise(done => session.run('P3 UID THREAD REFERENCES UTF-8 ALL\r\nP4 FETCH 1 FLAGS', done, 'P4'));
            assert.match(output, /^P4 BAD /m);

            output = await new Promise(done => session.run('P5 NOOP\r\nP6 THREAD REFERENCES UTF-8 2', done, 'P6'));
            assert.match(output, /^P6 BAD /m);
        });
    });
});
