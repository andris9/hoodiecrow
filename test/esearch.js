'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');
const { openSession } = require('./helpers/session');
const { toSequenceSet, selectReturned } = require('../lib/esearch');

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

describe('ESEARCH', () => {
    describe('helpers', () => {
        it('formats sequence sets', () => {
            assert.strictEqual(toSequenceSet([]), '');
            assert.strictEqual(toSequenceSet([5]), '5');
            assert.strictEqual(toSequenceSet([7, 1, 2, 3, 5, 6, 3]), '1:3,5:7');
        });

        // RFC 4731 section 3.2 and RFC 5182 section 2.4
        it('selects the returned messages', () => {
            const list = ['a', 'b', 'c'];
            const pick = options => selectReturned(list, new Set(options));
            assert.deepStrictEqual(pick([]), list);
            assert.deepStrictEqual(pick(['MIN']), ['a']);
            assert.deepStrictEqual(pick(['MAX']), ['c']);
            assert.deepStrictEqual(pick(['MIN', 'MAX']), ['a', 'c']);
            assert.deepStrictEqual(pick(['MIN', 'COUNT']), list);
            assert.deepStrictEqual(pick(['MAX', 'ALL']), list);
            assert.deepStrictEqual(pick(['SAVE']), list);
            assert.deepStrictEqual(selectReturned(['a'], new Set(['MIN', 'MAX'])), ['a']);
            assert.deepStrictEqual(selectReturned([], new Set(['MIN'])), []);
        });
    });

    describe('with ESEARCH loaded', () => {
        const ctx = setupServer(() => ({
            plugins: ['ESEARCH'],
            storage: storage()
        }));

        it('advertises ESEARCH', (t, done) => {
            ctx.run(['A1 CAPABILITY', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.ok(/^\* CAPABILITY .* ESEARCH(\r| )/m.test(resp), resp);
                assert.ok(!/SEARCHRES/.test(resp), resp);
                done();
            });
        });

        // RFC 4731 section 3.1
        it('returns MIN, MAX, ALL and COUNT', (t, done) => {
            ctx.run([...LOGIN, 'A1 SEARCH RETURN (MIN MAX ALL COUNT) FLAGGED', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.ok(/^\* ESEARCH \(TAG "A1"\) MIN 2 MAX 5 ALL 2:3,5 COUNT 3\r\nA1 OK /m.test(resp), resp);
                assert.ok(!/^\* SEARCH/m.test(resp), resp);
                done();
            });
        });

        it('returns only the requested options', (t, done) => {
            ctx.run(
                [...LOGIN, 'A1 SEARCH RETURN (MIN COUNT) FLAGGED', 'A2 SEARCH RETURN (MAX) FLAGGED', 'A3 SEARCH RETURN (COUNT) DELETED', 'ZZ LOGOUT'],
                resp => {
                    resp = resp.toString();
                    assert.ok(/^\* ESEARCH \(TAG "A1"\) MIN 2 COUNT 3\r\n/m.test(resp), resp);
                    assert.ok(/^\* ESEARCH \(TAG "A2"\) MAX 5\r\n/m.test(resp), resp);
                    assert.ok(/^\* ESEARCH \(TAG "A3"\) COUNT 0\r\n/m.test(resp), resp);
                    done();
                }
            );
        });

        // RFC 4731 section 3.1: an empty list of result options is equivalent to (ALL)
        it('treats RETURN () as RETURN (ALL)', (t, done) => {
            ctx.run([...LOGIN, 'A1 SEARCH RETURN () FLAGGED', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.ok(/^\* ESEARCH \(TAG "A1"\) ALL 2:3,5\r\nA1 OK /m.test(resp), resp);
                done();
            });
        });

        // RFC 4731 section 3.1: an extended UID SEARCH MUST cause an ESEARCH response with the UID indicator
        it('lists UIDs with the UID indicator for UID SEARCH', (t, done) => {
            ctx.run([...LOGIN, 'A1 UID SEARCH RETURN (MIN MAX ALL COUNT) FLAGGED', 'A2 UID SEARCH RETURN () ALL', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.ok(/^\* ESEARCH \(TAG "A1"\) UID MIN 20 MAX 30 ALL 20:21,30 COUNT 3\r\nA1 OK /m.test(resp), resp);
                assert.ok(/^\* ESEARCH \(TAG "A2"\) UID ALL 10,20:22,30\r\nA2 OK /m.test(resp), resp);
                done();
            });
        });

        // RFC 4731 section 3.1: MIN, MAX and ALL are left out when nothing matched, but ESEARCH is still sent
        it('sends ESEARCH when nothing matched', (t, done) => {
            ctx.run([...LOGIN, 'A1 SEARCH RETURN (MIN MAX ALL) DELETED', 'A2 UID SEARCH RETURN (MIN MAX ALL COUNT) DELETED', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.ok(/^\* ESEARCH \(TAG "A1"\)\r\nA1 OK /m.test(resp), resp);
                assert.ok(/^\* ESEARCH \(TAG "A2"\) UID COUNT 0\r\nA2 OK /m.test(resp), resp);
                done();
            });
        });

        it('accepts result options in any case and order', (t, done) => {
            ctx.run([...LOGIN, 'A1 search return (count min) flagged', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.ok(/^\* ESEARCH \(TAG "A1"\) MIN 2 COUNT 3\r\nA1 OK /m.test(resp), resp);
                done();
            });
        });

        // RFC 4466 section 2.6.1: search-return-opts come before the CHARSET of the search program
        it('takes CHARSET after RETURN', (t, done) => {
            ctx.run([...LOGIN, 'A1 SEARCH RETURN (COUNT) CHARSET UTF-8 FLAGGED', 'A2 SEARCH CHARSET UTF-8 RETURN (COUNT) FLAGGED', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.ok(/^\* ESEARCH \(TAG "A1"\) COUNT 3\r\nA1 OK /m.test(resp), resp);
                assert.ok(/^A2 BAD /m.test(resp), resp);
                done();
            });
        });

        it('keeps the SEARCH response without RETURN', (t, done) => {
            ctx.run([...LOGIN, 'A1 SEARCH FLAGGED', 'A2 UID SEARCH FLAGGED', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.ok(/^\* SEARCH 2 3 5\r\nA1 OK /m.test(resp), resp);
                assert.ok(/^\* SEARCH 20 21 30\r\nA2 OK /m.test(resp), resp);
                assert.ok(!/ESEARCH/.test(resp), resp);
                done();
            });
        });

        it('sends the tag as a string', (t, done) => {
            ctx.run([...LOGIN, 'a]1 SEARCH RETURN (COUNT) ALL', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.ok(/^\* ESEARCH \(TAG "a\]1"\) COUNT 5\r\na\]1 OK /m.test(resp), resp);
                done();
            });
        });

        it('sees messages as the session does', (t, done) => {
            ctx.run(
                [...LOGIN, 'A1 STORE 4 +FLAGS (\\Flagged)', 'A2 SEARCH RETURN (ALL) FLAGGED', 'A3 SEARCH RETURN (ALL) 2:4 UNFLAGGED', 'ZZ LOGOUT'],
                resp => {
                    resp = resp.toString();
                    assert.ok(/^\* ESEARCH \(TAG "A2"\) ALL 2:5\r\n/m.test(resp), resp);
                    assert.ok(/^\* ESEARCH \(TAG "A3"\)\r\n/m.test(resp), resp);
                    done();
                }
            );
        });

        // RFC 4466 section 2.6.1: options the server does not support must be rejected with BAD
        const BAD = [
            ['an unknown result option', 'SEARCH RETURN (FOO) ALL'],
            ['SAVE without SEARCHRES', 'SEARCH RETURN (SAVE) ALL'],
            ['RETURN without a list', 'SEARCH RETURN MIN ALL'],
            ['a nested option list', 'SEARCH RETURN ((MIN)) ALL'],
            ['a quoted result option', 'SEARCH RETURN ("MIN") ALL'],
            ['RETURN without search criteria', 'SEARCH RETURN (MIN)'],
            ['UID SEARCH RETURN without search criteria', 'UID SEARCH RETURN ()'],
            ['invalid search criteria', 'SEARCH RETURN (MIN) FOO']
        ];
        for (const [description, command] of BAD) {
            it('refuses ' + description, (t, done) => {
                ctx.run([...LOGIN, 'A1 ' + command, 'ZZ LOGOUT'], resp => {
                    resp = resp.toString();
                    assert.ok(/^A1 BAD /m.test(resp), resp);
                    assert.ok(!/ESEARCH/.test(resp), resp);
                    done();
                });
            });
        }

        it('answers NO for an unsupported charset', (t, done) => {
            ctx.run([...LOGIN, 'A1 SEARCH RETURN (COUNT) CHARSET KOI8-R ALL', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.ok(/^A1 NO \[BADCHARSET/m.test(resp), resp);
                assert.ok(!/ESEARCH/.test(resp), resp);
                done();
            });
        });

        // RFC 3501 section 5.5: the result options do not hide sequence numbers in the search program
        it('refuses pipelined SEARCH RETURN with sequence numbers after a command that is not safe', (t, done) => {
            openSession(ctx.server.address().port, session => {
                session.run('S1 LOGIN testuser testpass', () => {
                    session.run('S2 SELECT INBOX', () => {
                        session.run(
                            'A1 NOOP\r\nA2 SEARCH RETURN (COUNT) 1:2\r\nA3 NOOP\r\nA4 SEARCH RETURN (COUNT) FLAGGED',
                            resp => {
                                session.close();
                                assert.ok(/^A2 BAD /m.test(resp), resp);
                                assert.ok(/^\* ESEARCH \(TAG "A4"\) COUNT 3\r\nA4 OK /m.test(resp), resp);
                                done();
                            },
                            'A4'
                        );
                    });
                });
            });
        });
    });

    describe('without ESEARCH', () => {
        const ctx = setupServer(() => ({ storage: storage() }));

        it('refuses RETURN', (t, done) => {
            ctx.run([...LOGIN, 'A1 CAPABILITY', 'A2 SEARCH RETURN (MIN) ALL', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.ok(!/ESEARCH/.test(resp), resp);
                assert.ok(/^A2 BAD /m.test(resp), resp);
                done();
            });
        });
    });
});
