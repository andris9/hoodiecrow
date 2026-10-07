'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');
const { openSession } = require('./helpers/session');
const { toOrderedSet } = require('../lib/esearch');

const message = subject => 'From: sender@example.com\r\nSubject: ' + subject + '\r\n\r\nBody\r\n';

// subjects sort as 2, 3, 1, 4
function storage() {
    return {
        INBOX: {
            messages: [
                { raw: message('charlie'), uid: 1, flags: ['\\Seen'] },
                { raw: message('alpha'), uid: 2 },
                { raw: message('bravo'), uid: 3, flags: ['\\Flagged'] },
                { raw: message('delta'), uid: 4 }
            ]
        },
        '': {}
    };
}

const LOGIN = ['L1 LOGIN testuser testpass', 'L2 SELECT INBOX'];

describe('ESORT', () => {
    // RFC 5267 section 3.2: only increasing runs become ranges
    it('formats ordered sets', () => {
        assert.strictEqual(toOrderedSet([]), '');
        assert.strictEqual(toOrderedSet([3, 2, 1]), '3,2,1');
        assert.strictEqual(toOrderedSet([2, 3, 1, 4, 5, 6]), '2:3,1,4:6');
    });

    describe('with ESORT loaded', () => {
        const ctx = setupServer(() => ({
            plugins: ['ESORT', 'SEARCHRES', 'CONDSTORE'],
            storage: storage()
        }));

        it('advertises ESORT, SORT and ESEARCH', (t, done) => {
            ctx.run(['A1 CAPABILITY', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^\* CAPABILITY .*\bSORT\b.*\bESORT\b/m);
                assert.match(resp, /^\* CAPABILITY .*\bESEARCH\b/m);
                assert.doesNotMatch(resp, /CONTEXT=/);
                done();
            });
        });

        // RFC 5267 section 3.1: MIN and MAX are the first and the last sorted message, ALL is in sort order
        it('returns ESEARCH results in sort order', (t, done) => {
            ctx.run(
                [
                    ...LOGIN,
                    'A1 SORT RETURN (MIN MAX ALL COUNT) (SUBJECT) UTF-8 ALL',
                    'A2 UID SORT RETURN () (REVERSE SUBJECT) UTF-8 ALL',
                    'A3 SORT RETURN (COUNT) (SUBJECT) UTF-8 DELETED',
                    'A4 SORT RETURN (MIN) (SUBJECT) UTF-8 DELETED',
                    'A5 SORT (SUBJECT) UTF-8 ALL',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString();
                    assert.match(resp, /^\* ESEARCH \(TAG "A1"\) MIN 2 MAX 4 ALL 2:3,1,4 COUNT 4\r\nA1 OK /m);
                    assert.match(resp, /^\* ESEARCH \(TAG "A2"\) UID ALL 4,1,3,2\r\nA2 OK /m);
                    assert.match(resp, /^\* ESEARCH \(TAG "A3"\) COUNT 0\r\nA3 OK /m);
                    assert.match(resp, /^\* ESEARCH \(TAG "A4"\)\r\nA4 OK /m);
                    assert.match(resp, /^\* SORT 2 3 1 4\r\nA5 OK /m);
                    done();
                }
            );
        });

        // RFC 5182 section 1: SAVE applies to commands based on SEARCH, like SORT
        it('saves the result of SORT', (t, done) => {
            ctx.run([...LOGIN, 'A1 SORT RETURN (SAVE MAX) (SUBJECT) UTF-8 ALL', 'A2 FETCH $ UID', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^\* ESEARCH \(TAG "A1"\) MAX 4\r\nA1 OK /m);
                assert.match(resp, /^\* 4 FETCH \(UID 4\)\r\nA2 OK /m);
                done();
            });
        });

        // RFC 7162 section 3.1.10
        it('adds MODSEQ for a MODSEQ search', (t, done) => {
            ctx.run([...LOGIN, 'A1 SORT RETURN (ALL) (SUBJECT) UTF-8 MODSEQ 1', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^\* ESEARCH \(TAG "A1"\) ALL 2:3,1,4 MODSEQ 5\r\nA1 OK /m);
                done();
            });
        });

        // RFC 5267 section 4.1: CONTEXT, UPDATE and PARTIAL for SORT come with CONTEXT=SORT
        it('rejects invalid result options', (t, done) => {
            ctx.run(
                [
                    ...LOGIN,
                    'A1 SORT RETURN (FOO) (SUBJECT) UTF-8 ALL',
                    'A2 SORT RETURN (PARTIAL 1:2) (SUBJECT) UTF-8 ALL',
                    'A3 SORT RETURN (UPDATE) (SUBJECT) UTF-8 ALL',
                    'A4 SORT RETURN MIN (SUBJECT) UTF-8 ALL',
                    'A5 SORT (SUBJECT) RETURN (MIN) UTF-8 ALL',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString();
                    for (let i = 1; i <= 4; i++) {
                        assert.match(resp, new RegExp('^A' + i + ' BAD ', 'm'), 'A' + i);
                    }
                    // RETURN after the sort criteria is taken for the charset
                    assert.match(resp, /^A5 NO \[BADCHARSET/m);
                    done();
                }
            );
        });
    });

    describe('with ESORT and CONTEXT=SEARCH loaded', () => {
        const ctx = setupServer(() => ({
            plugins: ['ESORT', 'CONTEXT=SEARCH'],
            storage: storage()
        }));

        it('rejects the CONTEXT=SORT result options for SORT', (t, done) => {
            ctx.run(
                [
                    ...LOGIN,
                    'A1 SORT RETURN (CONTEXT) (SUBJECT) UTF-8 ALL',
                    'A2 SORT RETURN (UPDATE) (SUBJECT) UTF-8 ALL',
                    'A3 SORT RETURN (PARTIAL 1:2) (SUBJECT) UTF-8 ALL',
                    'A4 SEARCH RETURN (CONTEXT PARTIAL 1:2) ALL',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString();
                    assert.match(resp, /^A1 BAD /m);
                    assert.match(resp, /^A2 BAD /m);
                    assert.match(resp, /^A3 BAD /m);
                    assert.match(resp, /^\* ESEARCH \(TAG "A4"\) PARTIAL \(1:2 1:2\)\r\nA4 OK /m);
                    done();
                }
            );
        });
    });

    describe('with ESORT and PARTIAL loaded', () => {
        const ctx = setupServer(() => ({
            plugins: ['ESORT', 'PARTIAL'],
            storage: storage()
        }));

        // RFC 9394 section 3.1, the window is taken from the sorted results
        it('returns a window of the sorted results', (t, done) => {
            ctx.run(
                [...LOGIN, 'A1 SORT RETURN (PARTIAL 2:3) (SUBJECT) UTF-8 ALL', 'A2 UID SORT RETURN (PARTIAL -1:-2) (SUBJECT) UTF-8 ALL', 'ZZ LOGOUT'],
                resp => {
                    resp = resp.toString();
                    assert.match(resp, /^\* ESEARCH \(TAG "A1"\) PARTIAL \(2:3 3,1\)\r\nA1 OK /m);
                    assert.match(resp, /^\* ESEARCH \(TAG "A2"\) UID PARTIAL \(-1:-2 1,4\)\r\nA2 OK /m);
                    done();
                }
            );
        });
    });
});

describe('CONTEXT=SORT', () => {
    const ctx = setupServer(() => ({
        plugins: ['CONTEXT=SORT'],
        storage: storage()
    }));

    it('advertises CONTEXT=SORT, CONTEXT=SEARCH and ESORT', (t, done) => {
        ctx.run(['A1 CAPABILITY', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^\* CAPABILITY .*\bESORT\b/m);
            assert.match(resp, /^\* CAPABILITY .*CONTEXT=SEARCH/m);
            assert.match(resp, /^\* CAPABILITY .*CONTEXT=SORT/m);
            done();
        });
    });

    it('accepts PARTIAL and CONTEXT for SORT', (t, done) => {
        ctx.run(
            [...LOGIN, 'A1 SORT RETURN (CONTEXT PARTIAL 2:3) (SUBJECT) UTF-8 ALL', 'A2 SORT RETURN (PARTIAL -1:-2) (SUBJECT) UTF-8 ALL', 'ZZ LOGOUT'],
            resp => {
                resp = resp.toString();
                assert.match(resp, /^\* ESEARCH \(TAG "A1"\) PARTIAL \(2:3 3,1\)\r\nA1 OK /m);
                // the negative ranges come with the PARTIAL capability (RFC 9394 section 4)
                assert.match(resp, /^A2 BAD /m);
                done();
            }
        );
    });

    // RFC 5267 sections 4.3.3 and 4.3.4: context positions in sort order
    it('sends updates with context positions', (t, done) => {
        ctx.run(
            [
                ...LOGIN,
                'A1 SORT RETURN (UPDATE COUNT) (SUBJECT) UTF-8 UNSEEN',
                'A2 UID SORT RETURN (UPDATE) (REVERSE SUBJECT) UTF-8 UNSEEN',
                'A3 STORE 1 -FLAGS (\\Seen)',
                'A4 STORE 2:3 +FLAGS.SILENT (\\Seen)',
                'A5 STORE 1:4 -FLAGS.SILENT (\\Seen)',
                'A6 STORE 3 +FLAGS.SILENT (\\Deleted)',
                'A7 EXPUNGE',
                'A8 APPEND INBOX {16}\r\nSubject: bingo\r\n',
                'ZZ LOGOUT'
            ],
            resp => {
                resp = resp.toString();
                // sorted results: 2 3 4 and 4 3 2 (UIDs)
                assert.match(resp, /^\* ESEARCH \(TAG "A1"\) COUNT 3\r\nA1 OK /m);
                // charlie (1) goes between bravo and delta
                assert.match(resp, /^\* ESEARCH \(TAG "A1"\) ADDTO \(3 1\)\r\n\* ESEARCH \(TAG "A2"\) UID ADDTO \(2 1\)\r\nA3 OK /m);
                // alpha and bravo are removed from the start, and from the end of the reversed list
                assert.match(resp, /^\* ESEARCH \(TAG "A1"\) REMOVEFROM \(1 2:3\)\r\n\* ESEARCH \(TAG "A2"\) UID REMOVEFROM \(3 3,2\)\r\nA4 OK /m);
                assert.match(resp, /^\* ESEARCH \(TAG "A1"\) ADDTO \(1 2:3\)\r\n\* ESEARCH \(TAG "A2"\) UID ADDTO \(3 3,2\)\r\nA5 OK /m);
                // bravo (3) is the second result and the third one reversed
                assert.match(resp, /^\* ESEARCH \(TAG "A1"\) REMOVEFROM \(2 3\)\r\n\* ESEARCH \(TAG "A2"\) UID REMOVEFROM \(3 3\)\r\n\* 3 EXPUNGE\r\nA7 OK /m);
                // bingo is second, after alpha
                assert.match(resp, /^\* 4 EXISTS\r\n\* ESEARCH \(TAG "A1"\) ADDTO \(2 4\)\r\n\* ESEARCH \(TAG "A2"\) UID ADDTO \(3 5\)\r\nA8 OK /m);
                done();
            }
        );
    });

    it('reports changes made by other sessions', async () => {
        const open = () =>
            new Promise(resolve => {
                openSession(ctx.server.address().port, session => {
                    const cmd = line => new Promise(done => session.run(line, done));
                    cmd('L1 LOGIN testuser testpass')
                        .then(() => cmd('L2 SELECT INBOX'))
                        .then(() => resolve({ cmd, close: () => session.close() }));
                });
            });
        const first = await open();
        const second = await open();
        try {
            await first.cmd('A1 UID SORT RETURN (UPDATE) (SUBJECT) UTF-8 FLAGGED');
            await second.cmd('B1 STORE 1,4 +FLAGS (\\Flagged)');
            const output = await first.cmd('A2 NOOP');
            // charlie and delta follow bravo, in one insertion
            assert.match(output, /^\* ESEARCH \(TAG "A1"\) UID ADDTO \(2 1,4\)\r\nA2 OK /m);
        } finally {
            first.close();
            second.close();
        }
    });
});
