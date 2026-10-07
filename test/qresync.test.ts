// QRESYNC, RFC 7162 sections 3.2 to 3.2.11 (https://www.rfc-editor.org/rfc/rfc7162.txt)

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import net from 'node:net';
import { setupServer } from './helpers/index.js';
import { openSession } from './helpers/session.js';
import type { Session } from './helpers/session.js';
import { validateResponses } from './helpers/validate-responses.js';

const message = (n: number) => 'From: sender@example.com\r\nSubject: message ' + n + '\r\n\r\nBody ' + n + '\r\n';

// INBOX messages get the mod-sequences 2, 3, 4 and 5, HIGHESTMODSEQ is 5
function storage() {
    return {
        INBOX: {
            uidvalidity: 42,
            messages: [1, 2, 3, 4].map(n => ({ raw: message(n), uid: n, flags: n === 1 ? ['\\Seen'] : [] }))
        },
        '': {
            folders: {
                Archive: {
                    uidvalidity: 8
                },
                // UIDs 2, 4 and 6 were expunged before the server started, mod-sequences 2, 3 and 4
                Gaps: {
                    uidvalidity: 7,
                    uidnext: 7,
                    messages: [1, 3, 5].map(n => ({ raw: message(n), uid: n }))
                },
                Empty: {
                    uidvalidity: 9
                }
            }
        }
    };
}

const lines = (output: string) => output.split('\r\n').filter(line => line.length);
const untagged = (output: string) => lines(output).filter(line => line.charAt(0) === '*');

describe('QRESYNC', () => {
    const ctx = setupServer(() => ({ plugins: ['QRESYNC', 'UIDPLUS', 'MOVE', 'IDLE', 'UNSELECT', 'REPLACE', 'UNAUTHENTICATE'], storage: storage() }));

    let sessions: Session[] = [];
    let tagCounter = 0;

    /**
     * Opens a logged in session, runs ENABLE QRESYNC unless `enable` is false and selects a mailbox if one is
     * given. `session.cmd(line)` resolves with everything the server sent up to the tagged response
     */
    const open = (mailbox?: string, enable?: boolean) =>
        new Promise<{ cmd: (line: string) => Promise<string> }>((resolve, reject) => {
            openSession(ctx.port, session => {
                sessions.push(session);
                const wrapped = {
                    cmd: (line: string) =>
                        new Promise<string>(done => {
                            const tag = 'T' + ++tagCounter;
                            session.run(tag + ' ' + line, output => done(output));
                        })
                };
                wrapped
                    .cmd('LOGIN testuser testpass')
                    .then(() => (enable === false ? '' : wrapped.cmd('ENABLE QRESYNC')))
                    .then(() => (mailbox ? wrapped.cmd('SELECT ' + mailbox) : 'T OK'))
                    .then(output => {
                        assert.match(output, /^T\d* OK/m);
                        resolve(wrapped);
                    })
                    .catch(reject);
            });
        });

    afterEach(() => {
        sessions.forEach(session => session.close());
        sessions = [];
    });

    // RFC 7162 sections 3.2.2 and 3.2.3: QRESYNC implies CONDSTORE and needs ENABLE
    it('advertises QRESYNC with CONDSTORE and ENABLE', (t, done) => {
        ctx.run(['A1 CAPABILITY', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            const capability = resp.match(/^\* CAPABILITY (.*)$/m)[1].split(' ');
            for (const name of ['QRESYNC', 'CONDSTORE', 'ENABLE']) {
                assert.strictEqual(capability.filter((item: string) => item === name).length, 1, resp);
            }
            done();
        });
    });

    // RFC 7162 section 3.2.3: ENABLE QRESYNC is a CONDSTORE enabling command
    it('ENABLE QRESYNC also enables CONDSTORE', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 ENABLE QRESYNC', 'A3 SELECT INBOX', 'A4 STORE 2 +FLAGS (\\Flagged)', 'ZZ LOGOUT'];
        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.match(resp, /^\* ENABLED QRESYNC\r\nA2 OK/m);
            assert.match(resp, /^\* 2 FETCH \(FLAGS \(\\Flagged\) MODSEQ \(6\) UID 2\)\r\nA4 OK/m);
            done();
        });
    });

    it('ENABLE QRESYNC CONDSTORE lists both', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 ENABLE QRESYNC CONDSTORE', 'A3 ENABLE QRESYNC', 'ZZ LOGOUT'];
        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.match(resp, /^\* ENABLED QRESYNC CONDSTORE\r\nA2 OK/m);
            assert.match(resp, /^\* ENABLED\r\nA3 OK/m);
            done();
        });
    });

    // RFC 7162 sections 3.2.3, 3.2.5 and 3.2.6: BAD without ENABLE QRESYNC
    it('refuses the QRESYNC parameter and VANISHED without ENABLE QRESYNC', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 ENABLE CONDSTORE',
            'A3 SELECT INBOX (QRESYNC (42 1))',
            'A4 SELECT INBOX',
            'A5 UID FETCH 1:* (FLAGS) (CHANGEDSINCE 1 VANISHED)',
            'ZZ LOGOUT'
        ];
        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.match(resp, /^A3 BAD/m);
            assert.match(resp, /^A4 OK/m);
            assert.match(resp, /^A5 BAD/m);
            assert.doesNotMatch(resp, /VANISHED \(EARLIER\)/);
            done();
        });
    });

    // RFC 7162 section 3.2.5.1
    it('SELECT (QRESYNC) reports expunges and flag changes since the mod-sequence', async () => {
        const other = await open('INBOX', false);
        await other.cmd('STORE 1 +FLAGS.SILENT (\\Deleted)'); // UID 1 gets MODSEQ 6
        await other.cmd('STORE 3 +FLAGS.SILENT (\\Flagged)'); // UID 3 gets MODSEQ 7
        await other.cmd('EXPUNGE'); // HIGHESTMODSEQ 8

        const session = await open();
        let output = await session.cmd('SELECT INBOX (QRESYNC (42 5))');
        // VANISHED (EARLIER) comes before the FETCH responses (RFC 7162 section 3.2.6), FETCH includes UID (section 3.2.5.1)
        assert.match(
            output,
            /^\* OK \[HIGHESTMODSEQ 8\] Highest\r\n\* VANISHED \(EARLIER\) 1\r\n\* 2 FETCH \(UID 3 FLAGS \(\\Flagged\) MODSEQ \(7\)\)\r\nT\d+ OK \[READ-WRITE\]/m
        );

        // only the known UIDs are reported
        output = await session.cmd('SELECT INBOX (QRESYNC (42 5 2:4))');
        assert.doesNotMatch(output, /VANISHED/);
        assert.match(output, /^\* 2 FETCH \(UID 3 FLAGS \(\\Flagged\) MODSEQ \(7\)\)$/m);

        output = await session.cmd('EXAMINE INBOX (QRESYNC (42 7))');
        assert.match(output, /^\* VANISHED \(EARLIER\) 1\r\nT\d+ OK \[READ-ONLY\]/m);
        assert.doesNotMatch(output, /FETCH/);

        output = await session.cmd('SELECT INBOX (QRESYNC (42 8 1:10))');
        assert.doesNotMatch(output, /VANISHED|FETCH/);

        // RFC 7162 section 3.2.5: a different UIDVALIDITY means the remaining parameters are ignored
        output = await session.cmd('SELECT INBOX (QRESYNC (43 1))');
        assert.doesNotMatch(output, /VANISHED|FETCH/);
        assert.match(output, /^\* OK \[UIDVALIDITY 42\]/m);
        assert.match(output, /^T\d+ OK \[READ-WRITE\]/m);
    });

    // RFC 7162 sections 3.2.6 and 3.2.5.2
    it('reports every missing UID for a mod-sequence older than the remembered expunges', async () => {
        const session = await open();
        let output = await session.cmd('SELECT Gaps (QRESYNC (7 1))');
        assert.match(output, /^\* VANISHED \(EARLIER\) 2,4,6$/m);
        // FETCH responses for all messages, they all changed after mod-sequence 1
        assert.strictEqual(untagged(output).filter(line => / FETCH /.test(line)).length, 3, output);

        // the last matching pair of the sequence match data, 2 = UID 3, limits the report
        output = await session.cmd('SELECT Gaps (QRESYNC (7 1 1:6 (1:2 1,3)))');
        assert.match(output, /^\* VANISHED \(EARLIER\) 4,6$/m);

        // the first pair that does not match ends the comparison
        output = await session.cmd('SELECT Gaps (QRESYNC (7 1 1:6 (1:3 1,2,5)))');
        assert.match(output, /^\* VANISHED \(EARLIER\) 2,4,6$/m);

        output = await session.cmd('SELECT Gaps (QRESYNC (7 1 4:100))');
        assert.match(output, /^\* VANISHED \(EARLIER\) 4,6$/m);

        output = await session.cmd('SELECT Gaps (QRESYNC (7 4))');
        assert.doesNotMatch(output, /VANISHED|FETCH/);

        await session.cmd('STORE 2 +FLAGS.SILENT (\\Deleted)'); // MODSEQ 5
        output = await session.cmd('EXPUNGE'); // MODSEQ 6
        assert.match(output, /^\* VANISHED 3\r\nT\d+ OK \[HIGHESTMODSEQ 6\]/m);

        // the remembered expunges cover everything after mod-sequence 4
        output = await session.cmd('SELECT Gaps (QRESYNC (7 4))');
        assert.match(output, /^\* VANISHED \(EARLIER\) 3$/m);
        // and the sequence match data is not needed then
        output = await session.cmd('SELECT Gaps (QRESYNC (7 4 1:6 (1:2 1,5)))');
        assert.match(output, /^\* VANISHED \(EARLIER\) 3$/m);
        output = await session.cmd('SELECT Gaps (QRESYNC (7 3))');
        assert.match(output, /^\* VANISHED \(EARLIER\) 2:4,6$/m);
    });

    // RFC 7162 section 3.2.5.1: no UIDs for a mailbox that never had messages
    it('reports nothing for a mailbox that never had messages', async () => {
        const session = await open();
        const output = await session.cmd('SELECT Empty (QRESYNC (9 1))');
        assert.doesNotMatch(output, /VANISHED|FETCH/);
        assert.match(output, /^T\d+ OK \[READ-WRITE\]/m);
    });

    // RFC 7162 section 3.2.6
    it('UID FETCH (CHANGEDSINCE VANISHED) reports expunged UIDs before the FETCH responses', async () => {
        const session = await open('INBOX');
        await session.cmd('STORE 4 +FLAGS.SILENT (\\Flagged)'); // MODSEQ 6
        await session.cmd('STORE 1 +FLAGS.SILENT (\\Deleted)'); // MODSEQ 7
        await session.cmd('EXPUNGE'); // MODSEQ 8

        let output = await session.cmd('UID FETCH 1:* (FLAGS) (CHANGEDSINCE 5 VANISHED)');
        assert.deepStrictEqual(untagged(output), ['* VANISHED (EARLIER) 1', '* 3 FETCH (FLAGS (\\Flagged) MODSEQ (6) UID 4)']);

        // modifiers in any order, VANISHED before the tagged response when nothing changed
        output = await session.cmd('UID FETCH 1 (FLAGS) (VANISHED CHANGEDSINCE 1)');
        assert.match(output, /^\* VANISHED \(EARLIER\) 1\r\nT\d+ OK/m);

        output = await session.cmd('UID FETCH 2:3 (FLAGS) (CHANGEDSINCE 5 VANISHED)');
        assert.deepStrictEqual(untagged(output), []);

        output = await session.cmd('UID FETCH 1:* (FLAGS) (CHANGEDSINCE 8 VANISHED)');
        assert.deepStrictEqual(untagged(output), []);

        // "*" covers UIDs up to UIDNEXT - 1, also when the highest UID was expunged
        await session.cmd('UID STORE 4 +FLAGS.SILENT (\\Deleted)');
        await session.cmd('UID EXPUNGE 4');
        output = await session.cmd('UID FETCH 4:* (FLAGS) (CHANGEDSINCE 1 VANISHED)');
        assert.match(output, /^\* VANISHED \(EARLIER\) 4\r\n/m);
    });

    // RFC 7162 sections 3.2.7, 3.2.9 and 3.2.10.2, RFC 6851 section 4.4
    it('reports own expunges with VANISHED and HIGHESTMODSEQ', async () => {
        const session = await open('INBOX');
        await session.cmd('STORE 1:2 +FLAGS.SILENT (\\Deleted)'); // MODSEQ 6 and 7
        let output = await session.cmd('EXPUNGE');
        assert.deepStrictEqual(lines(output), ['* VANISHED 1:2', lines(output)[1]]);
        assert.match(output, /^T\d+ OK \[HIGHESTMODSEQ 8\]/m);

        // nothing expunged, no HIGHESTMODSEQ
        output = await session.cmd('EXPUNGE');
        assert.match(output, /^T\d+ OK EXPUNGE/m);

        await session.cmd('UID STORE 4 +FLAGS.SILENT (\\Deleted)'); // MODSEQ 9
        output = await session.cmd('UID EXPUNGE 1:*');
        assert.match(output, /^\* VANISHED 4\r\nT\d+ OK \[HIGHESTMODSEQ 10\]/m);

        output = await session.cmd('UID EXPUNGE 1:*');
        assert.match(output, /^T\d+ OK UID EXPUNGE/m);

        output = await session.cmd('MOVE 1 Archive');
        assert.match(output, /^\* OK \[COPYUID 8 3 1\] Copied\r\n\* VANISHED 3\r\nT\d+ OK \[HIGHESTMODSEQ 11\]/m);
        assert.doesNotMatch(output, /EXPUNGE/);

        output = await session.cmd('UID MOVE 99 Archive');
        assert.match(output, /^T\d+ OK Done/m);
    });

    // RFC 8508 section 4.5: the replaced message is removed as if with UID EXPUNGE
    it('REPLACE reports the replaced message with VANISHED and HIGHESTMODSEQ', async () => {
        const session = await open('INBOX');
        const replacement = message(9);
        const output = await session.cmd('UID REPLACE 2 INBOX {' + replacement.length + '}\r\n' + replacement);
        assert.match(output, /^\* VANISHED 2\r\nT\d+ OK \[HIGHESTMODSEQ 7\]/m);
        assert.doesNotMatch(output, /EXPUNGE/);
    });

    // RFC 8437 section 4.1: after UNAUTHENTICATE, QRESYNC has to be enabled again
    it('UNAUTHENTICATE ends QRESYNC', async () => {
        const session = await open('INBOX');
        await session.cmd('UNAUTHENTICATE');
        await session.cmd('LOGIN testuser testpass');
        const output = await session.cmd('SELECT INBOX (QRESYNC (42 1))');
        assert.match(output, /^T\d+ BAD/m);
    });

    // RFC 7162 section 3.2.8: no VANISHED and no HIGHESTMODSEQ for CLOSE, but the expunge is remembered
    it('CLOSE sends no HIGHESTMODSEQ', async () => {
        const session = await open('INBOX');
        await session.cmd('STORE 1 +FLAGS.SILENT (\\Deleted)'); // MODSEQ 6
        let output = await session.cmd('CLOSE');
        assert.deepStrictEqual(lines(output).length, 1);
        assert.match(output, /^T\d+ OK Mailbox closed/m);

        output = await session.cmd('SELECT INBOX (QRESYNC (42 6))');
        assert.match(output, /^\* OK \[HIGHESTMODSEQ 7\] Highest\r\n\* VANISHED \(EARLIER\) 1\r\nT\d+ OK/m);
    });

    // RFC 7162 section 3.2.10.2: VANISHED instead of EXPUNGE only for sessions that enabled QRESYNC
    it('sends VANISHED for expunges in other sessions to QRESYNC sessions only', async () => {
        const qresync = await open('INBOX');
        const plain = await open('INBOX', false);
        const other = await open('INBOX', false);

        await other.cmd('STORE 1,3 +FLAGS.SILENT (\\Deleted)');
        let output = await other.cmd('EXPUNGE');
        assert.deepStrictEqual(untagged(output), ['* 1 EXPUNGE', '* 2 EXPUNGE']);

        output = await qresync.cmd('NOOP');
        assert.deepStrictEqual(
            untagged(output).filter(line => !/FETCH/.test(line)),
            ['* VANISHED 1,3', '* 2 EXISTS']
        );
        // flag changes carry MODSEQ once CONDSTORE is enabled (RFC 7162 section 3.2.4)
        assert.doesNotMatch(output, /FETCH \(UID \d+ FLAGS \([^)]*\)\)/);

        output = await plain.cmd('NOOP');
        assert.match(output, /^\* 1 EXPUNGE\r\n\* 2 EXPUNGE\r\n/m);
        assert.doesNotMatch(output, /VANISHED/);
    });

    // RFC 7162 section 3.2.10.2: the same timing rules as EXPUNGE, no VANISHED during FETCH, STORE and SEARCH,
    // nor during UID SEARCH with message numbers
    it('holds VANISHED back during FETCH and UID SEARCH with message numbers', async () => {
        const session = await open('INBOX');
        const other = await open('INBOX', false);

        await other.cmd('STORE 4 +FLAGS.SILENT (\\Seen)'); // MODSEQ 6
        await other.cmd('STORE 2 +FLAGS.SILENT (\\Deleted)'); // MODSEQ 7
        await other.cmd('EXPUNGE'); // MODSEQ 8

        let output = await session.cmd('FETCH 1:* (MODSEQ)');
        assert.doesNotMatch(output, /VANISHED/);
        // RFC 7162 section 3.2: a HIGHESTMODSEQ below the mod-sequence of the held back expunge
        assert.match(output, /^\* OK \[HIGHESTMODSEQ 7\] [^\r\n]+\r\nT\d+ OK/m);

        output = await session.cmd('UID SEARCH 1:4');
        assert.doesNotMatch(output, /VANISHED/);
        assert.match(output, /^\* SEARCH 1 2 3 4\r\n/m);

        output = await session.cmd('UID SEARCH UID 1:4');
        assert.match(output, /^\* VANISHED 2\r\n/m);
    });

    it('delivers VANISHED while idling', async () => {
        const socket = net.connect(ctx.port, 'localhost');
        let received = '';
        socket.on('data', chunk => {
            received += chunk.toString('binary');
        });
        const waitFor = (str: string) =>
            new Promise<string>((resolve, reject) => {
                const started = Date.now();
                const check = () => {
                    if (received.indexOf(str) >= 0) {
                        return resolve(received);
                    }
                    if (Date.now() - started > 2000) {
                        return reject(new Error('Timeout waiting for ' + JSON.stringify(str) + ', got ' + JSON.stringify(received)));
                    }
                    setTimeout(check, 5);
                };
                check();
            });
        try {
            await waitFor('* OK');
            socket.write('W1 LOGIN testuser testpass\r\nW2 ENABLE QRESYNC\r\n');
            await waitFor('W2 OK');
            socket.write('W3 SELECT INBOX\r\n');
            await waitFor('W3 OK');
            socket.write('W4 IDLE\r\n');
            await waitFor('+ ');

            const other = await open('INBOX', false);
            await other.cmd('STORE 2 +FLAGS.SILENT (\\Deleted)');
            await other.cmd('EXPUNGE');
            await waitFor('* VANISHED 2\r\n');

            socket.write('DONE\r\n');
            await waitFor('W4 OK');
            await validateResponses(received);
            assert.doesNotMatch(received, /EXPUNGE/);
        } finally {
            socket.end();
        }
    });

    // RFC 7162 section 3.2.11
    it('sends CLOSED when SELECT or EXAMINE closes the selected mailbox', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 SELECT INBOX',
            'A3 EXAMINE Archive',
            'A4 SELECT INBOX (FOO)',
            'A5 SELECT Nope',
            'A6 SELECT INBOX',
            'A7 UNSELECT',
            'A8 SELECT INBOX',
            'ZZ LOGOUT'
        ];
        ctx.run(cmds, resp => {
            resp = resp.toString();
            // nothing was selected before
            assert.match(resp, /^A1 OK[^\r\n]*\r\n\* FLAGS/m);
            assert.match(resp, /^A2 OK[^\r\n]*\r\n\* OK \[CLOSED\] [^\r\n]+\r\n\* FLAGS/m);
            // a BAD command did not close anything
            assert.match(resp, /^A3 OK[^\r\n]*\r\nA4 BAD/m);
            // a failed SELECT closes the mailbox as well (RFC 3501 section 6.3.1)
            assert.match(resp, /^A4 BAD[^\r\n]*\r\n\* OK \[CLOSED\] [^\r\n]+\r\nA5 NO/m);
            assert.match(resp, /^A5 NO[^\r\n]*\r\n\* FLAGS/m);
            // no CLOSED for UNSELECT, or for SELECT after it
            assert.match(resp, /^A7 OK[^\r\n]*\r\n\* FLAGS/m);
            assert.strictEqual(resp.match(/\[CLOSED\]/g).length, 2, resp);
            done();
        });
    });
});

describe('QRESYNC with other plugins', () => {
    // RFC 7162 section 3.2.11: a server that advertises CONDSTORE sends CLOSED as well
    describe('CONDSTORE alone', () => {
        const ctx = setupServer(() => ({ plugins: ['CONDSTORE'], storage: storage() }));

        it('sends CLOSED', (t, done) => {
            ctx.run(['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 EXAMINE INBOX', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^A2 OK[^\r\n]*\r\n\* OK \[CLOSED\] /m);
                done();
            });
        });

        it('does not know QRESYNC', (t, done) => {
            ctx.run(
                [
                    'A1 LOGIN testuser testpass',
                    'A2 SELECT INBOX (QRESYNC (42 1))',
                    'A3 SELECT INBOX',
                    'A4 UID FETCH 1 FLAGS (CHANGEDSINCE 1 VANISHED)',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString();
                    assert.match(resp, /^A2 BAD/m);
                    assert.match(resp, /^A4 BAD/m);
                    assert.doesNotMatch(resp, /QRESYNC/);
                    done();
                }
            );
        });
    });

    // ENABLE and CONDSTORE are loaded once, whatever the order
    describe('listed with CONDSTORE and ENABLE', () => {
        const ctx = setupServer(() => ({ plugins: ['QRESYNC', 'ENABLE', 'CONDSTORE'], storage: storage() }));

        it('loads CONDSTORE and ENABLE once', (t, done) => {
            const cmds = [
                'A1 CAPABILITY',
                'A2 LOGIN testuser testpass',
                'A3 ENABLE QRESYNC',
                'A4 SELECT INBOX (CONDSTORE QRESYNC (42 4))',
                'A5 STORE 2 +FLAGS (\\Seen)',
                'ZZ LOGOUT'
            ];
            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.match(resp, /^\* CAPABILITY IMAP4rev1 ENABLE CONDSTORE QRESYNC\r\n/m);
                assert.match(resp, /^\* 4 FETCH \(UID 4 FLAGS \(\) MODSEQ \(5\)\)\r\nA4 OK/m);
                // a second CONDSTORE plugin would add MODSEQ twice
                assert.match(resp, /^\* 2 FETCH \(FLAGS \(\\Seen\) MODSEQ \(6\) UID 2\)\r\nA5 OK/m);
                done();
            });
        });
    });

    describe('not loaded', () => {
        const ctx = setupServer(() => ({ plugins: ['ENABLE', 'CONDSTORE'], storage: storage() }));

        it('ENABLE QRESYNC enables nothing', (t, done) => {
            ctx.run(
                ['A1 LOGIN testuser testpass', 'A2 ENABLE QRESYNC', 'A3 SELECT INBOX', 'A4 STORE 1 +FLAGS.SILENT (\\Deleted)', 'A5 EXPUNGE', 'ZZ LOGOUT'],
                resp => {
                    resp = resp.toString();
                    assert.match(resp, /^\* ENABLED\r\nA2 OK/m);
                    assert.match(resp, /^\* 1 EXPUNGE\r\nA5 OK EXPUNGE/m);
                    done();
                }
            );
        });
    });
});
