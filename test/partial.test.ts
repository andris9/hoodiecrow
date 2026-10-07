import { describe, it } from 'node:test';
import assert from 'node:assert';
import { setupServer } from './helpers/index.js';
import { parsePartialRange, selectPartial } from '../src/esearch.js';

function storage() {
    return {
        INBOX: {
            messages: [
                { raw: 'Subject: hello 1\r\n\r\nWorld 1!', flags: ['\\Seen'], uid: 10 },
                { raw: 'Subject: hello 2\r\n\r\nWorld 2!', flags: ['\\Flagged'], uid: 20 },
                { raw: 'Subject: hello 3\r\n\r\nWorld 3!', flags: ['\\Flagged'], uid: 21 },
                { raw: 'Subject: hello 4\r\n\r\nWorld 4!', uid: 22 },
                { raw: 'Subject: hello 5\r\n\r\nWorld 5!', flags: ['\\Flagged'], uid: 30 }
            ],
            uidnext: 31
        },
        '': {}
    };
}

const LOGIN = ['L1 LOGIN testuser testpass', 'L2 SELECT INBOX'];

describe('PARTIAL', () => {
    describe('helpers', () => {
        // RFC 9394 section 4: partial-range-first / partial-range-last, 500:400 is the same as 400:500
        it('parses ranges', () => {
            assert.deepStrictEqual(parsePartialRange({ type: 'SEQUENCE', value: '5:2' }, false), { range: '5:2', from: 2, to: 5, fromEnd: false });
            assert.deepStrictEqual(parsePartialRange({ type: 'ATOM', value: '-1:-100' }, true), { range: '-1:-100', from: 1, to: 100, fromEnd: true });
            const bad = ['-1:-100', '1:-2', '0:5', '1:*', '5', '1:4294967296', '', '1:2:3'];
            bad.forEach(value => assert.throws(() => parsePartialRange({ type: 'ATOM', value }, value === '1:-2'), /PARTIAL/, value));
            assert.throws(() => parsePartialRange({ type: 'ATOM', value: '-1:-100' }, false), /PARTIAL/);
            assert.throws(() => parsePartialRange({ type: 'STRING', value: '1:2' }, true), /PARTIAL/);
            assert.throws(() => parsePartialRange(undefined, true), /PARTIAL/);
        });

        // RFC 9394 section 3.1: the first result is 1, -1 is the last one
        it('selects windows', () => {
            const list = ['a', 'b', 'c', 'd', 'e'];
            const pick = (value: string) => selectPartial(list, parsePartialRange({ type: 'ATOM', value }, true));
            assert.deepStrictEqual(pick('1:2'), ['a', 'b']);
            assert.deepStrictEqual(pick('4:9'), ['d', 'e']);
            assert.deepStrictEqual(pick('6:9'), []);
            assert.deepStrictEqual(pick('-1:-2'), ['d', 'e']);
            assert.deepStrictEqual(pick('-2:-1'), ['d', 'e']);
            assert.deepStrictEqual(pick('-4:-10'), ['a', 'b']);
            assert.deepStrictEqual(pick('-6:-10'), []);
        });
    });

    describe('with PARTIAL loaded', () => {
        const ctx = setupServer(() => ({
            plugins: ['PARTIAL'],
            storage: storage()
        }));

        it('advertises PARTIAL and ESEARCH', (t, done) => {
            ctx.run(['A1 CAPABILITY', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^\* CAPABILITY .* ESEARCH .*PARTIAL(\r| )/m);
                done();
            });
        });

        // RFC 9394 section 3.1
        it('returns a window of the results', (t, done) => {
            ctx.run(
                [
                    ...LOGIN,
                    'A1 SEARCH RETURN (PARTIAL 1:2) ALL',
                    'A2 UID SEARCH RETURN (PARTIAL 2:3) ALL',
                    'A3 UID SEARCH RETURN (PARTIAL -1:-2) ALL',
                    'A4 SEARCH RETURN (PARTIAL 3:1) FLAGGED',
                    'A5 UID SEARCH RETURN (PARTIAL -3:-1) FLAGGED',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString();
                    assert.match(resp, /^\* ESEARCH \(TAG "A1"\) PARTIAL \(1:2 1:2\)\r\nA1 OK /m);
                    assert.match(resp, /^\* ESEARCH \(TAG "A2"\) UID PARTIAL \(2:3 20:21\)\r\nA2 OK /m);
                    assert.match(resp, /^\* ESEARCH \(TAG "A3"\) UID PARTIAL \(-1:-2 22,30\)\r\nA3 OK /m);
                    assert.match(resp, /^\* ESEARCH \(TAG "A4"\) PARTIAL \(3:1 2:3,5\)\r\nA4 OK /m);
                    assert.match(resp, /^\* ESEARCH \(TAG "A5"\) UID PARTIAL \(-3:-1 20:21,30\)\r\nA5 OK /m);
                    done();
                }
            );
        });

        // RFC 9394 section 3.1: a range beyond the results returns what is there, or NIL
        it('returns NIL for a range without results', (t, done) => {
            ctx.run(
                [
                    ...LOGIN,
                    'A1 SEARCH RETURN (PARTIAL 4:10) ALL',
                    'A2 SEARCH RETURN (PARTIAL 6:10) ALL',
                    'A3 SEARCH RETURN (PARTIAL -6:-10) ALL',
                    'A4 SEARCH RETURN (PARTIAL 1:10) DELETED',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString();
                    assert.match(resp, /^\* ESEARCH \(TAG "A1"\) PARTIAL \(4:10 4:5\)\r\n/m);
                    assert.match(resp, /^\* ESEARCH \(TAG "A2"\) PARTIAL \(6:10 NIL\)\r\n/m);
                    assert.match(resp, /^\* ESEARCH \(TAG "A3"\) PARTIAL \(-6:-10 NIL\)\r\n/m);
                    assert.match(resp, /^\* ESEARCH \(TAG "A4"\) PARTIAL \(1:10 NIL\)\r\nA4 OK /m);
                    done();
                }
            );
        });

        it('combines PARTIAL with MIN, MAX and COUNT', (t, done) => {
            ctx.run([...LOGIN, 'A1 SEARCH RETURN (COUNT PARTIAL 1:1 MAX MIN) FLAGGED', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^\* ESEARCH \(TAG "A1"\) MIN 2 MAX 5 PARTIAL \(1:1 2\) COUNT 3\r\nA1 OK /m);
                done();
            });
        });

        // RFC 9394 section 3.1: one PARTIAL or one ALL, not both, RFC 9394 section 4 for the range syntax
        it('rejects invalid PARTIAL options', (t, done) => {
            ctx.run(
                [
                    ...LOGIN,
                    'A1 SEARCH RETURN (PARTIAL 1:2 ALL) ALL',
                    'A2 SEARCH RETURN (ALL PARTIAL 1:2) ALL',
                    'A3 SEARCH RETURN (PARTIAL 1:2 PARTIAL 3:4) ALL',
                    'A4 SEARCH RETURN (ALL ALL) ALL',
                    'A5 SEARCH RETURN (PARTIAL) ALL',
                    'A6 SEARCH RETURN (PARTIAL 0:5) ALL',
                    'A7 SEARCH RETURN (PARTIAL 1:*) ALL',
                    'A8 SEARCH RETURN (PARTIAL -1:5) ALL',
                    'A9 SEARCH RETURN (PARTIAL "1:5") ALL',
                    'A10 SEARCH RETURN (PARTIAL 5) ALL',
                    'A11 SEARCH RETURN (PARTIAL 1:4294967296) ALL',
                    'A12 SEARCH RETURN (PARTIAL 1:4294967295) ALL',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString();
                    for (let i = 1; i <= 11; i++) {
                        assert.match(resp, new RegExp('^A' + i + ' BAD ', 'm'), 'A' + i);
                    }
                    assert.match(resp, /^\* ESEARCH \(TAG "A12"\) PARTIAL \(1:4294967295 1:5\)\r\nA12 OK /m);
                    done();
                }
            );
        });

        // RFC 9394 section 3.3
        it('limits UID FETCH with the PARTIAL modifier', (t, done) => {
            ctx.run(
                [
                    ...LOGIN,
                    'A1 UID FETCH 15:* (FLAGS) (PARTIAL -1:-2)',
                    'A2 UID FETCH 1:* (UID) (PARTIAL 1:2)',
                    'A3 UID FETCH 1:* (UID) (PARTIAL 9:10)',
                    'A4 FETCH 2:* UID (PARTIAL 2:3)',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString();
                    assert.match(resp, /A1 OK/);
                    assert.match(resp, /L2 OK [^\r]*\r\n\* 4 FETCH \(FLAGS \(\) UID 22\)\r\n\* 5 FETCH \(FLAGS \(\\Flagged\) UID 30\)\r\nA1 OK /);
                    assert.match(resp, /A1 OK [^\r]*\r\n\* 1 FETCH \(UID 10\)\r\n\* 2 FETCH \(UID 20\)\r\nA2 OK /);
                    assert.match(resp, /A2 OK [^\r]*\r\nA3 OK /);
                    assert.match(resp, /A3 OK [^\r]*\r\n\* 3 FETCH \(UID 21\)\r\n\* 4 FETCH \(UID 22\)\r\nA4 OK /);
                    done();
                }
            );
        });

        it('rejects invalid PARTIAL fetch modifiers', (t, done) => {
            ctx.run(
                [
                    ...LOGIN,
                    'A1 UID FETCH 1:* (UID) (PARTIAL)',
                    'A2 UID FETCH 1:* (UID) (PARTIAL 0:1)',
                    'A3 UID FETCH 1:* (UID) (PARTIAL 1:2 PARTIAL 3:4)',
                    'A4 UID FETCH 1:* (UID) (PARTIAL 1:2 CHANGEDSINCE 1)',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString();
                    assert.match(resp, /^A1 BAD /m);
                    assert.match(resp, /^A2 BAD /m);
                    assert.match(resp, /^A3 BAD /m);
                    // CHANGEDSINCE without CONDSTORE
                    assert.match(resp, /^A4 BAD /m);
                    assert.doesNotMatch(resp, /FETCH \(UID/);
                    done();
                }
            );
        });
    });

    describe('with PARTIAL, SEARCHRES and CONDSTORE loaded', () => {
        const ctx = setupServer(() => ({
            plugins: ['PARTIAL', 'SEARCHRES', 'CONDSTORE'],
            storage: storage()
        }));

        // RFC 9394 section 3.2, table 1
        it('saves the messages that PARTIAL, MIN and MAX return', (t, done) => {
            ctx.run(
                [
                    ...LOGIN,
                    'A1 SEARCH RETURN (SAVE PARTIAL 2:3) ALL',
                    'A2 FETCH $ UID',
                    'A3 SEARCH RETURN (SAVE PARTIAL 2:2 MIN MAX) ALL',
                    'A4 FETCH $ UID',
                    'A5 SEARCH RETURN (SAVE PARTIAL 1:1 COUNT) ALL',
                    'A6 FETCH $ UID',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString();
                    assert.match(resp, /^\* ESEARCH \(TAG "A1"\) PARTIAL \(2:3 2:3\)\r\nA1 OK /m);
                    assert.match(resp, /A1 OK [^\r]*\r\n\* 2 FETCH \(UID 20\)\r\n\* 3 FETCH \(UID 21\)\r\nA2 OK /);
                    assert.match(resp, /^\* ESEARCH \(TAG "A3"\) MIN 1 MAX 5 PARTIAL \(2:2 2\)\r\nA3 OK /m);
                    assert.match(resp, /A3 OK [^\r]*\r\n\* 1 FETCH \(UID 10\)\r\n\* 2 FETCH \(UID 20\)\r\n\* 5 FETCH \(UID 30\)\r\nA4 OK /);
                    assert.match(resp, /A5 OK [^\r]*\r\n(\* \d FETCH \(UID \d+\)\r\n){5}A6 OK /);
                    done();
                }
            );
        });

        // RFC 4731 section 3.2: MODSEQ is the highest mod-sequence of the returned messages
        it('reports MODSEQ of the returned messages', (t, done) => {
            ctx.run([...LOGIN, 'A1 SEARCH RETURN (PARTIAL 1:2) MODSEQ 1', 'A2 SEARCH RETURN (PARTIAL 1:2 COUNT) MODSEQ 1', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^\* ESEARCH \(TAG "A1"\) PARTIAL \(1:2 1:2\) MODSEQ 3\r\n/m);
                assert.match(resp, /^\* ESEARCH \(TAG "A2"\) PARTIAL \(1:2 1:2\) COUNT 5 MODSEQ 6\r\n/m);
                done();
            });
        });

        // RFC 9394 section 3.4: PARTIAL picks the messages first, CHANGEDSINCE then filters them
        it('combines the PARTIAL and CHANGEDSINCE fetch modifiers', (t, done) => {
            ctx.run(
                [...LOGIN, 'A1 UID FETCH 1:* (FLAGS) (PARTIAL -1:-3 CHANGEDSINCE 4)', 'A2 UID FETCH 1:* (FLAGS) (CHANGEDSINCE 4 PARTIAL -1:-3)', 'ZZ LOGOUT'],
                resp => {
                    resp = resp.toString();
                    const expected =
                        '\\* 4 FETCH \\(FLAGS \\(\\) MODSEQ \\(5\\) UID 22\\)\r\n\\* 5 FETCH \\(FLAGS \\(\\\\Flagged\\) MODSEQ \\(6\\) UID 30\\)\r\n';
                    assert.match(resp, new RegExp('\\] Highest\r\n' + expected + 'A1 OK '));
                    assert.match(resp, new RegExp('A1 OK [^\r]*\r\n' + expected + 'A2 OK '));
                    done();
                }
            );
        });
    });

    describe('without PARTIAL', () => {
        const ctx = setupServer(() => ({
            plugins: ['ESEARCH', 'CONDSTORE'],
            storage: storage()
        }));

        it('rejects PARTIAL', (t, done) => {
            ctx.run(
                [...LOGIN, 'A1 SEARCH RETURN (PARTIAL 1:2) ALL', 'A2 UID FETCH 1:* (UID) (PARTIAL 1:2)', 'A3 SEARCH RETURN (ALL ALL) ALL', 'ZZ LOGOUT'],
                resp => {
                    resp = resp.toString();
                    assert.match(resp, /^A1 BAD /m);
                    assert.match(resp, /^A2 BAD /m);
                    // RFC 4731 does not forbid repeated options, the single ALL rule comes with PARTIAL
                    assert.match(resp, /^A3 OK /m);
                    assert.doesNotMatch(resp, /CAPABILITY.*PARTIAL/);
                    done();
                }
            );
        });
    });
});
