import { describe, it } from 'node:test';
import assert from 'node:assert';
import { setupServer } from './helpers/index.js';
import { openSession, useSessions } from './helpers/session.js';

function storage() {
    return {
        INBOX: {
            messages: [
                { raw: 'Subject: hello 1\r\n\r\nWorld 1!', flags: ['\\Seen'] },
                { raw: 'Subject: hello 2\r\n\r\nWorld 2!', MODSEQ: 100 },
                { raw: 'Subject: hello 3\r\n\r\nWorld 3!' }
            ]
        },
        '': {
            folders: {
                empty: {}
            }
        }
    };
}

describe('CONDSTORE', () => {
    describe('with ENABLE loaded after CONDSTORE', () => {
        const ctx = setupServer(() => ({
            plugins: ['CONDSTORE', 'ENABLE'],
            storage: storage()
        }));

        it('ENABLE CONDSTORE sends ENABLED', (t, done) => {
            const cmds = ['A1 LOGIN testuser testpass', 'A2 ENABLE CONDSTORE X-UNKNOWN', 'A3 ENABLE CONDSTORE', 'ZZ LOGOUT'];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('\r\n* ENABLED CONDSTORE\r\nA2 OK') >= 0, resp);
                // already enabled, nothing new to report
                assert.ok(resp.indexOf('\r\n* ENABLED\r\nA3 OK') >= 0, resp);
                done();
            });
        });

        it('ENABLE CONDSTORE turns on MODSEQ in STORE responses', (t, done) => {
            const cmds = ['A1 LOGIN testuser testpass', 'A2 ENABLE CONDSTORE', 'A3 SELECT INBOX', 'A4 STORE 1 +FLAGS (\\Flagged)', 'ZZ LOGOUT'];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('\r\n* ENABLED CONDSTORE\r\nA2 OK') >= 0, resp);
                assert.ok(resp.indexOf('\r\n* 1 FETCH (FLAGS (\\Seen \\Flagged) MODSEQ (102) UID 1)\r\n') >= 0, resp);
                done();
            });
        });

        // RFC 5161 section 3.1: clients MUST NOT issue ENABLE once they SELECT/EXAMINE a mailbox
        it('ENABLE after SELECT is refused', (t, done) => {
            const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 ENABLE CONDSTORE', 'A4 CLOSE', 'A5 ENABLE CONDSTORE', 'ZZ LOGOUT'];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(/^A3 BAD/m.test(resp), resp);
                assert.ok(/^A5 BAD/m.test(resp), resp);
                done();
            });
        });
    });

    describe('without ENABLE', () => {
        const ctx = setupServer(() => ({
            plugins: ['CONDSTORE'],
            storage: storage()
        }));
        const open = useSessions(ctx);

        it('keeps MODSEQ values from storage and reports HIGHESTMODSEQ', (t, done) => {
            const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 FETCH 1:* (MODSEQ)', 'ZZ LOGOUT'];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('\r\n* OK [HIGHESTMODSEQ 101] Highest\r\n') >= 0, resp);
                assert.ok(resp.indexOf('\r\n* 1 FETCH (MODSEQ (2))\r\n') >= 0, resp);
                assert.ok(resp.indexOf('\r\n* 2 FETCH (MODSEQ (100))\r\n') >= 0, resp);
                assert.ok(resp.indexOf('\r\n* 3 FETCH (MODSEQ (101))\r\n') >= 0, resp);
                done();
            });
        });

        it('reports a positive HIGHESTMODSEQ for an empty mailbox', (t, done) => {
            const cmds = ['A1 LOGIN testuser testpass', 'A2 STATUS empty (MESSAGES HIGHESTMODSEQ)', 'A3 SELECT empty', 'ZZ LOGOUT'];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('\r\n* STATUS empty (MESSAGES 0 HIGHESTMODSEQ 1)\r\n') >= 0, resp);
                assert.ok(resp.indexOf('\r\n* OK [HIGHESTMODSEQ 1] Highest\r\n') >= 0, resp);
                done();
            });
        });

        it('includes MODSEQ in STORE responses once enabled, also after a plain SELECT', (t, done) => {
            const cmds = [
                'A1 LOGIN testuser testpass',
                'A2 SELECT INBOX (CONDSTORE)',
                'A3 SELECT INBOX',
                'A4 STORE 3 +FLAGS (\\Flagged)',
                'A5 STORE 3 +FLAGS.SILENT (\\Answered)',
                'ZZ LOGOUT'
            ];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('\r\n* 3 FETCH (FLAGS (\\Flagged) MODSEQ (102) UID 3)\r\nA4 OK') >= 0, resp);
                assert.ok(resp.indexOf('\r\n* 3 FETCH (UID 3 MODSEQ (103))\r\nA5 OK') >= 0, resp);
                done();
            });
        });

        it('does not include MODSEQ in STORE responses when not enabled', (t, done) => {
            const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 STORE 3 +FLAGS (\\Flagged)', 'A4 FETCH 3 (MODSEQ)', 'ZZ LOGOUT'];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('\r\n* 3 FETCH (FLAGS (\\Flagged))\r\nA3 OK') >= 0, resp);
                assert.ok(resp.indexOf('\r\n* 3 FETCH (MODSEQ (102))\r\nA4 OK') >= 0, resp);
                done();
            });
        });

        it('does not bump MODSEQ when nothing changed', (t, done) => {
            const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX (CONDSTORE)', 'A3 STORE 1 +FLAGS (\\Seen)', 'ZZ LOGOUT'];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('\r\n* 1 FETCH (FLAGS (\\Seen) MODSEQ (2) UID 1)\r\nA3 OK') >= 0, resp);
                assert.strictEqual(ctx.server.getMailbox('INBOX')!.HIGHESTMODSEQ, 101);
                done();
            });
        });

        it('UNCHANGEDSINCE reports failed messages with MODIFIED and does not change them', (t, done) => {
            const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 STORE 1:3 (UNCHANGEDSINCE 100) +FLAGS.SILENT (\\Deleted)', 'ZZ LOGOUT'];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('\r\n* 1 FETCH (UID 1 MODSEQ (102))\r\n* 2 FETCH (UID 2 MODSEQ (103))\r\nA3 OK [MODIFIED 3]') >= 0, resp);
                const messages = ctx.server.getMailbox('INBOX')!.messages;
                assert.deepStrictEqual(messages[2].flags, []);
                assert.strictEqual(messages[2].MODSEQ, 101);
                done();
            });
        });

        it('UID STORE UNCHANGEDSINCE reports UIDs with MODIFIED', (t, done) => {
            const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 UID STORE 1:3 (UNCHANGEDSINCE 100) +FLAGS (\\Deleted)', 'ZZ LOGOUT'];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('\r\nA3 OK [MODIFIED 3]') >= 0, resp);
                assert.ok(resp.indexOf('UID 3') < 0, resp);
                assert.strictEqual(ctx.server.getMailbox('INBOX')!.messages[2].MODSEQ, 101);
                done();
            });
        });

        it('rejects an invalid UNCHANGEDSINCE value', (t, done) => {
            const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 STORE 1 (UNCHANGEDSINCE abc) +FLAGS (\\Deleted)', 'ZZ LOGOUT'];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('\r\nA3 BAD') >= 0, resp);
                done();
            });
        });

        it('FETCH CHANGEDSINCE returns changed messages with MODSEQ', (t, done) => {
            const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 FETCH 1:* (FLAGS) (CHANGEDSINCE 2)', 'ZZ LOGOUT'];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('* 1 FETCH') < 0, resp);
                assert.ok(resp.indexOf('\r\n* 2 FETCH (FLAGS () MODSEQ (100))\r\n') >= 0, resp);
                assert.ok(resp.indexOf('\r\n* 3 FETCH (FLAGS () MODSEQ (101))\r\n') >= 0, resp);
                done();
            });
        });

        it('FETCH that sets \\Seen bumps MODSEQ', (t, done) => {
            const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 FETCH 3 (BODY[] MODSEQ)', 'ZZ LOGOUT'];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('World 3! MODSEQ (102) FLAGS (\\Seen) UID 3)\r\nA3 OK') >= 0, resp);
                done();
            });
        });

        it('EXPUNGE bumps HIGHESTMODSEQ', (t, done) => {
            const cmds = [
                'A1 LOGIN testuser testpass',
                'A2 SELECT INBOX',
                'A3 STORE 1 +FLAGS.SILENT (\\Deleted)',
                'A4 EXPUNGE',
                'A5 SELECT INBOX',
                'ZZ LOGOUT'
            ];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('\r\n* OK [HIGHESTMODSEQ 103] Highest\r\n') >= 0, resp);
                done();
            });
        });

        // RFC 7162 section 3.1: UID and MODSEQ in every untagged FETCH once enabled, also for changes by an external agent
        it('includes MODSEQ in flag changes made by another session', (t, done) => {
            openSession(ctx.port, watcher => {
                watcher.run('W1 LOGIN testuser testpass', () => {
                    watcher.run('W2 SELECT INBOX (CONDSTORE)', () => {
                        openSession(ctx.port, other => {
                            other.run('O1 LOGIN testuser testpass', () => {
                                other.run('O2 SELECT INBOX', () => {
                                    other.run('O3 STORE 3 +FLAGS (\\Flagged)', () => {
                                        watcher.run('W3 NOOP', resp => {
                                            watcher.close();
                                            other.close();
                                            assert.match(resp, /^\* 3 FETCH \(UID 3 FLAGS \(\\Flagged\) MODSEQ \(102\)\)\r\nW3 OK/m);
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

        it('reports a message changed twice by another session once, with its current MODSEQ', async () => {
            const watcher = await open('INBOX (CONDSTORE)');
            const other = await open('INBOX');
            await other.cmd('STORE 3 +FLAGS (\\Flagged)');
            await other.cmd('STORE 3 +FLAGS (\\Answered)');
            const resp = await watcher.cmd('NOOP');
            assert.deepStrictEqual(
                resp.split('\r\n').filter(line => /^\* \d+ FETCH /.test(line)),
                ['* 3 FETCH (UID 3 FLAGS (\\Flagged \\Answered) MODSEQ (103))'],
                resp
            );
        });

        it('appended messages get a new MODSEQ', (t, done) => {
            const message = 'Subject: new\r\n\r\nnew';
            const cmds = [
                'A1 LOGIN testuser testpass',
                'A2 APPEND empty {' + message.length + '}\r\n' + message,
                'A3 STATUS empty (HIGHESTMODSEQ)',
                'ZZ LOGOUT'
            ];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('\r\n* STATUS empty (HIGHESTMODSEQ 2)\r\n') >= 0, resp);
                done();
            });
        });
    });

    // RFC 7162 section 3.1.5
    describe('SEARCH MODSEQ', () => {
        const ctx = setupServer(() => ({
            plugins: ['CONDSTORE', 'ESEARCH', 'SEARCHRES'],
            storage: storage()
        }));

        const SELECT = ['L1 LOGIN testuser testpass', 'L2 SELECT INBOX'];

        // message 1 has MODSEQ 2, message 2 MODSEQ 100 and message 3 MODSEQ 101
        it('finds messages with an equal or higher mod-sequence', (t, done) => {
            const cmds = [...SELECT, 'A1 SEARCH MODSEQ 100', 'A2 UID SEARCH MODSEQ 0', 'A3 SEARCH MODSEQ 101 UID 3', 'ZZ LOGOUT'];
            ctx.run(cmds, resp => {
                resp = resp.toString();
                // RFC 7162 section 3.1.6: the highest mod-sequence of the found messages is appended
                assert.ok(/^\* SEARCH 2 3 \(MODSEQ 101\)\r\nA1 OK /m.test(resp), resp);
                assert.ok(/^\* SEARCH 1 2 3 \(MODSEQ 101\)\r\nA2 OK /m.test(resp), resp);
                assert.ok(/^\* SEARCH 3 \(MODSEQ 101\)\r\nA3 OK /m.test(resp), resp);
                done();
            });
        });

        it('reports the highest mod-sequence of the found messages only', (t, done) => {
            ctx.run([...SELECT, 'A1 SEARCH MODSEQ 1 SEEN', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.ok(/^\* SEARCH 1 \(MODSEQ 2\)\r\nA1 OK /m.test(resp), resp);
                done();
            });
        });

        // Example 16: no mod-sequence when nothing was found
        it('sends a plain SEARCH response when nothing matched', (t, done) => {
            ctx.run([...SELECT, 'A1 SEARCH OR NOT MODSEQ 1 LARGER 50000', 'A2 SEARCH MODSEQ 102', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.ok(/^\* SEARCH\r\nA1 OK /m.test(resp), resp);
                assert.ok(/^\* SEARCH\r\nA2 OK /m.test(resp), resp);
                done();
            });
        });

        // Example 15: entry name and type are ignored, mod-sequences are not stored per flag
        it('accepts an entry name and type', (t, done) => {
            const cmds = [
                ...SELECT,
                'A1 SEARCH MODSEQ "/flags/\\\\draft" all 100',
                'A2 SEARCH MODSEQ "/flags/$MDNSent" priv 100',
                'A3 SEARCH MODSEQ "/FLAGS/\\\\Seen" SHARED 100',
                'ZZ LOGOUT'
            ];
            ctx.run(cmds, resp => {
                resp = resp.toString();
                for (const tag of ['A1', 'A2', 'A3']) {
                    assert.ok(new RegExp('^\\* SEARCH 2 3 \\(MODSEQ 101\\)\\r\\n' + tag + ' OK ', 'm').test(resp), resp);
                }
                done();
            });
        });

        // RFC 7162 section 3.1: SEARCH with the MODSEQ search key is a CONDSTORE enabling command
        it('enables CONDSTORE', (t, done) => {
            ctx.run([...SELECT, 'A1 SEARCH MODSEQ 1', 'A2 SEARCH MODSEQ 1', 'A3 STORE 1 +FLAGS (\\Flagged)', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.ok(/^A1 OK .*\r\n/m.test(resp), resp);
                assert.ok(/^\* OK \[HIGHESTMODSEQ 101\] .*\r\n\* SEARCH 1 2 3 \(MODSEQ 101\)\r\nA1 OK /m.test(resp), resp);
                assert.ok(/^A1 OK .*\r\n\* SEARCH 1 2 3 \(MODSEQ 101\)\r\nA2 OK /m.test(resp), resp);
                assert.ok(/^\* 1 FETCH \(FLAGS \(\\Seen \\Flagged\) MODSEQ \(102\) UID 1\)\r\n/m.test(resp), resp);
                done();
            });
        });

        it('does not enable CONDSTORE without the MODSEQ key', (t, done) => {
            ctx.run([...SELECT, 'A1 SEARCH SUBJECT MODSEQ', 'A2 STORE 1 +FLAGS (\\Flagged)', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.ok(/^\* SEARCH\r\nA1 OK /m.test(resp), resp);
                assert.ok(/^\* 1 FETCH \(FLAGS \(\\Seen \\Flagged\)\)\r\n/m.test(resp), resp);
                done();
            });
        });

        // RFC 4731 section 3.2 and RFC 7162 section 3.1.10
        it('adds MODSEQ to ESEARCH responses', (t, done) => {
            const cmds = [
                ...SELECT,
                'A1 SEARCH RETURN (MIN) MODSEQ 1',
                'A2 SEARCH RETURN (MAX) MODSEQ 1 SEEN',
                'A3 SEARCH RETURN (MIN MAX) MODSEQ 1 NOT 2',
                'A4 SEARCH RETURN (MIN COUNT) MODSEQ 1',
                'A5 UID SEARCH RETURN () MODSEQ 1 SEEN',
                'A6 SEARCH RETURN (COUNT) MODSEQ 102',
                'A7 SEARCH RETURN (MIN) MODSEQ 1 NOT 3',
                'ZZ LOGOUT'
            ];
            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(/^\* ESEARCH \(TAG "A1"\) MIN 1 MODSEQ 2\r\nA1 OK /m.test(resp), resp);
                assert.ok(/^\* ESEARCH \(TAG "A2"\) MAX 1 MODSEQ 2\r\nA2 OK /m.test(resp), resp);
                assert.ok(/^\* ESEARCH \(TAG "A3"\) MIN 1 MAX 3 MODSEQ 101\r\nA3 OK /m.test(resp), resp);
                assert.ok(/^\* ESEARCH \(TAG "A4"\) MIN 1 COUNT 3 MODSEQ 101\r\nA4 OK /m.test(resp), resp);
                assert.ok(/^\* ESEARCH \(TAG "A5"\) UID ALL 1 MODSEQ 2\r\nA5 OK /m.test(resp), resp);
                assert.ok(/^\* ESEARCH \(TAG "A6"\) COUNT 0\r\nA6 OK /m.test(resp), resp);
                assert.ok(/^\* ESEARCH \(TAG "A7"\) MIN 1 MODSEQ 2\r\nA7 OK /m.test(resp), resp);
                assert.ok(!/^\* SEARCH/m.test(resp), resp);
                done();
            });
        });

        it('sends no response for SAVE alone', (t, done) => {
            ctx.run([...SELECT, 'A1 SEARCH RETURN (SAVE) MODSEQ 100', 'A2 FETCH $ UID', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.ok(!/SEARCH/.test(resp.split('A1 OK')[0].split('L2 OK')[1]), resp);
                assert.ok(/^\* 2 FETCH \(UID 2\)\r\n\* 3 FETCH \(UID 3\)\r\nA2 OK /m.test(resp), resp);
                done();
            });
        });

        // RFC 7162 section 7: search-modsequence = "MODSEQ" [search-modseq-ext] SP mod-sequence-valzer
        const BAD = [
            ['MODSEQ without a value', 'SEARCH MODSEQ'],
            ['MODSEQ with a negative value', 'SEARCH MODSEQ -1'],
            ['MODSEQ with a value over 63 bits', 'SEARCH MODSEQ 9223372036854775808'],
            ['MODSEQ with an entry name but no value', 'SEARCH MODSEQ "/flags/\\\\seen" all'],
            ['MODSEQ with an entry name but no type', 'SEARCH MODSEQ "/flags/\\\\seen" 5'],
            ['MODSEQ with an unknown entry type', 'SEARCH MODSEQ "/flags/\\\\seen" both 5'],
            ['MODSEQ with an entry name that is not a flag', 'SEARCH MODSEQ "/foo/bar" all 5'],
            ['MODSEQ with \\Recent', 'SEARCH MODSEQ "/flags/\\\\recent" all 5'],
            ['MODSEQ with an empty flag', 'SEARCH MODSEQ "/flags/" all 5']
        ];
        for (const [description, command] of BAD) {
            it('refuses ' + description, (t, done) => {
                ctx.run([...SELECT, 'A1 ' + command, 'ZZ LOGOUT'], resp => {
                    resp = resp.toString();
                    assert.ok(/^A1 BAD /m.test(resp), resp);
                    done();
                });
            });
        }

        it('accepts the largest mod-sequence value', (t, done) => {
            ctx.run([...SELECT, 'A1 SEARCH MODSEQ 9223372036854775807', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.ok(/^\* SEARCH\r\nA1 OK /m.test(resp), resp);
                done();
            });
        });

        // RFC 3501 section 5.5: the arguments of MODSEQ are not sequence numbers
        it('does not treat MODSEQ arguments as sequence numbers when pipelined', (t, done) => {
            openSession(ctx.port, session => {
                session.run('S1 LOGIN testuser testpass', () => {
                    session.run('S2 SELECT INBOX', () => {
                        session.run(
                            'A1 NOOP\r\nA2 SEARCH MODSEQ "/flags/\\\\seen" all 100\r\nA3 NOOP\r\nA4 SEARCH MODSEQ 100 2',
                            resp => {
                                session.close();
                                assert.ok(/^A2 OK /m.test(resp), resp);
                                assert.ok(/^A4 BAD /m.test(resp), resp);
                                done();
                            },
                            'A4'
                        );
                    });
                });
            });
        });
    });

    describe('SEARCH MODSEQ without CONDSTORE', () => {
        const ctx = setupServer(() => ({ storage: storage() }));

        it('refuses the MODSEQ search key', (t, done) => {
            ctx.run(['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH MODSEQ 1', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.ok(/^A3 BAD /m.test(resp), resp);
                assert.ok(!/HIGHESTMODSEQ/.test(resp), resp);
                done();
            });
        });
    });
});
