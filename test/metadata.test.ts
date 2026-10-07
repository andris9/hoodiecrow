// METADATA and METADATA-SERVER, RFC 5464 (https://www.rfc-editor.org/rfc/rfc5464.txt) with the
// verified errata 2785 and 2786 (GETMETADATA options come before the mailbox name), and the
// /private/specialuse entry of RFC 6154 section 4

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { setupServer, assertTagged } from './helpers/index.js';
import { openSession } from './helpers/session.js';
import type { Session } from './helpers/session.js';
import type { TestContext } from './helpers/index.js';

const LOGIN = 'L1 LOGIN testuser testpass';

const storage = () => ({
    INBOX: {
        metadata: {
            '/private/comment': 'My own comment',
            '/Shared/Comment': 'Shared comment'
        }
    },
    '': {
        separator: '/',
        folders: {
            Projects: {
                metadata: {
                    '/private/filters/values/small': 'SMALLER 5000',
                    '/private/filters/values/boss': 'FROM "boss@example.com"',
                    '/private/filters/values/boss/deep': 'deeper',
                    '/private/filters': 'top'
                },
                folders: {
                    Child: {}
                }
            },
            Sent: { 'special-use': '\\Sent' },
            Empty: {}
        }
    }
});

// Runs commands after login and returns the transcript
const run = (ctx: TestContext, commands: string[], callback: (resp: string) => void) => {
    ctx.run([LOGIN, ...commands, 'ZZ LOGOUT'], resp => callback(resp.toString('binary')));
};

describe('METADATA', () => {
    const serverMetadata = { '/shared/admin': 'mailto:admin@example.com', '/shared/comment': 'Server comment' };
    const ctx = setupServer(() => ({ plugins: ['METADATA', 'ENABLE'], metadata: serverMetadata, storage: storage() }));

    it('advertises METADATA (RFC 5464 section 1)', (t, done) => {
        ctx.run(['A1 CAPABILITY', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^\* CAPABILITY .* METADATA(?: |\r)/m);
            assert.doesNotMatch(resp, /METADATA-SERVER/);
            done();
        });
    });

    it('takes and returns binary values as literal8 (RFC 5464 section 5)', (t, done) => {
        run(
            ctx,
            [
                'A1 SETMETADATA INBOX (/private/blob ~{5}\r\na\x00\nb\r /private/text ~{2}\r\nhi)',
                'A2 GETMETADATA INBOX (/private/blob /private/text)',
                'A3 GETMETADATA ~{5}\r\nINBOX /private/blob'
            ],
            resp => {
                assert.match(resp, /^A1 OK /m);
                // only the value with NUL needs a literal8
                assert.ok(resp.includes('* METADATA INBOX (/private/blob ~{5}\r\na\x00\nb\r /private/text "hi")\r\nA2 OK'), resp);
                // literal8 is only valid for SETMETADATA values
                assert.match(resp, /^A3 BAD /m);
                done();
            }
        );
    });

    it('returns server annotations for the empty mailbox name (RFC 5464 section 4.2)', (t, done) => {
        run(ctx, ['A1 GETMETADATA "" /shared/comment', 'A2 GETMETADATA "" (/shared/admin /shared/missing)'], resp => {
            assert.match(resp, /^\* METADATA "" \(\/shared\/comment "Server comment"\)\r$/m);
            assert.match(resp, /^\* METADATA "" \(\/shared\/admin "mailto:admin@example\.com" \/shared\/missing NIL\)\r$/m);
            assertTagged(resp, { A1: 'OK', A2: 'OK' });
            done();
        });
    });

    it('returns mailbox annotations, entry names are case-insensitive (RFC 5464 section 3.2)', (t, done) => {
        run(ctx, ['A1 GETMETADATA "INBOX" (/shared/comment /PRIVATE/Comment)', 'A2 GETMETADATA inbox "/shared/comment"'], resp => {
            assert.match(resp, /^\* METADATA INBOX \(\/shared\/comment "Shared comment" \/private\/comment "My own comment"\)\r$/m);
            assert.match(resp, /^\* METADATA INBOX \(\/shared\/comment "Shared comment"\)\r$/m);
            assertTagged(resp, { A1: 'OK', A2: 'OK' });
            done();
        });
    });

    it('returns entries below the requested one with DEPTH (RFC 5464 section 4.2.2)', (t, done) => {
        run(
            ctx,
            [
                'A1 GETMETADATA (DEPTH 0) Projects /private/filters/values',
                'A2 GETMETADATA (DEPTH 1) Projects /private/filters/values',
                'A3 GETMETADATA (DEPTH infinity) Projects /private/filters',
                'A4 GETMETADATA (DEPTH INFINITY) Projects (/private /private/filters/values/boss)',
                'A5 GETMETADATA (DEPTH 1) Projects /shared'
            ],
            resp => {
                assert.match(resp, /^\* METADATA Projects \(\/private\/filters\/values NIL\)\r$/m);
                // the entry itself is only listed when it has a value, its children are sorted
                assert.match(
                    resp,
                    /^\* METADATA Projects \(\/private\/filters\/values\/boss "FROM \\"boss@example\.com\\"" \/private\/filters\/values\/small "SMALLER 5000"\)\r$/m
                );
                assert.match(
                    resp,
                    /^\* METADATA Projects \(\/private\/filters "top" \/private\/filters\/values\/boss "FROM \\"boss@example\.com\\"" \/private\/filters\/values\/boss\/deep "deeper" \/private\/filters\/values\/small "SMALLER 5000"\)\r$/m
                );
                // A4 lists every entry once, even though both specifiers match /private/filters/values/boss
                const a4 = resp.split('A3 OK')[1].split('A4 OK')[0];
                assert.strictEqual((a4.match(/\/private\/filters\/values\/boss /g) || []).length, 1, a4);
                // nothing below /shared, and DEPTH leaves out the missing entry itself
                const a5 = resp.split('A4 OK')[1].split('A5 OK')[0];
                assert.doesNotMatch(a5, /\* METADATA/);
                assertTagged(resp, { A1: 'OK', A2: 'OK', A3: 'OK', A4: 'OK', A5: 'OK' });
                done();
            }
        );
    });

    it('leaves out values larger than MAXSIZE and reports LONGENTRIES (RFC 5464 section 4.2.1)', (t, done) => {
        run(
            ctx,
            [
                'A1 GETMETADATA (MAXSIZE 13) INBOX (/shared/comment /private/comment /private/missing)',
                'A2 GETMETADATA (MAXSIZE 0) INBOX /shared/comment',
                'A3 GETMETADATA (MAXSIZE 1024 DEPTH 1) INBOX /shared',
                'A4 GETMETADATA (DEPTH infinity MAXSIZE 5) Projects /private'
            ],
            resp => {
                // NIL values are always returned
                assert.match(resp, /^\* METADATA INBOX \(\/private\/missing NIL\)\r$/m);
                assert.match(resp, /^A1 OK \[METADATA LONGENTRIES 14\] /m);
                // nothing left to return, so there is no METADATA response
                assert.match(resp, /A1 OK [^\r]*\r\nA2 OK \[METADATA LONGENTRIES 14\] /);
                assert.match(resp, /^\* METADATA INBOX \(\/shared\/comment "Shared comment"\)\r\nA3 OK GETMETADATA completed\r$/m);
                // the biggest value that was left out
                assert.match(resp, /^\* METADATA Projects \(\/private\/filters "top"\)\r\nA4 OK \[METADATA LONGENTRIES 23\] /m);
                done();
            }
        );
    });

    it('sets and removes annotations (RFC 5464 section 4.3)', (t, done) => {
        run(
            ctx,
            [
                'A1 SETMETADATA INBOX (/private/comment {33}\r\nMy new comment across\r\ntwo lines.)',
                'A2 GETMETADATA INBOX /private/comment',
                'A3 SETMETADATA INBOX (/private/comment NIL /shared/comment "This one is for you!" /shared/empty "" /shared/nil "NIL")',
                'A4 GETMETADATA INBOX (/private/comment /shared/comment /shared/empty /shared/nil)',
                'A5 SETMETADATA INBOX (/shared/missing NIL)'
            ],
            resp => {
                assert.match(resp, /^\* METADATA INBOX \(\/private\/comment \{33\}\r\nMy new comment across\r\ntwo lines\.\)\r$/m);
                assert.match(
                    resp,
                    /^\* METADATA INBOX \(\/private\/comment NIL \/shared\/comment "This one is for you!" \/shared\/empty "" \/shared\/nil "NIL"\)\r$/m
                );
                assertTagged(resp, { A1: 'OK', A3: 'OK', A5: 'OK' });
                // SETMETADATA does not send METADATA responses (RFC 5464 section 4.3 SHOULD NOT)
                assert.doesNotMatch(resp.split('A4 OK')[1], /METADATA INBOX/);
                done();
            }
        );
    });

    it('sets server annotations, /shared/admin is read-only (RFC 5464 section 3.2.1.1)', (t, done) => {
        run(
            ctx,
            [
                'A1 SETMETADATA "" (/shared/comment "New comment" /private/vendor/vendor.example/setting "on")',
                'A2 GETMETADATA (DEPTH infinity) "" (/shared /private)',
                'A3 SETMETADATA "" (/shared/admin "mailto:other@example.com")',
                'A4 SETMETADATA "" (/shared/admin NIL)',
                'A5 GETMETADATA "" /shared/admin'
            ],
            resp => {
                assert.match(
                    resp,
                    /^\* METADATA "" \(\/shared\/admin "mailto:admin@example\.com" \/shared\/comment "New comment" \/private\/vendor\/vendor\.example\/setting "on"\)\r$/m
                );
                assert.match(resp, /^A3 NO \[CANNOT\] /m);
                assert.match(resp, /^A4 NO \[CANNOT\] /m);
                assert.match(resp, /^\* METADATA "" \(\/shared\/admin "mailto:admin@example\.com"\)\r$/m);
                done();
            }
        );
    });

    it('refuses annotations of a mailbox that does not exist (RFC 5464 section 3.3)', (t, done) => {
        run(
            ctx,
            ['A1 GETMETADATA Missing /shared/comment', 'A2 SETMETADATA Missing (/shared/comment "x")', 'A3 GETMETADATA Projects/Child /shared/comment'],
            resp => {
                assert.match(resp, /^A1 NO \[NONEXISTENT\] /m);
                assert.match(resp, /^A2 NO \[NONEXISTENT\] /m);
                assertTagged(resp, { A3: 'OK' });
                done();
            }
        );
    });

    it('allows annotations on \\Noselect mailboxes (RFC 5464 section 4.1)', (t, done) => {
        run(
            ctx,
            [
                'A1 CREATE Parent/Child',
                'A2 DELETE Parent',
                'A3 CREATE Parent',
                'A4 SETMETADATA Parent (/shared/comment "parent")',
                'A5 DELETE Parent',
                'A6 LIST "" Parent',
                'A7 SETMETADATA Parent (/shared/comment "placeholder")',
                'A8 GETMETADATA Parent /shared/comment'
            ],
            resp => {
                assert.match(resp, /^\* LIST \([^)]*\\Noselect[^)]*\) "\/" "?Parent"?\r$/m);
                assert.match(resp, /^\* METADATA Parent \(\/shared\/comment "placeholder"\)\r$/m);
                assertTagged(resp, { A4: 'OK', A5: 'OK', A7: 'OK', A8: 'OK' });
                done();
            }
        );
    });

    it('moves annotations with RENAME (RFC 5464 section 4.1)', (t, done) => {
        run(
            ctx,
            [
                'A1 RENAME Projects Work',
                'A2 GETMETADATA Work /private/filters',
                'A3 GETMETADATA Work/Child /private/filters',
                'A4 CREATE Projects',
                'A5 GETMETADATA Projects /private/filters'
            ],
            resp => {
                assert.match(resp, /^\* METADATA Work \(\/private\/filters "top"\)\r$/m);
                assert.match(resp, /^\* METADATA Work\/Child \(\/private\/filters NIL\)\r$/m);
                assert.match(resp, /^\* METADATA Projects \(\/private\/filters NIL\)\r$/m);
                done();
            }
        );
    });

    it('copies the annotations of INBOX on RENAME, INBOX keeps them (RFC 5464 section 4.1)', (t, done) => {
        run(
            ctx,
            [
                'A1 RENAME INBOX Old',
                'A2 GETMETADATA Old (/private/comment /shared/comment)',
                'A3 SETMETADATA Old (/private/comment NIL)',
                'A4 GETMETADATA INBOX /private/comment'
            ],
            resp => {
                assert.match(resp, /^\* METADATA Old \(\/private\/comment "My own comment" \/shared\/comment "Shared comment"\)\r$/m);
                // the copy is independent of the INBOX annotations
                assert.match(resp, /^\* METADATA INBOX \(\/private\/comment "My own comment"\)\r$/m);
                assertTagged(resp, { A1: 'OK', A3: 'OK' });
                done();
            }
        );
    });

    it('removes annotations with DELETE (RFC 5464 section 4.1)', (t, done) => {
        run(
            ctx,
            [
                'A1 SETMETADATA Empty (/shared/comment "gone soon")',
                'A2 DELETE Empty',
                'A3 CREATE Empty',
                'A4 GETMETADATA Empty /shared/comment',
                'A5 DELETE Projects',
                'A6 GETMETADATA (DEPTH infinity) Projects /private'
            ],
            resp => {
                assert.match(resp, /^\* METADATA Empty \(\/shared\/comment NIL\)\r$/m);
                // Projects stays as a \Noselect placeholder for its child, without the annotations
                assert.doesNotMatch(resp.split('A5 OK')[1], /METADATA Projects/);
                assertTagged(resp, { A5: 'OK', A6: 'OK' });
                done();
            }
        );
    });

    it('keeps the caller objects unchanged', (t, done) => {
        run(ctx, ['A1 SETMETADATA "" (/shared/comment "changed")', 'A2 SETMETADATA INBOX (/shared/comment "changed")'], resp => {
            assertTagged(resp, { A1: 'OK', A2: 'OK' });
            assert.strictEqual(serverMetadata['/shared/comment'], 'Server comment');
            assert.strictEqual(ctx.server.getMailbox('INBOX')!.metadata['/shared/comment'], 'changed');
            done();
        });
    });

    it('accepts SETMETADATA with an empty mailbox name argument as a literal', (t, done) => {
        run(ctx, ['A1 SETMETADATA {0}\r\n (/shared/comment "x")', 'A2 GETMETADATA {0}\r\n /shared/comment'], resp => {
            assert.match(resp, /^\* METADATA "" \(\/shared\/comment "x"\)\r$/m);
            done();
        });
    });
});

describe('METADATA atomic changes', () => {
    // the table driven syntax checks are in conformance.test.ts
    const ctx = setupServer(() => ({ plugins: ['METADATA'], storage: storage() }));

    it('changes nothing when one entry is invalid (RFC 5464 section 4.3)', (t, done) => {
        run(ctx, ['A1 SETMETADATA INBOX (/shared/comment "changed" /shared//x "y")', 'A2 GETMETADATA INBOX /shared/comment'], resp => {
            assertTagged(resp, { A1: 'BAD', A2: 'OK' });
            assert.match(resp, /^\* METADATA INBOX \(\/shared\/comment "Shared comment"\)\r$/m);
            done();
        });
    });
});

describe('METADATA limits', () => {
    const ctx = setupServer(() => ({
        plugins: ['METADATA'],
        metadataMaxSize: 10,
        metadataMaxEntries: 3,
        metadataPrivate: false,
        storage: storage()
    }));

    it('refuses values larger than the limit with [METADATA MAXSIZE] (RFC 5464 section 4.3)', (t, done) => {
        run(
            ctx,
            ['A1 SETMETADATA Empty (/shared/a "0123456789")', 'A2 SETMETADATA Empty (/shared/b "x" /shared/c "0123456789A")', 'A3 GETMETADATA Empty /shared/b'],
            resp => {
                assertTagged(resp, { A1: 'OK' });
                assert.match(resp, /^A2 NO \[METADATA MAXSIZE 10\] /m);
                // nothing is changed when one entry fails
                assert.match(resp, /^\* METADATA Empty \(\/shared\/b NIL\)\r$/m);
                done();
            }
        );
    });

    it('refuses new entries over the limit with [METADATA TOOMANY] (RFC 5464 section 4.3)', (t, done) => {
        run(
            ctx,
            [
                'A1 SETMETADATA Empty (/shared/a "1" /shared/b "2" /shared/c "3")',
                'A2 SETMETADATA Empty (/shared/d "4")',
                'A3 SETMETADATA Empty (/shared/a "changed")',
                'A4 SETMETADATA Empty (/shared/a NIL /shared/d "4")',
                'A5 SETMETADATA Empty (/shared/a "1" /shared/e "5")',
                'A6 SETMETADATA "" (/shared/a "1" /shared/b "2" /shared/c "3" /shared/d "4")'
            ],
            resp => {
                assertTagged(resp, { A1: 'OK', A3: 'OK', A4: 'OK' });
                assert.match(resp, /^A2 NO \[METADATA TOOMANY\] /m);
                assert.match(resp, /^A5 NO \[METADATA TOOMANY\] /m);
                // the server has the same limit
                assert.match(resp, /^A6 NO \[METADATA TOOMANY\] /m);
                done();
            }
        );
    });

    it('refuses private entries with [METADATA NOPRIVATE] (RFC 5464 section 4.3)', (t, done) => {
        run(ctx, ['A1 SETMETADATA INBOX (/shared/x "1" /private/comment "x")', 'A2 GETMETADATA INBOX (/shared/x /private/comment)'], resp => {
            assert.match(resp, /^A1 NO \[METADATA NOPRIVATE\] /m);
            // values from storage can still be read
            assert.match(resp, /^\* METADATA INBOX \(\/shared\/x NIL \/private\/comment "My own comment"\)\r$/m);
            done();
        });
    });
});

describe('METADATA storage values', () => {
    const ctx = setupServer(() => ({
        plugins: ['METADATA'],
        storage: Object.assign(storage(), {
            'Other.': {
                separator: '.',
                folders: {
                    Uni: { metadata: { '/shared/comment': 'caf\u00e9 \u2603', '/shared/buffer': Buffer.from('abc'), '/shared/none': null } },
                    Bin: { metadata: { '/shared/comment': 'a\x00b' } },
                    Num: { metadata: { '/shared/comment': 5 } },
                    Bad: { metadata: { '/comment': 'x' } }
                }
            }
        })
    }));

    it('sends 8-bit values as literals, unicode strings are UTF-8', (t, done) => {
        run(ctx, ['A1 GETMETADATA Other.Uni (/shared/comment /shared/buffer /shared/none)'], resp => {
            assert.match(resp, /^\* METADATA Other\.Uni \(\/shared\/comment \{9\}\r\ncaf\xc3\xa9 \xe2\x98\x83 \/shared\/buffer "abc" \/shared\/none NIL\)\r$/m);
            done();
        });
    });

    it('sends values with NUL as a literal8 (RFC 5464 section 5)', (t, done) => {
        run(ctx, ['A1 GETMETADATA Other.Bin /shared/comment'], resp => {
            assert.ok(resp.includes('* METADATA Other.Bin (/shared/comment ~{3}\r\na\x00b)\r\nA1 OK'), resp);
            done();
        });
    });

    it('fails on values that are not strings', (t, done) => {
        run(ctx, ['A1 GETMETADATA Other.Num /shared/comment'], resp => {
            assert.match(resp, /^A1 NO \[SERVERBUG\] .*expecting a string/m);
            done();
        });
    });

    it('fails on invalid entry names in storage', (t, done) => {
        run(ctx, ['A1 GETMETADATA Other.Bad /shared/comment'], resp => {
            assert.match(resp, /^A1 NO \[SERVERBUG\] .*Invalid metadata entry name/m);
            done();
        });
    });
});

describe('METADATA and SPECIAL-USE', () => {
    const ctx = setupServer(() => ({ plugins: ['METADATA', 'SPECIAL-USE', 'CREATE-SPECIAL-USE'], storage: storage() }));

    it('ties /private/specialuse to the special-use attributes (RFC 6154 section 4)', (t, done) => {
        run(
            ctx,
            [
                'A1 GETMETADATA Sent /private/specialuse',
                'A2 GETMETADATA Empty /private/specialuse',
                'A3 CREATE Junk (USE (\\Junk))',
                'A4 GETMETADATA (DEPTH infinity) Junk /private',
                'A5 SETMETADATA Empty (/private/specialuse "\\\\Sent")',
                'A6 SETMETADATA Sent (/private/specialuse NIL)',
                'A7 GETMETADATA Sent /private/specialuse'
            ],
            resp => {
                assert.match(resp, /^\* METADATA Sent \(\/private\/specialuse "\\\\Sent"\)\r$/m);
                assert.match(resp, /^\* METADATA Empty \(\/private\/specialuse NIL\)\r$/m);
                assert.match(resp, /^\* METADATA Junk \(\/private\/specialuse "\\\\Junk"\)\r$/m);
                // RFC 6154 section 4 MAY allow changes through METADATA, ImapKit keeps them read-only
                assert.match(resp, /^A5 NO \[CANNOT\] /m);
                assert.match(resp, /^A6 NO \[CANNOT\] /m);
                assert.match(resp, /^\* METADATA Sent \(\/private\/specialuse "\\\\Sent"\)\r\nA7 OK/m);
                done();
            }
        );
    });
});

describe('METADATA without SPECIAL-USE', () => {
    const ctx = setupServer(() => ({ plugins: ['METADATA'], storage: storage() }));

    it('treats /private/specialuse as a normal entry', (t, done) => {
        run(ctx, ['A1 GETMETADATA Sent /private/specialuse', 'A2 SETMETADATA Sent (/private/specialuse "x")'], resp => {
            assert.match(resp, /^\* METADATA Sent \(\/private\/specialuse NIL\)\r$/m);
            assertTagged(resp, { A2: 'OK' });
            done();
        });
    });
});

describe('METADATA-SERVER', () => {
    const ctx = setupServer(() => ({ plugins: ['METADATA-SERVER', 'ENABLE'], storage: storage() }));

    it('advertises METADATA-SERVER and only allows server annotations (RFC 5464 section 1)', (t, done) => {
        run(
            ctx,
            [
                'A1 CAPABILITY',
                'A2 SETMETADATA "" (/shared/comment "x")',
                'A3 GETMETADATA "" /shared/comment',
                'A4 GETMETADATA INBOX /private/comment',
                'A5 SETMETADATA INBOX (/private/comment "x")',
                'A6 ENABLE METADATA METADATA-SERVER'
            ],
            resp => {
                const capability = resp.match(/^\* CAPABILITY .*$/m)![0];
                assert.match(capability, / METADATA-SERVER(?: |\r)/);
                assert.doesNotMatch(capability, / METADATA(?: |\r)/);
                assert.match(resp, /^\* METADATA "" \(\/shared\/comment "x"\)\r$/m);
                assert.match(resp, /^A4 NO /m);
                assert.match(resp, /^A5 NO /m);
                assert.match(resp, /^\* ENABLED METADATA-SERVER\r$/m);
                done();
            }
        );
    });
});

describe('METADATA and METADATA-SERVER together', () => {
    const ctx = setupServer(() => ({ plugins: ['METADATA-SERVER', 'METADATA', 'ENABLE'] }));

    it('advertises only METADATA (RFC 5464 section 1)', (t, done) => {
        run(ctx, ['A1 CAPABILITY', 'A2 ENABLE METADATA-SERVER METADATA', 'A3 SETMETADATA INBOX (/private/comment "x")'], resp => {
            assert.match(resp, /^\* CAPABILITY .* METADATA(?: |\r)/m);
            assert.doesNotMatch(resp, /METADATA-SERVER/);
            assert.match(resp, /^\* ENABLED METADATA\r$/m);
            assertTagged(resp, { A3: 'OK' });
            done();
        });
    });
});

describe('Unsolicited METADATA responses', () => {
    const ctx = setupServer(() => ({ plugins: ['METADATA', 'ENABLE', 'IDLE'], storage: storage() }));

    // Opens a logged in session, `enable` runs ENABLE METADATA
    const login = (enable: boolean, callback: (session: Session) => void) => {
        openSession(ctx.port, session => {
            session.run('S1 LOGIN testuser testpass', () => {
                if (!enable) {
                    return callback(session);
                }
                session.run('S2 ENABLE METADATA', resp => {
                    assert.match(resp, /^\* ENABLED METADATA\r$/m);
                    callback(session);
                });
            });
        });
    };

    it('lists the changed entries without values after ENABLE METADATA (RFC 5464 section 4.4)', (t, done) => {
        login(true, watcher => {
            login(false, other => {
                login(true, writer => {
                    writer.run('W1 SETMETADATA INBOX (/shared/comment "changed" /private/comment "My own comment" /private/new "x")', resp => {
                        // the session that made the change gets no METADATA response
                        assert.doesNotMatch(resp, /METADATA INBOX/);
                        writer.run('W2 SETMETADATA "" (/shared/comment "server")', () => {
                            other.run('B1 NOOP', resp => {
                                // only sessions that enabled METADATA get these responses
                                assert.doesNotMatch(resp, /METADATA/);
                                watcher.run('A1 NOOP', resp => {
                                    // /private/comment kept its value, so it did not change
                                    assert.match(resp, /^\* METADATA INBOX \/shared\/comment \/private\/new\r\n\* METADATA "" \/shared\/comment\r\nA1 OK/m);
                                    writer.close();
                                    other.close();
                                    watcher.close();
                                    done();
                                });
                            });
                        });
                    });
                });
            });
        });
    });

    it('sends the responses right away while IDLE', (t, done) => {
        login(true, watcher => {
            login(false, writer => {
                watcher.run(
                    'A1 IDLE',
                    resp => {
                        assert.match(resp, /^\+ /m);
                        writer.run('W1 SETMETADATA Sent (/shared/comment "x")', () => {
                            watcher.run(
                                'DONE',
                                resp => {
                                    assert.match(resp, /^\* METADATA Sent \/shared\/comment\r\nA1 OK/m);
                                    writer.close();
                                    watcher.close();
                                    done();
                                },
                                'A1'
                            );
                        });
                    },
                    '+'
                );
            });
        });
    });
});
