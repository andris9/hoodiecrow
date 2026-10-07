'use strict';

// SORT (RFC 5256) and SORT=DISPLAY (RFC 5957)

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { setupServer } = require('./helpers');
const { openSession } = require('./helpers/session');

// the messages of the Dovecot comparison scenario, see compare/scenarios/sort-thread.txt
const compareStorage = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'compare', 'storage-sort-thread.json'), 'utf-8'));

const LOGIN = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX'];

// the untagged SORT response and the tagged response of a command
const result = (resp, tag) => {
    const text = resp.toString('binary');
    const tagged = text.match(new RegExp('^' + tag + ' (OK|NO|BAD)\\b.*$', 'm'));
    assert.ok(tagged, 'no tagged response for ' + tag + '\n' + text);
    return tagged[0];
};

describe('SORT', () => {
    describe('without the plugin', () => {
        const ctx = setupServer(() => ({ storage: compareStorage() }));

        it('is an unknown command, and so is UID SORT', (t, done) => {
            ctx.run([...LOGIN, 'A3 CAPABILITY', 'A4 SORT (DATE) UTF-8 ALL', 'A5 UID SORT (DATE) UTF-8 ALL', 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                assert.doesNotMatch(resp, /^\* CAPABILITY .*SORT/m);
                assert.match(resp, /^A4 BAD /m);
                assert.match(resp, /^A5 BAD /m);
                done();
            });
        });
    });

    describe('with SORT only', () => {
        const ctx = setupServer(() => ({ plugins: ['SORT'], storage: compareStorage() }));

        it('advertises SORT but not SORT=DISPLAY', (t, done) => {
            ctx.run(['A1 CAPABILITY', 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                assert.match(resp, /^\* CAPABILITY .* SORT( |\r\n)/m);
                assert.doesNotMatch(resp, /SORT=DISPLAY/);
                done();
            });
        });

        it('refuses DISPLAYFROM and DISPLAYTO (RFC 5957 section 5 extends sort-key)', (t, done) => {
            ctx.run([...LOGIN, 'A3 SORT (DISPLAYFROM) UTF-8 ALL', 'A4 SORT (REVERSE DISPLAYTO) UTF-8 ALL', 'ZZ LOGOUT'], resp => {
                assert.match(result(resp, 'A3'), /^A3 BAD/);
                assert.match(result(resp, 'A4'), /^A4 BAD/);
                done();
            });
        });
    });

    describe('with SORT=DISPLAY', () => {
        const ctx = setupServer(() => ({ plugins: ['SORT=DISPLAY'], storage: compareStorage() }));

        it('advertises both SORT and SORT=DISPLAY (RFC 5957 section 1)', (t, done) => {
            ctx.run(['A1 CAPABILITY', 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                assert.match(resp, /^\* CAPABILITY .* SORT .*SORT=DISPLAY/m);
                done();
            });
        });
    });

    // Expected orders were checked against Dovecot 2.4.4 with compare/scenarios/sort-thread.txt. Messages 25 (invalid
    // time), 26 (invalid zone) and 27 (no time) are where Dovecot differs: it falls back to the internal date for the
    // first and the last and reads "+2360" as a 24 hour offset, RFC 5256 section 2.2 says 00:00:00 and UTC instead
    describe('sort keys', () => {
        const ctx = setupServer(() => ({ plugins: ['SORT', 'SORT=DISPLAY'], storage: compareStorage() }));

        const CASES = [
            ['ARRIVAL', 'SORT (ARRIVAL) UTF-8 ALL', '1 25 21 17 13 9 33 5 29 6 30 2 26 22 18 14 10 34 11 35 7 31 3 27 23 19 15 16 12 8 32 4 28 24 20'],
            [
                'DATE, by UTC, missing and invalid dates use the internal date',
                'SORT (DATE) UTF-8 ALL',
                '3 4 2 1 15 5 6 12 7 11 8 9 10 13 14 17 16 25 27 19 28 18 26 20 21 22 23 24 29 30 31 32 33 34 35'
            ],
            [
                'REVERSE DATE, ties stay in sequence order',
                'SORT (REVERSE DATE) UTF-8 ALL',
                '35 34 33 32 31 30 29 24 23 22 21 20 18 26 19 28 25 27 16 17 14 13 10 9 8 7 11 12 6 5 1 15 2 4 3'
            ],
            [
                'SUBJECT, by base subject',
                'SORT (SUBJECT) UTF-8 ALL',
                '9 25 26 33 34 23 21 7 11 24 1 2 3 10 14 15 22 27 28 17 18 19 20 4 6 8 12 16 30 31 32 35 5 13 29'
            ],
            [
                'SUBJECT DATE',
                'SORT (SUBJECT DATE) US-ASCII ALL',
                '9 25 26 33 34 23 21 7 11 24 3 2 1 15 10 14 22 27 28 17 19 18 20 4 6 12 8 16 30 31 32 35 5 13 29'
            ],
            [
                'REVERSE SUBJECT does not reverse the sequence number tie-breaker',
                'SORT (REVERSE SUBJECT) UTF-8 ALL',
                '29 13 5 30 31 32 35 16 4 6 8 12 20 18 19 17 28 27 22 1 2 3 10 14 15 24 7 11 21 23 34 33 26 25 9'
            ],
            [
                'FROM, addr-mailbox of the first address',
                'SORT (FROM) UTF-8 ALL',
                '6 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 8 5 10 2 13 3 4 7 11 14 9 16 17 1 12 15'
            ],
            [
                'TO, the empty string first',
                'SORT (TO) UTF-8 ALL',
                '3 5 6 8 9 10 11 12 13 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 2 1 15 14 4 7'
            ],
            ['CC', 'SORT (CC) UTF-8 ALL', '1 3 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 4 2'],
            ['SIZE', 'SORT (SIZE) UTF-8 ALL', '31 26 18 29 27 23 20 32 19 30 21 35 34 25 12 28 22 1 24 6 3 8 5 13 15 7 10 11 16 9 33 4 14 17 2'],
            [
                'REVERSE SIZE',
                'SORT (REVERSE SIZE) UTF-8 ALL',
                '2 14 17 4 33 9 11 16 10 7 15 13 5 8 3 6 24 1 22 28 12 25 34 35 21 30 19 32 20 23 27 29 18 26 31'
            ],
            [
                'DISPLAYFROM, decoded display name or address',
                'SORT (DISPLAYFROM) UTF-8 ALL',
                '6 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 8 5 10 2 13 3 4 7 11 14 9 16 17 12 1 15'
            ],
            ['DISPLAYTO', 'SORT (DISPLAYTO) UTF-8 ALL', '3 5 6 8 9 10 11 12 13 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 2 1 15 14 4 7'],
            ['with search criteria', 'SORT (SUBJECT) UTF-8 SUBJECT hello', '1 2 3 10 14 15'],
            ['lower case keys, quoted charset, sequence set and nested criteria', 'SORT (reverse date) "utf-8" 1:5 (OR FROM zed SUBJECT topic)', '1 4'],
            ['with nothing found', 'SORT (SUBJECT) UTF-8 TEXT "not in mailbox"', ''],
            [
                'UID SORT with sequence numbers in the criteria',
                'UID SORT (DATE) UTF-8 2:*',
                '3 4 2 15 5 6 12 7 11 8 9 10 13 14 17 16 25 27 19 28 18 26 20 21 22 23 24 29 30 31 32 33 34 35'
            ],
            ['UID SORT with UID criteria', 'UID SORT (SIZE) UTF-8 UID 30:*', '31 32 30 35 34 33'],
            ['repeated keys', 'SORT (SIZE SIZE) UTF-8 1:3', '1 3 2']
        ];

        for (const [description, command, expected] of CASES) {
            it(description, (t, done) => {
                ctx.run([...LOGIN, 'A3 ' + command, 'ZZ LOGOUT'], resp => {
                    resp = resp.toString('binary');
                    assert.ok(resp.indexOf('\r\n* SORT' + (expected ? ' ' + expected : '') + '\r\nA3 OK ') >= 0, resp);
                    done();
                });
            });
        }
    });

    describe('UIDs', () => {
        const ctx = setupServer(() => ({
            plugins: ['SORT'],
            storage: {
                INBOX: {
                    messages: [
                        { uid: 10, raw: 'Subject: b\r\n\r\n' },
                        { uid: 20, raw: 'Subject: a\r\n\r\n' },
                        { uid: 35, raw: 'Subject: c\r\n\r\n' }
                    ]
                }
            }
        }));

        it('SORT lists sequence numbers and UID SORT lists UIDs (RFC 5256 section 4)', (t, done) => {
            ctx.run([...LOGIN, 'A3 SORT (SUBJECT) UTF-8 ALL', 'A4 UID SORT (SUBJECT) UTF-8 ALL', 'A5 UID SORT (SUBJECT) UTF-8 2:3', 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                assert.ok(resp.indexOf('\r\n* SORT 2 1 3\r\nA3 OK SORT completed\r\n') >= 0, resp);
                assert.ok(resp.indexOf('\r\n* SORT 20 10 35\r\nA4 OK UID SORT completed\r\n') >= 0, resp);
                // the search criteria of UID SORT use sequence numbers, like UID SEARCH
                assert.ok(resp.indexOf('\r\n* SORT 20 35\r\nA5 OK UID SORT completed\r\n') >= 0, resp);
                done();
            });
        });
    });

    describe('collation', () => {
        const ctx = setupServer(() => ({
            plugins: ['SORT'],
            storage: {
                INBOX: {
                    messages: ['Subject: =?UTF-8?Q?=C3=A9t=C3=A9?=', 'Subject: Ete', 'Subject: ÉTÉ €', 'Subject: e', 'Subject: Re: ETE', 'Subject: '].map(
                        header => ({ raw: header + '\r\n\r\n' })
                    )
                }
            }
        }));

        it('compares base subjects with i;unicode-casemap (RFC 5256 section 7, RFC 5051)', (t, done) => {
            ctx.run([...LOGIN, 'A3 SORT (SUBJECT) UTF-8 ALL', 'A4 SORT (REVERSE SUBJECT) UTF-8 ALL', 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                // "" < "E" < "ETE" (2 and 5) < "ÉTÉ" (1) < "ÉTÉ €" (3)
                assert.ok(resp.indexOf('\r\n* SORT 6 4 2 5 1 3\r\n') >= 0, resp);
                assert.ok(resp.indexOf('\r\n* SORT 3 1 2 5 4 6\r\n') >= 0, resp);
                done();
            });
        });
    });

    describe('errors', () => {
        const ctx = setupServer(() => ({ plugins: ['SORT=DISPLAY'], storage: compareStorage() }));

        const CASES = [
            // RFC 5256 section 5: sort-criteria = "(" sort-criterion *(SP sort-criterion) ")"
            ['an empty list of sort criteria', 'SORT () UTF-8 ALL', 'BAD'],
            ['sort criteria that are not a list', 'SORT DATE UTF-8 ALL', 'BAD'],
            ['a nested list of sort criteria', 'SORT ((DATE)) UTF-8 ALL', 'BAD'],
            ['an unknown sort key', 'SORT (BOGUS) UTF-8 ALL', 'BAD'],
            ['a quoted sort key', 'SORT ("DATE") UTF-8 ALL', 'BAD'],
            // sort-criterion = ["REVERSE" SP] sort-key
            ['REVERSE without a sort key', 'SORT (REVERSE) UTF-8 ALL', 'BAD'],
            ['REVERSE at the end', 'SORT (DATE REVERSE) UTF-8 ALL', 'BAD'],
            ['REVERSE REVERSE', 'SORT (REVERSE REVERSE DATE) UTF-8 ALL', 'BAD'],
            // the charset is mandatory (RFC 5256 section 3), charset = atom / quoted
            ['a missing charset and search criteria', 'SORT (DATE)', 'BAD'],
            ['missing search criteria', 'SORT (DATE) UTF-8', 'BAD'],
            ['a missing charset', 'SORT (DATE) ALL SEEN', 'NO'],
            ['a charset given as a list', 'SORT (DATE) (UTF-8) ALL', 'BAD'],
            ['a charset given as a literal', 'SORT (DATE) {5}\r\nUTF-8 ALL', 'BAD'],
            ['the CHARSET keyword of SEARCH', 'SORT (DATE) CHARSET UTF-8 ALL', 'NO'],
            ['an unknown search key', 'SORT (DATE) UTF-8 BOGUS', 'BAD'],
            ['an invalid sequence set', 'SORT (DATE) UTF-8 1:0', 'BAD'],
            ['8-bit text in a US-ASCII search', 'SORT (DATE) US-ASCII SUBJECT {4}\r\nÃ©tÃ', 'BAD'],
            ['the same errors in UID SORT', 'UID SORT () UTF-8 ALL', 'BAD']
        ];

        for (const [description, command, expected] of CASES) {
            it('answers ' + expected + ' to ' + description, (t, done) => {
                ctx.run([...LOGIN, 'A3 ' + command, 'ZZ LOGOUT'], resp => {
                    assert.match(result(resp, 'A3'), new RegExp('^A3 ' + expected + ' '));
                    assert.doesNotMatch(resp.toString('binary'), /^\* SORT/m);
                    done();
                });
            });
        }

        it('answers NO [BADCHARSET] for an unsupported charset (RFC 5256 section 3, RFC 3501 section 7.1)', (t, done) => {
            ctx.run([...LOGIN, 'A3 SORT (DATE) KOI8-R ALL', 'A4 UID SORT (DATE) "ISO-8859-1" ALL', 'ZZ LOGOUT'], resp => {
                assert.match(result(resp, 'A3'), /^A3 NO \[BADCHARSET \(US-ASCII UTF-8\)\] /);
                assert.match(result(resp, 'A4'), /^A4 NO \[BADCHARSET \(US-ASCII UTF-8\)\] /);
                done();
            });
        });

        it('is refused without a selected mailbox', (t, done) => {
            ctx.run(['A1 LOGIN testuser testpass', 'A2 SORT (DATE) UTF-8 ALL', 'A3 UID SORT (DATE) UTF-8 ALL', 'ZZ LOGOUT'], resp => {
                assert.match(result(resp, 'A2'), /^A2 BAD /);
                assert.match(result(resp, 'A3'), /^A3 BAD /);
                done();
            });
        });
    });

    describe('multiple sessions', () => {
        const ctx = setupServer(() => ({
            plugins: ['SORT'],
            storage: {
                INBOX: {
                    messages: [1, 2, 3, 4].map(i => ({ raw: 'Subject: message ' + (5 - i) + '\r\n\r\n' }))
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

        it('does not send EXPUNGE during SORT, but does during UID SORT (RFC 5256 section 3)', async () => {
            const a = await open();
            const b = await open();

            await b.cmd('B1 STORE 2 +FLAGS.SILENT (\\Deleted)');
            await b.cmd('B2 EXPUNGE');

            // SORT still uses the sequence numbers that session A knows
            let output = await a.cmd('A1 SORT (SUBJECT) UTF-8 ALL');
            // the EXPUNGE is pending, EXPUNGEISSUED tells the client (RFC 5530 section 3)
            assert.strictEqual(output, '* SORT 4 3 2 1\r\nA1 OK [EXPUNGEISSUED] SORT completed\r\n');

            // UID SORT may deliver the EXPUNGE, after the SORT response that was built with the old numbers
            output = await a.cmd('A2 UID SORT (SUBJECT) UTF-8 ALL');
            assert.match(output, /^\* SORT 4 3 2 1\r\n\* 2 EXPUNGE\r\n/);
            assert.match(output, /^A2 OK UID SORT completed\r\n/m);

            output = await a.cmd('A3 SORT (SUBJECT) UTF-8 ALL');
            assert.strictEqual(output, '* SORT 3 2 1\r\nA3 OK SORT completed\r\n');
        });

        it('may be pipelined with FETCH, but not after UID SORT (RFC 3501 section 5.5)', async () => {
            const { session } = await open();

            let output = await new Promise(done => session.run('P1 SORT (SUBJECT) UTF-8 ALL\r\nP2 FETCH 1 FLAGS', done, 'P2'));
            assert.match(output, /^P1 OK /m);
            assert.match(output, /^P2 OK /m);

            output = await new Promise(done => session.run('P3 UID SORT (SUBJECT) UTF-8 ALL\r\nP4 FETCH 1 FLAGS', done, 'P4'));
            assert.match(output, /^P3 OK /m);
            assert.match(output, /^P4 BAD /m);

            // sequence numbers in the search criteria count, like in SEARCH
            output = await new Promise(done => session.run('P5 NOOP\r\nP6 SORT (SUBJECT) UTF-8 1:2', done, 'P6'));
            assert.match(output, /^P6 BAD /m);

            output = await new Promise(done => session.run('P7 NOOP\r\nP8 SORT (SUBJECT) UTF-8 ALL', done, 'P8'));
            assert.match(output, /^P8 OK /m);
        });
    });
});

describe('SORT and THREAD with CONDSTORE (RFC 7162 section 3.1.9)', () => {
    const ctx = setupServer(() => ({
        plugins: ['SORT', 'THREAD=REFERENCES', 'CONDSTORE'],
        storage: {
            INBOX: {
                messages: [
                    { raw: 'Subject: b\r\n\r\n', MODSEQ: 5 },
                    { raw: 'Subject: a\r\n\r\n', MODSEQ: 9 },
                    { raw: 'Subject: c\r\n\r\n', MODSEQ: 7 }
                ]
            }
        }
    }));

    it('appends the highest mod-sequence to SORT, but not to THREAD', (t, done) => {
        ctx.run(
            [
                ...LOGIN,
                'A3 SORT (SUBJECT) UTF-8 ALL',
                'A4 SORT (SUBJECT) UTF-8 MODSEQ 6',
                'A5 UID SORT (SUBJECT) UTF-8 MODSEQ 100',
                'A6 THREAD REFERENCES UTF-8 MODSEQ 6',
                'ZZ LOGOUT'
            ],
            resp => {
                resp = resp.toString('binary');
                assert.ok(resp.indexOf('\r\n* SORT 2 1 3\r\nA3 OK') >= 0, resp);
                assert.ok(resp.indexOf('\r\n* SORT 2 3 (MODSEQ 9)\r\nA4 OK') >= 0, resp);
                // the mod-sequence is left out when nothing matches
                assert.ok(resp.indexOf('\r\n* SORT\r\nA5 OK') >= 0, resp);
                assert.ok(resp.indexOf('\r\n* THREAD (2)(3)\r\nA6 OK') >= 0, resp);
                done();
            }
        );
    });
});
