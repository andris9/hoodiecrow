import { describe, it } from 'node:test';
import assert from 'node:assert';
import { setupServer } from './helpers/index.js';
import type { TestContext } from './helpers/index.js';
import { openSession } from './helpers/session.js';

const message = (n: number) => 'From: sender@example.com\r\nSubject: message ' + n + '\r\n\r\nBody ' + n + '\r\n';

function storage() {
    return {
        INBOX: {
            messages: [1, 2, 3, 4].map(n => ({ raw: message(n), uid: n * 10, flags: n === 1 ? ['\\Seen'] : [] }))
        },
        '': {
            folders: {
                Other: {
                    messages: [{ raw: message(5), uid: 1 }]
                }
            }
        }
    };
}

const LOGIN = ['L1 LOGIN testuser testpass', 'L2 SELECT INBOX'];

// Opens a logged in session with INBOX selected, `cmd(line)` resolves with the output up to the tagged response
const connect = (ctx: TestContext) =>
    new Promise<{ cmd: (line: string) => Promise<string>; close: () => void }>(resolve => {
        openSession(ctx.port, session => {
            const cmd = (line: string) => new Promise<string>(done => session.run(line, done));
            cmd('L1 LOGIN testuser testpass')
                .then(() => cmd('L2 SELECT INBOX'))
                .then(() => resolve({ cmd, close: () => session.close() }));
        });
    });

describe('CONTEXT=SEARCH', () => {
    describe('with CONTEXT=SEARCH loaded', () => {
        const ctx = setupServer(() => ({
            plugins: ['CONTEXT=SEARCH', 'UNSELECT'],
            storage: storage()
        }));

        it('advertises CONTEXT=SEARCH and ESEARCH', (t, done) => {
            ctx.run(['A1 CAPABILITY', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^\* CAPABILITY .*ESEARCH .*CONTEXT=SEARCH(\r| )/m);
                assert.doesNotMatch(resp, /CONTEXT=SORT|PARTIAL/);
                done();
            });
        });

        // RFC 5267 sections 4.2 and 4.3: CONTEXT is only a hint, UPDATE adds no data of its own
        it('answers UPDATE and CONTEXT searches', (t, done) => {
            ctx.run(
                [
                    ...LOGIN,
                    'A1 SEARCH RETURN (UPDATE) UNSEEN',
                    'A2 UID SEARCH RETURN (UPDATE COUNT) UNSEEN',
                    'A3 SEARCH RETURN (CONTEXT) UNSEEN',
                    'A4 SEARCH RETURN (CONTEXT COUNT) UNSEEN',
                    'A5 SEARCH RETURN (UPDATE MIN MAX) UNSEEN',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString();
                    assert.match(resp, /^\* ESEARCH \(TAG "A1"\)\r\nA1 OK /m);
                    assert.match(resp, /^\* ESEARCH \(TAG "A2"\) UID COUNT 3\r\nA2 OK /m);
                    assert.match(resp, /^\* ESEARCH \(TAG "A3"\) ALL 2:4\r\nA3 OK /m);
                    assert.match(resp, /^\* ESEARCH \(TAG "A4"\) COUNT 3\r\nA4 OK /m);
                    assert.match(resp, /^\* ESEARCH \(TAG "A5"\) MIN 2 MAX 4\r\nA5 OK /m);
                    done();
                }
            );
        });

        // RFC 5267 sections 4.3.3 and 4.3.4: updates follow the FETCH responses that caused them
        it('sends ADDTO and REMOVEFROM for flag changes of this session', (t, done) => {
            ctx.run(
                [
                    ...LOGIN,
                    'A1 SEARCH RETURN (UPDATE) UNSEEN',
                    'A2 UID SEARCH RETURN (UPDATE) UNSEEN',
                    'A3 STORE 1 -FLAGS (\\Seen)',
                    'A4 STORE 2:3 +FLAGS.SILENT (\\Seen)',
                    'A5 STORE 4 FLAGS (\\Flagged)',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString();
                    assert.match(
                        resp,
                        /^\* 1 FETCH \(FLAGS \(\)\)\r\n\* ESEARCH \(TAG "A1"\) ADDTO \(0 1\)\r\n\* ESEARCH \(TAG "A2"\) UID ADDTO \(0 10\)\r\nA3 OK /m
                    );
                    assert.match(resp, /^\* ESEARCH \(TAG "A1"\) REMOVEFROM \(0 2:3\)\r\n\* ESEARCH \(TAG "A2"\) UID REMOVEFROM \(0 20,30\)\r\nA4 OK /m);
                    // still unseen, no update
                    assert.match(resp, /^\* 4 FETCH \(FLAGS \(\\Flagged\)\)\r\nA5 OK /m);
                    done();
                }
            );
        });

        // RFC 5267 section 4.3.4: a REMOVEFROM with sequence numbers MUST come before the EXPUNGE response
        it('sends REMOVEFROM before EXPUNGE', (t, done) => {
            ctx.run(
                [
                    ...LOGIN,
                    'A1 SEARCH RETURN (UPDATE) UNSEEN',
                    'A2 UID SEARCH RETURN (UPDATE) ALL',
                    'A3 STORE 1,3 +FLAGS.SILENT (\\Deleted)',
                    'A4 EXPUNGE',
                    'A5 SEARCH RETURN () ALL',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString();
                    assert.match(resp, /^A3 OK [^\r]*\r\n\* ESEARCH \(TAG "A2"\) UID REMOVEFROM \(0 10\)\r\n\* 1 EXPUNGE\r\n/m);
                    assert.match(
                        resp,
                        /^\* 1 EXPUNGE\r\n\* ESEARCH \(TAG "A1"\) REMOVEFROM \(0 2\)\r\n\* ESEARCH \(TAG "A2"\) UID REMOVEFROM \(0 30\)\r\n\* 2 EXPUNGE\r\nA4 OK /m
                    );
                    assert.match(resp, /^\* ESEARCH \(TAG "A5"\) ALL 1:2\r\nA5 OK /m);
                    done();
                }
            );
        });

        // RFC 5267 section 4.3.3: ADDTO for a new message comes after its EXISTS response
        it('sends ADDTO after EXISTS for appended messages', (t, done) => {
            ctx.run([...LOGIN, 'A1 SEARCH RETURN (UPDATE) UNSEEN', 'A2 APPEND INBOX {12}\r\nSubject: x\r\n', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^\* 5 EXISTS\r\n\* 1 RECENT\r\n\* ESEARCH \(TAG "A1"\) ADDTO \(0 5\)\r\nA2 OK /m);
                done();
            });
        });

        it('reports changes made by other sessions', async () => {
            const first = await connect(ctx);
            const second = await connect(ctx);
            try {
                await first.cmd('A1 UID SEARCH RETURN (UPDATE) UNSEEN');
                await first.cmd('A2 SEARCH RETURN (UPDATE COUNT) UNSEEN');

                await second.cmd('B1 STORE 1 -FLAGS (\\Seen)');
                await second.cmd('B2 STORE 2 +FLAGS (\\Seen \\Deleted)');
                await second.cmd('B3 APPEND INBOX {12}\r\nSubject: y\r\n');
                let output = await first.cmd('A3 NOOP');
                assert.match(
                    output,
                    /^\* 1 FETCH \(UID 10 FLAGS \(\)\)\r\n\* 2 FETCH \(UID 20 FLAGS \(\\Seen \\Deleted\)\)\r\n\* 5 EXISTS\r\n\* 1 RECENT\r\n\* ESEARCH \(TAG "A1"\) UID REMOVEFROM \(0 20\) ADDTO \(0 10,41\)\r\n\* ESEARCH \(TAG "A2"\) REMOVEFROM \(0 2\) ADDTO \(0 1,5\)\r\nA3 OK /m
                );

                await second.cmd('B4 STORE 1 +FLAGS (\\Deleted)');
                await second.cmd('B5 EXPUNGE');
                output = await first.cmd('A4 NOOP');
                assert.match(
                    output,
                    // the flag change of the expunged message is not reported, its EXPUNGE response tells the rest
                    /^\* ESEARCH \(TAG "A1"\) UID REMOVEFROM \(0 10\)\r\n\* ESEARCH \(TAG "A2"\) REMOVEFROM \(0 1\)\r\n\* 1 EXPUNGE\r\n\* 1 EXPUNGE\r\n/m
                );
            } finally {
                first.close();
                second.close();
            }
        });

        // RFC 5267 section 4.3: tags of commands with an updating context must not be reused for UPDATE
        it('rejects UPDATE with a tag in use', (t, done) => {
            ctx.run(
                [
                    ...LOGIN,
                    'A1 SEARCH RETURN (UPDATE) UNSEEN',
                    'A1 SEARCH RETURN (UPDATE) FLAGGED',
                    'A1 SEARCH RETURN (COUNT) FLAGGED',
                    'A2 CANCELUPDATE "A1"',
                    'A1 SEARCH RETURN (UPDATE) FLAGGED',
                    'A3 SEARCH RETURN (UPDATE UPDATE) ALL',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString();
                    const lines = resp.split('\r\n').filter((line: string) => /^A1 /.test(line));
                    assert.deepStrictEqual(
                        lines.map((line: string) => line.split(' ')[1]),
                        ['OK', 'BAD', 'OK', 'OK'],
                        resp
                    );
                    assert.match(resp, /^A3 BAD /m);
                    done();
                }
            );
        });

        // RFC 5267 section 4.3.5: command-select =/ "CANCELUPDATE" 1*(SP quoted)
        it('cancels updates', (t, done) => {
            ctx.run(
                [
                    ...LOGIN,
                    'A1 SEARCH RETURN (UPDATE) UNSEEN',
                    'A2 SEARCH RETURN (UPDATE) UNSEEN',
                    'A3 SEARCH RETURN (UPDATE) UNSEEN',
                    'B1 CANCELUPDATE',
                    'B2 CANCELUPDATE A1',
                    'B3 CANCELUPDATE {2}\r\nA1',
                    'B4 CANCELUPDATE "A1" "X1"',
                    'B5 CANCELUPDATE "A1" "A2"',
                    'B6 CANCELUPDATE "A1"',
                    'B7 STORE 1 -FLAGS (\\Seen)',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString();
                    assert.match(resp, /^B1 BAD /m);
                    assert.match(resp, /^B2 BAD /m);
                    assert.match(resp, /^B3 BAD /m);
                    // nothing is cancelled when one tag is unknown
                    assert.match(resp, /^B4 NO /m);
                    assert.match(resp, /^B5 OK /m);
                    assert.match(resp, /^B6 NO /m);
                    assert.match(resp, /^\* 1 FETCH \(FLAGS \(\)\)\r\n\* ESEARCH \(TAG "A3"\) ADDTO \(0 1\)\r\nB7 OK /m);
                    done();
                }
            );
        });

        it('allows CANCELUPDATE only in the selected state', (t, done) => {
            ctx.run(['L1 LOGIN testuser testpass', 'A1 CANCELUPDATE "A1"', 'ZZ LOGOUT'], resp => {
                assert.match(resp.toString(), /^A1 BAD /m);
                done();
            });
        });

        // RFC 5267 section 4.3: updates cease when the mailbox is no longer selected
        for (const command of ['SELECT INBOX', 'EXAMINE INBOX', 'CLOSE', 'UNSELECT']) {
            it('ends updates with ' + command.split(' ')[0], (t, done) => {
                ctx.run(
                    [
                        ...LOGIN,
                        'A1 SEARCH RETURN (UPDATE) ALL',
                        'A2 STORE 1 +FLAGS (\\Deleted)',
                        'A3 ' + command,
                        'A4 SELECT INBOX',
                        'A5 STORE 2 +FLAGS (\\Seen)',
                        'A6 EXPUNGE',
                        'A7 CANCELUPDATE "A1"',
                        'ZZ LOGOUT'
                    ],
                    resp => {
                        resp = resp.toString();
                        assert.doesNotMatch(resp, /ESEARCH \(TAG "A1"\) /);
                        assert.match(resp, /^A7 NO /m);
                        done();
                    }
                );
            });
        }

        // RFC 5267 section 4.3: sequence numbers in the search program are evaluated when the command is received
        it('keeps sequence numbers of the search program', (t, done) => {
            ctx.run(
                [
                    ...LOGIN,
                    'A1 SEARCH RETURN (UPDATE) 3:* UNSEEN',
                    'A2 STORE 1 +FLAGS.SILENT (\\Deleted)',
                    'A3 EXPUNGE',
                    'A4 APPEND INBOX {12}\r\nSubject: x\r\n',
                    'A5 STORE 1 -FLAGS (\\Seen)',
                    'A6 STORE 2 +FLAGS (\\Seen)',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString();
                    assert.match(resp, /^\* ESEARCH \(TAG "A1"\)\r\nA1 OK /m);
                    // the old message 3 is message 2 now, the new message 4 is not in the range
                    assert.doesNotMatch(resp, /ADDTO/);
                    assert.match(resp, /^\* 2 FETCH \(FLAGS \(\\Seen\)\)\r\n\* ESEARCH \(TAG "A1"\) REMOVEFROM \(0 2\)\r\nA6 OK /m);
                    done();
                }
            );
        });

        // RFC 5267 section 4.4: PARTIAL with positive ranges, the negative ones need the PARTIAL capability
        it('accepts PARTIAL with positive ranges', (t, done) => {
            ctx.run([...LOGIN, 'A1 SEARCH RETURN (PARTIAL 2:3 UPDATE) ALL', 'A2 SEARCH RETURN (PARTIAL -1:-2) ALL', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^\* ESEARCH \(TAG "A1"\) PARTIAL \(2:3 2:3\)\r\nA1 OK /m);
                assert.match(resp, /^A2 BAD /m);
                done();
            });
        });
    });

    describe('with a context limit', () => {
        const ctx = setupServer(() => ({
            plugins: ['CONTEXT=SEARCH'],
            maxSearchContexts: 1,
            storage: storage()
        }));

        // RFC 5267 section 4.3.1: an untagged NO with NOUPDATE, the other result options are honoured
        it('refuses updates above the limit with NOUPDATE', (t, done) => {
            ctx.run(
                [
                    ...LOGIN,
                    'A1 SEARCH RETURN (UPDATE) UNSEEN',
                    'A2 SEARCH RETURN (UPDATE COUNT) UNSEEN',
                    'A3 CANCELUPDATE "A1"',
                    'A4 SEARCH RETURN (UPDATE) UNSEEN',
                    'A5 STORE 1 -FLAGS (\\Seen)',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString();
                    assert.match(resp, /^\* ESEARCH \(TAG "A2"\) COUNT 3\r\n\* NO \[NOUPDATE "A2"\] [^\r]+\r\nA2 OK /m);
                    assert.match(resp, /^\* 1 FETCH \(FLAGS \(\)\)\r\n\* ESEARCH \(TAG "A4"\) ADDTO \(0 1\)\r\nA5 OK /m);
                    assert.doesNotMatch(resp, /TAG "A2"\) ADDTO/);
                    done();
                }
            );
        });
    });

    describe('with CONTEXT=SEARCH and QRESYNC loaded', () => {
        const ctx = setupServer(() => ({
            plugins: ['CONTEXT=SEARCH', 'QRESYNC', 'ENABLE'],
            storage: storage()
        }));

        // RFC 7162 section 3.2.10: VANISHED instead of EXPUNGE, the REMOVEFROM update still comes first
        it('sends REMOVEFROM before VANISHED', (t, done) => {
            ctx.run(
                [
                    'L1 LOGIN testuser testpass',
                    'E1 ENABLE QRESYNC',
                    'L2 SELECT INBOX',
                    'A1 UID SEARCH RETURN (UPDATE) ALL',
                    'A2 SEARCH RETURN (UPDATE) ALL',
                    'A3 STORE 2:3 +FLAGS.SILENT (\\Deleted)',
                    'A4 EXPUNGE',
                    'A5 SEARCH RETURN (COUNT) ALL',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString();
                    assert.match(resp, /^\* ESEARCH \(TAG "A1"\) UID REMOVEFROM \(0 20,30\)\r\n\* VANISHED 20,30\r\nA4 OK /m);
                    // the sequence number context has no number to report, the message is dropped from it
                    assert.doesNotMatch(resp, /TAG "A2"\) REMOVEFROM/);
                    assert.match(resp, /^\* ESEARCH \(TAG "A5"\) COUNT 2\r\n/m);
                    done();
                }
            );
        });
    });

    describe('with CONTEXT=SEARCH and SEARCHRES loaded', () => {
        const ctx = setupServer(() => ({
            plugins: ['CONTEXT=SEARCH', 'SEARCHRES'],
            storage: storage()
        }));

        it('saves the result of an updating search', (t, done) => {
            ctx.run([...LOGIN, 'A1 SEARCH RETURN (UPDATE SAVE) UNSEEN', 'A2 FETCH $ UID', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^\* ESEARCH \(TAG "A1"\)\r\nA1 OK /m);
                assert.match(resp, /^\* 2 FETCH \(UID 20\)\r\n\* 3 FETCH \(UID 30\)\r\n\* 4 FETCH \(UID 40\)\r\nA2 OK /m);
                done();
            });
        });
    });

    describe('without CONTEXT=SEARCH', () => {
        const ctx = setupServer(() => ({
            plugins: ['ESEARCH'],
            storage: storage()
        }));

        it('rejects UPDATE, CONTEXT and CANCELUPDATE', (t, done) => {
            ctx.run([...LOGIN, 'A1 SEARCH RETURN (UPDATE) ALL', 'A2 SEARCH RETURN (CONTEXT) ALL', 'A3 CANCELUPDATE "A1"', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^A1 BAD /m);
                assert.match(resp, /^A2 BAD /m);
                assert.match(resp, /^A3 BAD /m);
                done();
            });
        });
    });
});
