import { describe, it } from 'node:test';
import assert from 'node:assert';
import { setupServer } from './helpers/index.js';
import { openSession } from './helpers/session.js';

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
        '': {
            folders: {
                target: {}
            }
        }
    };
}

const LOGIN = ['L1 LOGIN testuser testpass', 'L2 SELECT INBOX'];

// sequence numbers of the untagged FETCH responses for a tag
const fetched = (resp: string, tag: string) => {
    const block = resp.split(/\r\n/);
    const end = block.findIndex(line => line.startsWith(tag + ' '));
    const numbers: number[] = [];
    for (let i = end - 1; i >= 0 && block[i].startsWith('* '); i--) {
        const match = block[i].match(/^\* (\d+) FETCH /);
        if (match) {
            numbers.unshift(Number(match[1]));
        }
    }
    return numbers;
};

describe('SEARCHRES', () => {
    describe('capability', () => {
        for (const plugins of [['SEARCHRES'], ['SEARCHRES', 'ESEARCH'], ['ESEARCH', 'SEARCHRES']]) {
            describe('with ' + plugins.join(', '), () => {
                const ctx = setupServer(() => ({ plugins, storage: storage() }));

                // RFC 5182 section 2.1: a SEARCHRES server MUST also implement ESEARCH
                it('advertises SEARCHRES and ESEARCH', (t, done) => {
                    ctx.run([...LOGIN, 'A1 CAPABILITY', 'A2 SEARCH RETURN (SAVE COUNT) FLAGGED', 'A3 FETCH $ UID', 'ZZ LOGOUT'], resp => {
                        resp = resp.toString();
                        assert.ok(/^\* CAPABILITY .* ESEARCH(\r| )/m.test(resp), resp);
                        assert.ok(/^\* CAPABILITY .* SEARCHRES(\r| )/m.test(resp), resp);
                        assert.ok(/^\* ESEARCH \(TAG "A2"\) COUNT 3\r\nA2 OK /m.test(resp), resp);
                        assert.deepStrictEqual(fetched(resp, 'A3'), [2, 3, 5]);
                        done();
                    });
                });
            });
        }
    });

    describe('with SEARCHRES loaded', () => {
        const ctx = setupServer(() => ({
            plugins: ['SEARCHRES', 'UIDPLUS', 'MOVE', 'UNSELECT'],
            storage: storage()
        }));

        // RFC 5182 section 2.2, Example 1
        it('saves the result without a SEARCH response', (t, done) => {
            ctx.run([...LOGIN, 'A1 SEARCH RETURN (SAVE) FLAGGED', 'A2 FETCH $ (UID FLAGS)', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.ok(/^L2 OK .*\r\nA1 OK /m.test(resp), resp);
                assert.ok(!/SEARCH \d|ESEARCH/.test(resp), resp);
                assert.ok(
                    /^\* 2 FETCH \(UID 20 FLAGS \(\\Flagged\)\)\r\n\* 3 FETCH \(UID 21 FLAGS \(\\Flagged\)\)\r\n\* 5 FETCH \(UID 30 FLAGS \(\\Flagged\)\)\r\nA2 OK /m.test(
                        resp
                    ),
                    resp
                );
                done();
            });
        });

        // RFC 5182 section 2.4, Example 10
        const COMBINATIONS: [string, RegExp, number[]][] = [
            ['SAVE MIN', /^\* ESEARCH \(TAG "A1"\) MIN 2\r\n/m, [2]],
            ['SAVE MAX', /^\* ESEARCH \(TAG "A1"\) MAX 5\r\n/m, [5]],
            ['MAX SAVE MIN', /^\* ESEARCH \(TAG "A1"\) MIN 2 MAX 5\r\n/m, [2, 5]],
            ['ALL SAVE', /^\* ESEARCH \(TAG "A1"\) ALL 2:3,5\r\n/m, [2, 3, 5]],
            ['MAX SAVE MIN COUNT', /^\* ESEARCH \(TAG "A1"\) MIN 2 MAX 5 COUNT 3\r\n/m, [2, 3, 5]],
            ['ALL SAVE MIN', /^\* ESEARCH \(TAG "A1"\) MIN 2 ALL 2:3,5\r\n/m, [2, 3, 5]]
        ];
        for (const [options, response, saved] of COMBINATIONS) {
            it('saves ' + options, (t, done) => {
                ctx.run([...LOGIN, 'A1 SEARCH RETURN (' + options + ') FLAGGED', 'A2 FETCH $ UID', 'ZZ LOGOUT'], resp => {
                    resp = resp.toString();
                    assert.ok(response.test(resp), resp);
                    assert.deepStrictEqual(fetched(resp, 'A2'), saved, resp);
                    done();
                });
            });
        }

        it('saves the single message of MIN MAX once', (t, done) => {
            ctx.run([...LOGIN, 'A1 SEARCH RETURN (SAVE MIN MAX) SEEN', 'A2 FETCH $ UID', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.ok(/^\* ESEARCH \(TAG "A1"\) MIN 1 MAX 1\r\n/m.test(resp), resp);
                assert.deepStrictEqual(fetched(resp, 'A2'), [1], resp);
                done();
            });
        });

        // RFC 5182 section 2.1 implementation note: "$" holds messages, not numbers
        it('uses the same messages for UID and sequence number commands', (t, done) => {
            const cmds = [
                ...LOGIN,
                'A1 UID SEARCH RETURN (SAVE) FLAGGED',
                'A2 FETCH $ UID',
                'A3 UID FETCH $ UID',
                'A4 SEARCH $',
                'A5 UID SEARCH $',
                'ZZ LOGOUT'
            ];
            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.deepStrictEqual(fetched(resp, 'A2'), [2, 3, 5], resp);
                assert.deepStrictEqual(fetched(resp, 'A3'), [2, 3, 5], resp);
                assert.ok(/^\* SEARCH 2 3 5\r\nA4 OK /m.test(resp), resp);
                assert.ok(/^\* SEARCH 20 21 30\r\nA5 OK /m.test(resp), resp);
                done();
            });
        });

        // RFC 5182 section 2.2, Examples 3 and 4
        it('uses $ in search criteria', (t, done) => {
            const cmds = [
                ...LOGIN,
                'A1 SEARCH RETURN (SAVE) 2:4',
                'A2 UID SEARCH UID $ FLAGGED',
                'A3 UID SEARCH $ FLAGGED',
                'A4 SEARCH OR $ 1 UNFLAGGED',
                'A5 SEARCH NOT $',
                'ZZ LOGOUT'
            ];
            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(/^\* SEARCH 20 21\r\nA2 OK /m.test(resp), resp);
                assert.ok(/^\* SEARCH 20 21\r\nA3 OK /m.test(resp), resp);
                assert.ok(/^\* SEARCH 1 4\r\nA4 OK /m.test(resp), resp);
                assert.ok(/^\* SEARCH 1 5\r\nA5 OK /m.test(resp), resp);
                done();
            });
        });

        it('replaces $ with the result of a search that uses it', (t, done) => {
            ctx.run([...LOGIN, 'A1 SEARCH RETURN (SAVE) 2:4', 'A2 SEARCH RETURN (SAVE) $ FLAGGED', 'A3 FETCH $ UID', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.deepStrictEqual(fetched(resp, 'A3'), [2, 3], resp);
                done();
            });
        });

        it('uses $ with STORE, COPY, MOVE and UID EXPUNGE', (t, done) => {
            const cmds = [
                ...LOGIN,
                'A1 SEARCH RETURN (SAVE) FLAGGED',
                'A2 STORE $ +FLAGS (\\Seen)',
                'A3 UID STORE $ +FLAGS.SILENT (\\Answered)',
                'A4 COPY $ target',
                'A5 UID COPY $ target',
                'A6 SEARCH RETURN (SAVE) 2',
                'A7 UID MOVE $ target',
                'A8 SEARCH RETURN (SAVE) 2',
                'A9 MOVE $ target',
                'A10 SEARCH RETURN (SAVE) 1',
                'A11 STORE $ +FLAGS.SILENT (\\Deleted)',
                'A12 UID EXPUNGE $',
                'ZZ LOGOUT'
            ];
            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(
                    /^\* 2 FETCH \(FLAGS \(\\Flagged \\Seen\)\)\r\n\* 3 FETCH \(FLAGS \(\\Flagged \\Seen\)\)\r\n\* 5 FETCH \(FLAGS \(\\Flagged \\Seen\)\)\r\nA2 OK /m.test(
                        resp
                    ),
                    resp
                );
                assert.ok(/^A4 OK \[COPYUID \d+ 20,21,30 1,2,3\]/m.test(resp), resp);
                assert.ok(/^A5 OK \[COPYUID \d+ 20,21,30 4,5,6\]/m.test(resp), resp);
                assert.ok(/^\* OK \[COPYUID \d+ 20 7\] .*\r\n\* 2 EXPUNGE\r\nA7 OK /m.test(resp), resp);
                assert.ok(/^\* OK \[COPYUID \d+ 21 8\] .*\r\n\* 2 EXPUNGE\r\nA9 OK /m.test(resp), resp);
                assert.ok(/^\* 1 EXPUNGE\r\nA12 OK /m.test(resp), resp);
                assert.deepStrictEqual(
                    ctx.server.getMailbox('INBOX')!.messages.map(message => message.uid),
                    [22, 30]
                );
                assert.deepStrictEqual(
                    ctx.server.getMailbox('target')!.messages.map(message => message.flags.join(' ')),
                    Array(8).fill('\\Flagged \\Seen \\Answered')
                );
                done();
            });
        });

        // RFC 5182 section 2.1: an empty $ is a valid set that matches nothing, Example 6
        it('treats an empty $ as a valid set', (t, done) => {
            const cmds = [
                ...LOGIN,
                'A1 FETCH $ UID',
                'A2 COPY $ target',
                'A3 STORE $ +FLAGS (\\Seen)',
                'A4 SEARCH $',
                'A5 SEARCH RETURN (SAVE) DELETED',
                'A6 UID FETCH $ UID',
                'ZZ LOGOUT'
            ];
            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(/^L2 OK .*\r\nA1 OK /m.test(resp), resp);
                assert.ok(/^A1 OK .*\r\nA2 OK /m.test(resp), resp);
                assert.ok(!/COPYUID/.test(resp), resp);
                assert.ok(/^A2 OK .*\r\nA3 OK /m.test(resp), resp);
                assert.ok(/^\* SEARCH\r\nA4 OK /m.test(resp), resp);
                assert.ok(/^A5 OK .*\r\nA6 OK /m.test(resp), resp);
                done();
            });
        });

        // RFC 5182 section 2.1: the variable is reset on SELECT and EXAMINE
        it('resets $ when a mailbox is selected', (t, done) => {
            const cmds = [
                ...LOGIN,
                'A1 SEARCH RETURN (SAVE) FLAGGED',
                'A2 SELECT INBOX',
                'A3 FETCH $ UID',
                'A4 SEARCH RETURN (SAVE) FLAGGED',
                'A5 EXAMINE INBOX',
                'A6 FETCH $ UID',
                'A7 SEARCH RETURN (SAVE) FLAGGED',
                'A8 CLOSE',
                'A9 SELECT INBOX',
                'A10 FETCH $ UID',
                'A11 SEARCH RETURN (SAVE) FLAGGED',
                'A12 UNSELECT',
                'A13 SELECT INBOX',
                'A14 FETCH $ UID',
                'ZZ LOGOUT'
            ];
            ctx.run(cmds, resp => {
                resp = resp.toString();
                for (const tag of ['A3', 'A6', 'A10', 'A14']) {
                    assert.deepStrictEqual(fetched(resp, tag), [], tag + '\n' + resp);
                    assert.ok(new RegExp('^' + tag + ' OK ', 'm').test(resp), resp);
                }
                done();
            });
        });

        // RFC 5182 section 2.1, Example 5: SEARCH (SAVE) that fails with NO empties the variable
        it('empties $ when SEARCH RETURN (SAVE) fails with NO', (t, done) => {
            ctx.run([...LOGIN, 'A1 SEARCH RETURN (SAVE) FLAGGED', 'A2 SEARCH RETURN (SAVE) CHARSET KOI8-R ALL', 'A3 FETCH $ UID', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.ok(/^A2 NO \[BADCHARSET/m.test(resp), resp);
                assert.deepStrictEqual(fetched(resp, 'A3'), [], resp);
                done();
            });
        });

        // RFC 5182 section 2.1: these SEARCH commands MUST NOT change the variable
        const UNCHANGED = [
            ['a SEARCH that failed with BAD', 'SEARCH RETURN (SAVE) FOO', 'BAD'],
            ['a SEARCH with a bad result option', 'SEARCH RETURN (SAVE FOO) ALL', 'BAD'],
            ['a SEARCH without SAVE that failed with NO', 'SEARCH RETURN (ALL) CHARSET KOI8-R ALL', 'NO'],
            ['a successful SEARCH without SAVE', 'SEARCH RETURN (MIN) ALL', 'OK'],
            ['a successful plain SEARCH', 'SEARCH ALL', 'OK']
        ];
        for (const [description, command, result] of UNCHANGED) {
            it('keeps $ after ' + description, (t, done) => {
                ctx.run([...LOGIN, 'A1 SEARCH RETURN (SAVE) FLAGGED', 'A2 ' + command, 'A3 FETCH $ UID', 'ZZ LOGOUT'], resp => {
                    resp = resp.toString();
                    assert.ok(new RegExp('^A2 ' + result + ' ', 'm').test(resp), resp);
                    assert.deepStrictEqual(fetched(resp, 'A3'), [2, 3, 5], resp);
                    done();
                });
            });
        }

        // RFC 5182 section 2.1: an expunged message is removed from the variable
        it('removes expunged messages from $', (t, done) => {
            const cmds = [
                ...LOGIN,
                'A1 SEARCH RETURN (SAVE) FLAGGED',
                'A2 STORE 2 +FLAGS.SILENT (\\Deleted)',
                'A3 EXPUNGE',
                'A4 FETCH $ UID',
                'A5 UID SEARCH $',
                'ZZ LOGOUT'
            ];
            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(/^\* 2 EXPUNGE\r\n/m.test(resp), resp);
                assert.ok(/^\* 2 FETCH \(UID 21\)\r\n\* 4 FETCH \(UID 30\)\r\nA4 OK /m.test(resp), resp);
                assert.ok(/^\* SEARCH 21 30\r\nA5 OK /m.test(resp), resp);
                done();
            });
        });

        it('removes messages that another session expunged from $', (t, done) => {
            openSession(ctx.port, first => {
                openSession(ctx.port, second => {
                    first.run('A1 LOGIN testuser testpass', () =>
                        first.run('A2 SELECT INBOX', () =>
                            first.run('A3 SEARCH RETURN (SAVE) FLAGGED', () =>
                                second.run('B1 LOGIN testuser testpass', () =>
                                    second.run('B2 SELECT INBOX', () =>
                                        second.run('B3 STORE 3 +FLAGS.SILENT (\\Deleted)', () =>
                                            second.run('B4 EXPUNGE', () =>
                                                first.run('A4 NOOP', resp => {
                                                    assert.ok(/^\* 3 EXPUNGE\r\n/m.test(resp), resp);
                                                    first.run('A5 FETCH $ UID', resp => {
                                                        first.close();
                                                        second.close();
                                                        assert.ok(/^\* 2 FETCH \(UID 20\)\r\n\* 4 FETCH \(UID 30\)\r\nA5 OK /m.test(resp), resp);
                                                        done();
                                                    });
                                                })
                                            )
                                        )
                                    )
                                )
                            )
                        )
                    );
                });
            });
        });

        // RFC 5182 section 2.3, Examples 2 and 7: "$" does not refer to sequence numbers, so it can be pipelined
        it('runs pipelined commands that use $ in order', (t, done) => {
            openSession(ctx.port, session => {
                session.run('S1 LOGIN testuser testpass', () => {
                    session.run('S2 SELECT INBOX', () => {
                        session.run(
                            [
                                'F282 SEARCH RETURN (SAVE) FLAGGED',
                                'F283 COPY $ target',
                                'F284 STORE $ +FLAGS.SILENT (\\Deleted)',
                                'F285 UID EXPUNGE $',
                                'F286 FETCH $ UID'
                            ].join('\r\n'),
                            resp => {
                                session.close();
                                for (const tag of ['F282', 'F283', 'F284', 'F285', 'F286']) {
                                    assert.ok(new RegExp('^' + tag + ' OK ', 'm').test(resp), resp);
                                }
                                assert.ok(/^F283 OK \[COPYUID \d+ 20,21,30 1,2,3\]/m.test(resp), resp);
                                assert.ok(/^\* 2 EXPUNGE\r\n\* 2 EXPUNGE\r\n\* 3 EXPUNGE\r\nF285 OK /m.test(resp), resp);
                                assert.deepStrictEqual(fetched(resp, 'F286'), [], resp);
                                done();
                            },
                            'F286'
                        );
                    });
                });
            });
        });

        it('still refuses pipelined sequence numbers', (t, done) => {
            openSession(ctx.port, session => {
                session.run('S1 LOGIN testuser testpass', () => {
                    session.run('S2 SELECT INBOX', () => {
                        session.run(
                            ['A1 SEARCH RETURN (SAVE) FLAGGED', 'A2 COPY $ target', 'A3 STORE 1 +FLAGS (\\Seen)', 'A4 SEARCH $ 1:2'].join('\r\n'),
                            resp => {
                                session.close();
                                assert.ok(/^A1 OK /m.test(resp), resp);
                                assert.ok(/^A2 OK /m.test(resp), resp);
                                assert.ok(/^A3 BAD /m.test(resp), resp);
                                assert.ok(/^A4 BAD /m.test(resp), resp);
                                done();
                            },
                            'A4'
                        );
                    });
                });
            });
        });

        // RFC 5182 section 3: "$" stands for a whole sequence set, Dovecot refuses it combined with numbers too
        const BAD = [
            ['$ combined with numbers', 'FETCH 1,$ UID'],
            ['$ at the start of a list', 'FETCH $,1 UID'],
            ['$ in a range', 'UID FETCH $:2 UID'],
            ['$ in a search list', 'SEARCH UID 1,$']
        ];
        for (const [description, command] of BAD) {
            it('refuses ' + description, (t, done) => {
                ctx.run([...LOGIN, 'A1 SEARCH RETURN (SAVE) ALL', 'A2 ' + command, 'ZZ LOGOUT'], resp => {
                    resp = resp.toString();
                    assert.ok(/^A2 BAD /m.test(resp), resp);
                    done();
                });
            });
        }

        it('refuses $ outside the selected state', (t, done) => {
            ctx.run(['A1 LOGIN testuser testpass', 'A2 FETCH $ UID', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.ok(/^A2 BAD /m.test(resp), resp);
                done();
            });
        });
    });

    describe('without SEARCHRES', () => {
        const ctx = setupServer(() => ({ plugins: ['ESEARCH'], storage: storage() }));

        it('refuses $ and SAVE', (t, done) => {
            ctx.run([...LOGIN, 'A1 FETCH $ UID', 'A2 SEARCH $', 'A3 SEARCH RETURN (SAVE) ALL', 'A4 UID SEARCH UID $', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                for (const tag of ['A1', 'A2', 'A3', 'A4']) {
                    assert.ok(new RegExp('^' + tag + ' BAD ', 'm').test(resp), resp);
                }
                done();
            });
        });
    });
});
