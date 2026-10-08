// UIDONLY, RFC 9586 (https://www.rfc-editor.org/rfc/rfc9586.txt)

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { setupServer, assertTagged } from './helpers/index.js';
import { openSession } from './helpers/session.js';
import type { Session } from './helpers/session.js';
import type { TestContext } from './helpers/index.js';

const message = (n: number) => 'From: sender@example.com\r\nSubject: message ' + n + '\r\nDate: 1 Jan 2024 10:0' + n + ':00 +0000\r\n\r\nBody ' + n + '\r\n';

// INBOX holds UIDs 10, 20, 30 and 40, message 2 (UID 20) is \Seen
function storage() {
    return {
        INBOX: {
            uidvalidity: 42,
            uidnext: 41,
            messages: [10, 20, 30, 40].map((uid, i) => ({ raw: message(i + 1), uid, flags: uid === 20 ? ['\\Seen'] : [] }))
        },
        '': {
            folders: {
                Archive: { uidvalidity: 7 }
            }
        }
    };
}

const PLUGINS = [
    'UIDONLY',
    'UIDPLUS',
    'MOVE',
    'ESEARCH',
    'SEARCHRES',
    'SORT',
    'THREAD=REFERENCES',
    'REPLACE',
    'IDLE',
    'UNAUTHENTICATE',
    'LITERALPLUS',
    'MULTISEARCH',
    'NOTIFY'
];
const LOGIN = 'A1 LOGIN testuser testpass';
const ENABLE = 'A2 ENABLE UIDONLY';
const SELECT = 'A3 SELECT INBOX';

// replays commands, the callback gets the transcript as a binary string
const run = (ctx: TestContext, commands: string[], callback: (resp: string) => void) => ctx.run(commands, resp => callback(resp.toString('binary')));

describe('UIDONLY', () => {
    const ctx = setupServer(() => ({ plugins: PLUGINS, storage: storage() }));

    it('is advertised and enabled with ENABLE (RFC 9586 section 3.1)', (t, done) => {
        run(ctx, ['A0 CAPABILITY', LOGIN, ENABLE], resp => {
            assert.match(resp, /^\* CAPABILITY .*\bUIDONLY\b/m);
            assert.match(resp, /^\* ENABLED UIDONLY\r$/m);
            done();
        });
    });

    it('changes nothing until it is enabled', (t, done) => {
        run(ctx, [LOGIN, SELECT, 'A4 FETCH 1 FLAGS', 'A5 UID FETCH 20 FLAGS', 'A6 SEARCH ALL'], resp => {
            assert.match(resp, /^\* OK \[UNSEEN 1\]/m);
            assert.match(resp, /^\* 1 FETCH \(FLAGS \(\)\)\r$/m);
            assert.match(resp, /^\* 2 FETCH \(FLAGS \(\\Seen\) UID 20\)\r$/m);
            assert.match(resp, /^\* SEARCH 1 2 3 4\r$/m);
            assert.doesNotMatch(resp, /UIDFETCH/);
            done();
        });
    });

    // RFC 9586 section 3: tagged BAD with UIDREQUIRED, sections 3.2 and 3.8: the commands with message numbers
    const REFUSED = [
        'FETCH 1 FLAGS',
        'FETCH 1:* (UID FLAGS)',
        'STORE 1 +FLAGS (\\Seen)',
        'SEARCH ALL',
        'SEARCH UID 10',
        'SEARCH RETURN (ALL) ALL',
        'COPY 1 Archive',
        'MOVE 1 Archive',
        'SORT (DATE) UTF-8 ALL',
        'THREAD REFERENCES UTF-8 ALL',
        // section 3.5: the <sequence set> search key, also nested and in UID SORT and UID THREAD
        'UID SEARCH 1:2',
        'UID SEARCH *',
        'UID SEARCH NOT (1)',
        'UID SEARCH OR 1 UID 10',
        'UID SEARCH RETURN (ALL) 1',
        'UID SORT (DATE) UTF-8 1:2',
        'UID THREAD REFERENCES UTF-8 1'
    ];
    REFUSED.forEach(command => {
        it('refuses ' + command + ' with BAD [UIDREQUIRED]', (t, done) => {
            run(ctx, [LOGIN, ENABLE, SELECT, 'A4 ' + command, 'A5 NOOP'], resp => {
                assert.match(resp, /^A4 BAD \[UIDREQUIRED\] /m);
                assert.doesNotMatch(resp, /^\* (SEARCH|ESEARCH|SORT|THREAD|\d+ (UID)?FETCH)\b/m);
                assertTagged(resp, { A5: 'OK' });
                done();
            });
        });
    });

    it('refuses a prohibited command before its literal is sent', (t, done) => {
        run(ctx, [LOGIN, ENABLE, SELECT, 'A4 SEARCH SUBJECT {7}\r\nmessage', 'A5 REPLACE 1 INBOX {5}\r\nhello', 'A6 NOOP'], resp => {
            assert.match(resp, /^A4 BAD \[UIDREQUIRED\] /m);
            assert.match(resp, /^A5 BAD \[UIDREQUIRED\] /m);
            assert.doesNotMatch(resp, /^\+ /m);
            assertTagged(resp, { A6: 'OK' });
            done();
        });
    });

    it('refuses REPLACE sent with a non-synchronizing literal', (t, done) => {
        run(ctx, [LOGIN, ENABLE, SELECT, 'A4 REPLACE 1 INBOX {5+}\r\nhello', 'A5 UID FETCH 1:* FLAGS'], resp => {
            assert.match(resp, /^A4 BAD \[UIDREQUIRED\] /m);
            assert.match(resp, /^\* 10 UIDFETCH/m);
            assert.doesNotMatch(resp, /^\* 41 UIDFETCH/m);
            done();
        });
    });

    it('allows the UID variants and UID search keys (RFC 9586 sections 3.2 and 3.5)', (t, done) => {
        run(
            ctx,
            [
                LOGIN,
                ENABLE,
                SELECT,
                'A4 UID SEARCH ALL',
                'A5 UID SEARCH UID 15:35 NOT SEEN',
                'A6 UID SEARCH RETURN (MIN MAX) UID 1:*',
                'A7 UID SORT (REVERSE DATE) UTF-8 ALL',
                'A8 UID THREAD REFERENCES UTF-8 UID 10:20',
                'A9 UID SEARCH SUBJECT "1"'
            ],
            resp => {
                assertTagged(resp, { A4: 'OK', A5: 'OK', A6: 'OK', A7: 'OK', A8: 'OK', A9: 'OK' });
                assert.match(resp, /^\* SEARCH 10 20 30 40\r$/m);
                assert.match(resp, /^\* SEARCH 30\r$/m);
                assert.match(resp, /^\* ESEARCH \(TAG "A6"\) UID MIN 10 MAX 40\r$/m);
                assert.match(resp, /^\* SORT 40 30 20 10\r$/m);
                assert.match(resp, /^\* THREAD \(10\)\(20\)\r$/m);
                assert.match(resp, /^\* SEARCH 10\r$/m);
                done();
            }
        );
    });

    // RFC 7377 section 2: the ESEARCH command always returns UIDs, only message numbers in its criteria are refused
    it('allows the ESEARCH command of MULTISEARCH without message numbers', (t, done) => {
        run(
            ctx,
            [
                LOGIN,
                ENABLE,
                SELECT,
                'A4 ESEARCH IN (selected) RETURN (ALL) UNSEEN',
                'A5 ESEARCH IN (selected) 1:2',
                'A6 ESEARCH IN (mailboxes INBOX) UID 10:20'
            ],
            resp => {
                assert.match(resp, /^\* ESEARCH \(TAG "A4" MAILBOX INBOX UIDVALIDITY 42\) UID ALL 10,30,40\r$/m);
                assert.match(resp, /^A5 BAD \[UIDREQUIRED\] /m);
                assertTagged(resp, { A4: 'OK', A6: 'OK' });
                done();
            }
        );
    });

    it('does not send the UNSEEN response code of SELECT, EXISTS stays (RFC 9586 section 3.6)', (t, done) => {
        run(ctx, [LOGIN, ENABLE, SELECT, 'A4 EXAMINE INBOX'], resp => {
            assert.doesNotMatch(resp, /UNSEEN/);
            assert.strictEqual(resp.match(/^\* 4 EXISTS\r$/gm)!.length, 2);
            assert.match(resp, /^\* OK \[UIDNEXT 41\]/m);
            done();
        });
    });

    // RFC 9586 section 3.3
    it('answers UID FETCH with UIDFETCH responses', (t, done) => {
        run(ctx, [LOGIN, ENABLE, SELECT, 'A4 UID FETCH 15:40 (FLAGS)', 'A5 UID FETCH 20 (UID FLAGS)', 'A6 UID FETCH 10 FLAGS'], resp => {
            assert.match(resp, /^\* 20 UIDFETCH \(FLAGS \(\\Seen\)\)\r$/m);
            assert.match(resp, /^\* 30 UIDFETCH \(FLAGS \(\)\)\r$/m);
            assert.match(resp, /^\* 40 UIDFETCH \(FLAGS \(\)\)\r$/m);
            // UID is only returned as a data item when the client asks for it
            assert.match(resp, /^\* 20 UIDFETCH \(UID 20 FLAGS \(\\Seen\)\)\r$/m);
            assert.match(resp, /^\* 10 UIDFETCH \(FLAGS \(\)\)\r$/m);
            assert.doesNotMatch(resp, /^\* \d+ FETCH/m);
            done();
        });
    });

    it('sends UIDFETCH with literals and an implicitly set \\Seen flag', (t, done) => {
        run(ctx, [LOGIN, ENABLE, SELECT, 'A4 UID FETCH 30 BODY[TEXT]'], resp => {
            assert.match(resp, /^\* 30 UIDFETCH \(BODY\[TEXT\] \{8\}\r\nBody 3\r\n FLAGS \(\\Seen\)\)\r$/m);
            done();
        });
    });

    it('answers UID STORE with UIDFETCH responses', (t, done) => {
        run(ctx, [LOGIN, ENABLE, SELECT, 'A4 UID STORE 10,30 +FLAGS (\\Flagged)', 'A5 UID STORE 40 +FLAGS.SILENT (\\Flagged)'], resp => {
            assert.match(resp, /^\* 10 UIDFETCH \(FLAGS \(\\Flagged\)\)\r$/m);
            assert.match(resp, /^\* 30 UIDFETCH \(FLAGS \(\\Flagged\)\)\r$/m);
            assert.doesNotMatch(resp, /^\* 40 /m);
            assertTagged(resp, { A4: 'OK', A5: 'OK' });
            done();
        });
    });

    // RFC 9586 section 3.4
    it('reports EXPUNGE and UID EXPUNGE with VANISHED', (t, done) => {
        run(
            ctx,
            [LOGIN, ENABLE, SELECT, 'A4 UID STORE 10,20,40 +FLAGS.SILENT (\\Deleted)', 'A5 UID EXPUNGE 40', 'A6 EXPUNGE', 'A7 UID FETCH 1:* FLAGS'],
            resp => {
                assert.match(resp, /^\* VANISHED 40\r\nA5 OK/m);
                assert.match(resp, /^\* VANISHED 10,20\r\nA6 OK/m);
                assert.doesNotMatch(resp, /EXPUNGE\r$/m);
                assert.match(resp, /^\* 30 UIDFETCH \(FLAGS \(\)\)\r\nA7 OK/m);
                done();
            }
        );
    });

    // RFC 9586 section 3.6 example
    it('answers UID MOVE with COPYUID and VANISHED', (t, done) => {
        run(ctx, [LOGIN, ENABLE, SELECT, 'A4 UID MOVE 20 Archive', 'A5 UID COPY 30,40 Archive'], resp => {
            assert.match(resp, /^\* OK \[COPYUID 7 20 1\] .*\r\n\* VANISHED 20\r\nA4 OK/m);
            assert.match(resp, /^A5 OK \[COPYUID 7 30,40 2,3\]/m);
            done();
        });
    });

    it('works with SEARCHRES and UID REPLACE', (t, done) => {
        run(
            ctx,
            [
                LOGIN,
                ENABLE,
                SELECT,
                'A4 UID SEARCH RETURN (SAVE) UID 20:30',
                'A5 UID FETCH $ (FLAGS)',
                'A6 UID REPLACE 30 INBOX {7}\r\nSubject',
                'A7 UID FETCH $ FLAGS'
            ],
            resp => {
                assert.match(resp, /^\* 20 UIDFETCH \(FLAGS \(\\Seen\)\)\r\n\* 30 UIDFETCH \(FLAGS \(\)\)\r\nA5 OK/m);
                assert.match(resp, /^\* OK \[APPENDUID 42 41\] .*\r\n\* 5 EXISTS\r\n\* 1 RECENT\r\n\* VANISHED 30\r\nA6 OK/m);
                assert.match(resp, /^\* 20 UIDFETCH \(FLAGS \(\\Seen\)\)\r\nA7 OK/m);
                done();
            }
        );
    });

    it('refuses pipelined commands with message numbers with BAD [UIDREQUIRED], not as ambiguous', (t, done) => {
        openSession(ctx.port, session => {
            session.run(LOGIN, () => {
                session.run(ENABLE, () => {
                    session.run(SELECT, () => {
                        session.run(
                            ['B1 CHECK', 'B2 FETCH 1 FLAGS', 'B3 UID FETCH 10 FLAGS'].join('\r\n'),
                            resp => {
                                session.close();
                                assert.match(resp, /^B2 BAD \[UIDREQUIRED\] /m);
                                assert.match(resp, /^\* 10 UIDFETCH \(FLAGS \(\)\)\r\nB3 OK/m);
                                done();
                            },
                            'B3'
                        );
                    });
                });
            });
        });
    });

    it('ends with UNAUTHENTICATE (RFC 8437 section 4.1)', (t, done) => {
        // an empty mailbox, as the response validator keeps refusing message numbers after ENABLED UIDONLY
        run(ctx, [LOGIN, ENABLE, 'A3 UNAUTHENTICATE', 'A4 LOGIN testuser testpass', 'A5 SELECT Archive', 'A6 SEARCH ALL'], resp => {
            assert.match(resp, /^\* SEARCH\r\nA6 OK/m);
            done();
        });
    });

    it('can not be enabled after SELECT (RFC 5161 section 3.1)', (t, done) => {
        run(ctx, [LOGIN, SELECT, 'A4 ENABLE UIDONLY', 'A5 FETCH 1 FLAGS'], resp => {
            assertTagged(resp, { A4: 'BAD', A5: 'OK' });
            done();
        });
    });
});

describe('UIDONLY with other sessions (RFC 9586 section 3.6)', () => {
    const ctx = setupServer(() => ({ plugins: PLUGINS, storage: storage() }));

    let sessions: Session[] = [];
    let tagCounter = 0;

    // a logged in session with INBOX selected, `cmd(line)` resolves with the output up to the tagged response
    const open = (enable: boolean) =>
        new Promise<{ session: Session; cmd: (line: string) => Promise<string> }>(resolve => {
            openSession(ctx.port, session => {
                sessions.push(session);
                const wrapped = {
                    session,
                    cmd: (line: string) => new Promise<string>(done => session.run('T' + ++tagCounter + ' ' + line, done))
                };
                wrapped
                    .cmd('LOGIN testuser testpass')
                    .then((): unknown => enable && wrapped.cmd('ENABLE UIDONLY'))
                    .then(() => wrapped.cmd('SELECT INBOX'))
                    .then(() => resolve(wrapped));
            });
        });

    afterEach(() => {
        sessions.forEach(session => session.close());
        sessions = [];
    });

    it('announces flag changes with UIDFETCH and expunges with VANISHED', async () => {
        const watcher = await open(true);
        const other = await open(false);
        await other.cmd('STORE 1 +FLAGS (\\Flagged)');
        await other.cmd('STORE 4 +FLAGS (\\Deleted)');
        await other.cmd('EXPUNGE');
        await other.cmd('APPEND INBOX {7}\r\nSubject');
        const resp = await watcher.cmd('NOOP');
        assert.match(resp, /^\* 10 UIDFETCH \(FLAGS \(\\Flagged\)\)\r$/m);
        // the flag change of an expunged message is not reported, VANISHED tells the rest
        assert.doesNotMatch(resp, /^\* 40 UIDFETCH/m);
        assert.match(resp, /^\* VANISHED 40\r$/m);
        // EXISTS is not affected
        assert.match(resp, /^\* 3 EXISTS\r$/m);
        assert.match(resp, /^\* 4 EXISTS\r$/m);
        assert.doesNotMatch(resp, /^\* \d+ (FETCH|EXPUNGE)\r?$/m);
    });

    it('sends the NOTIFY MessageNew FETCH as UIDFETCH (RFC 5465 section 5.2)', async () => {
        const watcher = await open(true);
        const other = await open(false);
        assert.match(await watcher.cmd('NOTIFY SET (selected (MessageNew (FLAGS) MessageExpunge FlagChange))'), /^T\d+ OK/m);
        await other.cmd('APPEND INBOX (\\Seen) {7}\r\nSubject');
        const resp = await watcher.cmd('NOOP');
        assert.match(resp, /^\* 5 EXISTS\r\n\* 41 UIDFETCH \(FLAGS \(\\Seen \\Recent\)\)\r$/m);
        assert.doesNotMatch(resp, /^\* \d+ FETCH/m);
    });

    it('announces changes while idling', async () => {
        const watcher = await open(true);
        const other = await open(false);
        const idle = new Promise<string>(resolve => {
            watcher.session.run('I1 IDLE', resolve);
        });
        // wait for the continuation request of IDLE
        await new Promise<void>(resolve => setTimeout(resolve, 50));
        await other.cmd('UID STORE 30 +FLAGS (\\Deleted)');
        await other.cmd('UID EXPUNGE 30');
        await new Promise<void>(resolve => setTimeout(resolve, 50));
        watcher.session.raw('DONE\r\n');
        const resp = await idle;
        assert.match(resp, /^\* 30 UIDFETCH \(FLAGS \(\\Deleted\)\)\r\n\* VANISHED 30\r\n\* 3 EXISTS\r$/m);
    });
});

describe('UIDONLY with CONDSTORE and QRESYNC (RFC 9586 section 3.7)', () => {
    const ctx = setupServer(() => ({ plugins: ['UIDONLY', 'QRESYNC', 'UIDPLUS'], storage: storage() }));

    it('returns MODSEQ in UIDFETCH responses', (t, done) => {
        run(
            ctx,
            [
                LOGIN,
                'A2 ENABLE UIDONLY CONDSTORE',
                SELECT,
                'A4 UID FETCH 10 (FLAGS MODSEQ)',
                'A5 UID STORE 20 -FLAGS (\\Seen)',
                'A6 UID FETCH 1:* FLAGS (CHANGEDSINCE 5)'
            ],
            resp => {
                assert.match(resp, /^\* 10 UIDFETCH \(FLAGS \(\) MODSEQ \(2\)\)\r$/m);
                assert.match(resp, /^\* 20 UIDFETCH \(FLAGS \(\) MODSEQ \(6\)\)\r$/m);
                assert.match(resp, /^\* 20 UIDFETCH \(FLAGS \(\) MODSEQ \(6\)\)\r\nA6 OK/m);
                done();
            }
        );
    });

    it('reports flag changes and expunges of SELECT (QRESYNC) with UIDFETCH and VANISHED (EARLIER)', (t, done) => {
        run(
            ctx,
            [
                LOGIN,
                'A2 ENABLE UIDONLY QRESYNC',
                SELECT,
                'A4 UID STORE 30 +FLAGS.SILENT (\\Deleted)',
                'A5 UID EXPUNGE 30',
                'A6 UID STORE 10 +FLAGS.SILENT (\\Flagged)',
                'A7 SELECT INBOX (QRESYNC (42 5 1:40))'
            ],
            resp => {
                assert.match(resp, /^\* VANISHED 30\r\nA5 OK \[HIGHESTMODSEQ 7\]/m);
                // the silent STORE still reports the new mod-sequence (RFC 7162 section 3.1)
                assert.match(resp, /^\* 10 UIDFETCH \(MODSEQ \(8\)\)\r\nA6 OK/m);
                assert.match(resp, /^\* VANISHED \(EARLIER\) 30\r$/m);
                assert.match(resp, /^\* 10 UIDFETCH \(FLAGS \(\\Flagged\) MODSEQ \(8\)\)\r$/m);
                assertTagged(resp, { A7: 'OK' });
                done();
            }
        );
    });

    it('refuses the QRESYNC message sequence match data with BAD [UIDREQUIRED]', (t, done) => {
        run(ctx, [LOGIN, 'A2 ENABLE UIDONLY QRESYNC', 'A3 SELECT INBOX (QRESYNC (42 1 1:40 (1:2 10,20)))', 'A4 SELECT INBOX (QRESYNC (42 1 1:40))'], resp => {
            assert.match(resp, /^A3 BAD \[UIDREQUIRED\] /m);
            assertTagged(resp, { A4: 'OK' });
            done();
        });
    });
});
