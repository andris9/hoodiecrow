'use strict';

// ACL extension, RFC 4314 (https://www.rfc-editor.org/rfc/rfc4314.txt). The owner ("testuser" by
// default) has all rights, other users get rights from the ACL of each mailbox.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');
const { openSession } = require('./helpers/session');

const OWNER = 'L1 LOGIN testuser testpass';
const BOB = 'L1 LOGIN bob bobpass';

const message = n => 'From: sender@example.com\r\nSubject: message ' + n + '\r\n\r\nBody ' + n + '\r\n';

function users() {
    return {
        testuser: { password: 'testpass' },
        bob: { password: 'bobpass' },
        eve: { password: 'evepass' }
    };
}

function storage() {
    return {
        INBOX: {
            acl: { bob: 'lrs' },
            messages: [
                { raw: message(1), uid: 1, flags: ['\\Flagged'] },
                { raw: message(2), uid: 2, flags: ['\\Deleted', '\\Seen'] }
            ]
        },
        '': {
            separator: '/',
            folders: {
                Shared: {
                    acl: { bob: 'lrswikte', anyone: 'l' },
                    messages: [{ raw: message(3), uid: 1, flags: ['\\Seen', '\\Answered'] }],
                    folders: {
                        Sub: { acl: { bob: 'lr' } }
                    }
                },
                Parent: {
                    acl: { bob: 'l' },
                    folders: {
                        Child: {}
                    }
                },
                ReadOnly: { acl: { bob: 'lr' }, messages: [{ raw: message(4), uid: 1 }] },
                NoSeen: { acl: { bob: 'lrw' }, messages: [{ raw: message(5), uid: 1 }] },
                Hidden: { acl: { bob: 'r' }, messages: [{ raw: message(6), uid: 1 }] },
                Lookup: { acl: { bob: 'l' } },
                Insert: { acl: { bob: 'lri' } },
                Deletable: { acl: { bob: 'lrx' } },
                Admin: { acl: { bob: 'la' } },
                Neg: { acl: { anyone: 'lr', '-bob': 'r' } },
                Secret: { messages: [{ raw: message(7), uid: 1 }] }
            }
        }
    };
}

// tagged result of a command, e.g. "OK", "NO [NOPERM]"
const tagged = (resp, tag) => {
    const match = resp.match(new RegExp('^' + tag + ' (OK|NO|BAD)(?: (\\[[^\\]]+\\]))?', 'm'));
    assert.ok(match, 'no tagged response for ' + tag + '\n' + resp);
    return match[1] + (match[2] && match[1] !== 'OK' ? ' ' + match[2] : '');
};

describe('ACL', () => {
    const ctx = setupServer(() => ({ plugins: ['ACL', 'MOVE', 'UIDPLUS'], users: users(), storage: storage() }));

    const run = (commands, callback) => ctx.run(commands.concat('ZZ LOGOUT'), resp => callback(resp.toString('binary')));

    describe('commands (RFC 4314 section 3)', () => {
        it('advertises ACL and RIGHTS=texk (section 5.1.1)', (t, done) => {
            run(['A1 CAPABILITY'], resp => {
                assert.match(resp, /^\* CAPABILITY .*\bACL\b.* RIGHTS=texk\b/m);
                done();
            });
        });

        it('MYRIGHTS gives the owner every right, with the virtual c and d rights (section 2.1.1)', (t, done) => {
            run([OWNER, 'A1 MYRIGHTS INBOX', 'A2 MYRIGHTS shared'], resp => {
                assert.match(resp, /^\* MYRIGHTS INBOX lrswipkxteacd\r$/m);
                assert.match(resp, /^A1 OK /m);
                // mailbox names other than INBOX are case-sensitive
                assert.strictEqual(tagged(resp, 'A2'), 'NO [NONEXISTENT]');
                done();
            });
        });

        it('GETACL lists the owner and the entries from storage (sections 3.3 and 3.6)', (t, done) => {
            run([OWNER, 'A1 GETACL Shared', 'A2 GETACL inbox', 'A3 GETACL Secret'], resp => {
                assert.match(resp, /^\* ACL Shared testuser lrswipkxteacd bob lrswiktecd anyone l\r$/m);
                assert.match(resp, /^\* ACL INBOX testuser lrswipkxteacd bob lrs\r$/m);
                assert.match(resp, /^\* ACL Secret testuser lrswipkxteacd\r$/m);
                assert.match(resp, /^A3 OK /m);
                done();
            });
        });

        it('LISTRIGHTS returns the identifier as given (sections 3.4 and 3.7)', (t, done) => {
            run([OWNER, 'A1 LISTRIGHTS INBOX anyone', 'A2 LISTRIGHTS INBOX "Bob"', 'A3 LISTRIGHTS INBOX testuser'], resp => {
                assert.match(resp, /^\* LISTRIGHTS INBOX anyone "" l r s w i p k x t e a c d\r$/m);
                assert.match(resp, /^\* LISTRIGHTS INBOX Bob "" l r s w i p k x t e a c d\r$/m);
                // the owner is always granted everything
                assert.match(resp, /^\* LISTRIGHTS INBOX testuser lrswipkxteacd\r$/m);
                assert.match(resp, /^A3 OK /m);
                done();
            });
        });

        it('SETACL replaces, adds and removes rights (section 3.1)', (t, done) => {
            run(
                [
                    OWNER,
                    'A1 SETACL Lookup eve lrd',
                    'A2 GETACL Lookup',
                    'A3 SETACL Lookup eve +ck',
                    'A4 GETACL Lookup',
                    'A5 SETACL Lookup eve -xd',
                    'A6 GETACL Lookup',
                    'A7 SETACL Lookup eve ""',
                    'A8 GETACL Lookup'
                ],
                resp => {
                    // "d" expands to "et", and is returned when any of them is set
                    assert.match(resp, /^A1 OK /m);
                    assert.match(resp, /^\* ACL Lookup testuser lrswipkxteacd bob l eve lrted\r\nA2 OK/m);
                    // "c" expands to "kx"
                    assert.match(resp, /^\* ACL Lookup testuser lrswipkxteacd bob l eve lrkxtecd\r\nA4 OK/m);
                    assert.match(resp, /^\* ACL Lookup testuser lrswipkxteacd bob l eve lrkc\r\nA6 OK/m);
                    // an empty set of rights removes the entry
                    assert.match(resp, /^\* ACL Lookup testuser lrswipkxteacd bob l\r\nA8 OK/m);
                    done();
                }
            );
        });

        it('DELETEACL removes an entry, but not the negative rights (section 3.2)', (t, done) => {
            run([OWNER, 'A1 SETACL Lookup -bob l', 'A2 DELETEACL Lookup bob', 'A3 GETACL Lookup', 'A4 DELETEACL Lookup nobody'], resp => {
                assert.match(resp, /^\* ACL Lookup testuser lrswipkxteacd -bob l\r$/m);
                assert.match(resp, /^A4 OK /m);
                done();
            });
        });

        it('refuses unknown rights with BAD (section 3.1)', (t, done) => {
            run([OWNER, 'A1 SETACL INBOX bob lrQ', 'A2 SETACL INBOX bob lrq', 'A3 SETACL INBOX bob +l1', 'A4 GETACL INBOX'], resp => {
                assert.match(resp, /^A1 BAD Uppercase rights are not allowed/m);
                assert.match(resp, /^A2 BAD The q right is not supported/m);
                assert.match(resp, /^A3 BAD /m);
                // nothing was changed
                assert.match(resp, /^\* ACL INBOX testuser lrswipkxteacd bob lrs\r$/m);
                done();
            });
        });

        it('refuses identifiers that can not be prepared with BAD (section 3)', (t, done) => {
            run(
                [
                    OWNER,
                    'A1 SETACL INBOX "" lr',
                    'A2 SETACL INBOX - lr',
                    'A3 DELETEACL INBOX {3}\r\na\x01b',
                    'A4 LISTRIGHTS INBOX {2}\r\n\xff\xfe',
                    'A5 LISTRIGHTS INBOX {2}\r\n\xc3\xa9'
                ],
                resp => {
                    assert.strictEqual(tagged(resp, 'A1'), 'BAD');
                    assert.strictEqual(tagged(resp, 'A2'), 'BAD');
                    assert.strictEqual(tagged(resp, 'A3'), 'BAD');
                    assert.strictEqual(tagged(resp, 'A4'), 'BAD');
                    // identifiers are UTF-8, sent back as a literal
                    assert.match(resp, /^\* LISTRIGHTS INBOX \{2\}\r\n\xc3\xa9 "" l r/m);
                    done();
                }
            );
        });

        it('checks the arguments', (t, done) => {
            run(
                [
                    OWNER,
                    'A1 GETACL',
                    'A2 GETACL INBOX extra',
                    'A3 MYRIGHTS (INBOX)',
                    'A4 SETACL INBOX bob',
                    'A5 DELETEACL INBOX',
                    'A6 LISTRIGHTS INBOX',
                    'A7 SETACL INBOX bob (lr)',
                    'A8 GETACL "&Jjo"'
                ],
                resp => {
                    ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'].forEach(tag => assert.strictEqual(tagged(resp, tag), 'BAD', tag));
                    done();
                }
            );
        });

        it('needs the authenticated state', (t, done) => {
            run(['A1 MYRIGHTS INBOX', 'A2 GETACL INBOX'], resp => {
                assert.strictEqual(tagged(resp, 'A1'), 'BAD');
                assert.strictEqual(tagged(resp, 'A2'), 'BAD');
                done();
            });
        });

        it('answers NONEXISTENT for unknown mailboxes', (t, done) => {
            run([OWNER, 'A1 GETACL Nope', 'A2 SETACL Nope bob l', 'A3 MYRIGHTS Nope', 'A4 LISTRIGHTS Nope bob', 'A5 DELETEACL Nope bob'], resp => {
                ['A1', 'A2', 'A3', 'A4', 'A5'].forEach(tag => assert.strictEqual(tagged(resp, tag), 'NO [NONEXISTENT]', tag));
                done();
            });
        });

        it('does not change the rights of the owner (section 2)', (t, done) => {
            run([OWNER, 'A1 SETACL INBOX testuser lr', 'A2 SETACL INBOX -testuser r', 'A3 DELETEACL INBOX testuser', 'A4 MYRIGHTS INBOX'], resp => {
                assert.strictEqual(tagged(resp, 'A1'), 'NO [CANNOT]');
                assert.strictEqual(tagged(resp, 'A2'), 'NO [CANNOT]');
                assert.strictEqual(tagged(resp, 'A3'), 'NO [CANNOT]');
                assert.match(resp, /^\* MYRIGHTS INBOX lrswipkxteacd\r$/m);
                done();
            });
        });
    });

    describe('enforcement for other users (RFC 4314 section 4)', () => {
        it('reports the rights of the user with MYRIGHTS, negative rights included (section 2)', (t, done) => {
            run([BOB, 'A1 MYRIGHTS Shared', 'A2 MYRIGHTS INBOX', 'A3 MYRIGHTS Neg', 'A4 MYRIGHTS Hidden', 'A5 MYRIGHTS Secret'], resp => {
                assert.match(resp, /^\* MYRIGHTS Shared lrswiktecd\r$/m);
                assert.match(resp, /^\* MYRIGHTS INBOX lrs\r$/m);
                assert.match(resp, /^\* MYRIGHTS Neg l\r$/m);
                assert.match(resp, /^\* MYRIGHTS Hidden r\r$/m);
                // without any rights the mailbox does not exist for the user (section 6)
                assert.strictEqual(tagged(resp, 'A5'), 'NO [NONEXISTENT]');
                done();
            });
        });

        it('needs "a" for GETACL, SETACL, DELETEACL and LISTRIGHTS, without disclosing hidden mailboxes (section 6)', (t, done) => {
            run(
                [
                    BOB,
                    'A1 GETACL Shared',
                    'A2 GETACL Secret',
                    'A3 GETACL Hidden',
                    'A4 SETACL Shared bob lrswiktea',
                    'A5 DELETEACL Shared bob',
                    'A6 LISTRIGHTS Shared bob',
                    'A7 GETACL Admin',
                    'A8 SETACL Admin eve lr',
                    'A9 LISTRIGHTS Admin eve',
                    'B1 GETACL Admin'
                ],
                resp => {
                    assert.strictEqual(tagged(resp, 'A1'), 'NO [NOPERM]');
                    assert.strictEqual(tagged(resp, 'A2'), 'NO [NONEXISTENT]');
                    assert.strictEqual(tagged(resp, 'A3'), 'NO [NONEXISTENT]');
                    assert.strictEqual(tagged(resp, 'A4'), 'NO [NOPERM]');
                    assert.strictEqual(tagged(resp, 'A5'), 'NO [NOPERM]');
                    assert.strictEqual(tagged(resp, 'A6'), 'NO [NOPERM]');
                    assert.match(resp, /^\* ACL Admin testuser lrswipkxteacd bob la\r\nA7 OK/m);
                    assert.match(resp, /^A8 OK /m);
                    assert.match(resp, /^\* LISTRIGHTS Admin eve "" l r s w i p k x t e a c d\r$/m);
                    assert.match(resp, /^\* ACL Admin testuser lrswipkxteacd bob la eve lr\r$/m);
                    done();
                }
            );
        });

        it('lists only mailboxes with "l", and never answers NO for them', (t, done) => {
            run([BOB, 'A1 LIST "" "*"', 'A2 LSUB "" "*"', 'A3 LIST "" Secret'], resp => {
                const listed = [...resp.matchAll(/^\* LIST \(([^)]*)\) "\/" "?([^"\r]+)"?\r$/gm)].map(m => m[2]);
                assert.deepStrictEqual(listed.sort(), [
                    'Admin',
                    'Deletable',
                    'INBOX',
                    'Insert',
                    'Lookup',
                    'Neg',
                    'NoSeen',
                    'Parent',
                    'ReadOnly',
                    'Shared',
                    'Shared/Sub'
                ]);
                const lsub = [...resp.matchAll(/^\* LSUB \([^)]*\) "\/" "?([^"\r]+)"?\r$/gm)].map(m => m[1]);
                assert.deepStrictEqual(lsub.sort(), listed.sort());
                assert.match(resp, /^\* LIST \(\\HasChildren\) "\/" "?Shared"?\r$/m);
                // the only child of Parent is hidden, so Parent has no children for this user (RFC 3348)
                assert.match(resp, /^\* LIST \(\\HasNoChildren\) "\/" "?Parent"?\r$/m);
                assert.match(resp, /^A3 OK /m);
                done();
            });
        });

        it('needs "r" for SELECT, EXAMINE and STATUS (section 4)', (t, done) => {
            run(
                [
                    BOB,
                    'A1 SELECT Secret',
                    'A2 SELECT Lookup',
                    'A3 EXAMINE Lookup',
                    'A4 STATUS Lookup (MESSAGES)',
                    'A5 STATUS Secret (MESSAGES)',
                    'A6 STATUS Hidden (MESSAGES)',
                    'A7 SELECT Neg',
                    'A8 EXAMINE ReadOnly',
                    'A9 SELECT Secret',
                    'B1 FETCH 1 FLAGS'
                ],
                resp => {
                    assert.strictEqual(tagged(resp, 'A1'), 'NO [NONEXISTENT]');
                    assert.strictEqual(tagged(resp, 'A2'), 'NO [NOPERM]');
                    assert.strictEqual(tagged(resp, 'A3'), 'NO [NOPERM]');
                    assert.strictEqual(tagged(resp, 'A4'), 'NO [NOPERM]');
                    assert.strictEqual(tagged(resp, 'A5'), 'NO [NONEXISTENT]');
                    assert.match(resp, /^\* STATUS "?Hidden"? \(MESSAGES 1\)\r$/m);
                    assert.strictEqual(tagged(resp, 'A7'), 'NO [NOPERM]');
                    assert.match(resp, /^A8 OK \[READ-ONLY\]/m);
                    // a failed SELECT leaves no mailbox selected (RFC 3501 section 6.3.1)
                    assert.strictEqual(tagged(resp, 'B1'), 'BAD');
                    done();
                }
            );
        });

        it('opens a mailbox READ-ONLY without "i", "e", "s", "w" and "t" (section 5.2)', (t, done) => {
            run([BOB, 'A1 SELECT ReadOnly', 'A2 STORE 1 +FLAGS (\\Seen)', 'A3 SELECT Hidden'], resp => {
                assert.match(resp, /^\* OK \[PERMANENTFLAGS \(\)\]/m);
                assert.match(resp, /^A1 OK \[READ-ONLY\]/m);
                assert.match(resp, /^A2 NO /m);
                assert.match(resp, /^A3 OK \[READ-ONLY\]/m);
                done();
            });
        });

        it('lists only the flags the user can change in PERMANENTFLAGS (section 5.1.1)', (t, done) => {
            run([BOB, 'A1 SELECT INBOX', 'A2 SELECT NoSeen', 'A3 SELECT Shared'], resp => {
                assert.match(resp, /^\* OK \[PERMANENTFLAGS \(\\Seen\)\] [^\r]*\r\n(?:\* [^\r]*\r\n)*A1 OK \[READ-WRITE\]/m);
                assert.match(resp, /^\* OK \[PERMANENTFLAGS \(\\Answered \\Flagged \\Draft \\\*\)\] [^\r]*\r\n(?:\* [^\r]*\r\n)*A2 OK \[READ-WRITE\]/m);
                assert.match(resp, /^\* OK \[PERMANENTFLAGS \(\\Answered \\Flagged \\Draft \\Deleted \\Seen \\\*\)\] [^\r]*\r\n(?:\* [^\r]*\r\n)*A3 OK/m);
                done();
            });
        });

        it('changes only the flags the user has rights for with STORE (section 4)', (t, done) => {
            run(
                [
                    BOB,
                    'A1 SELECT INBOX',
                    'A2 STORE 1 +FLAGS (\\Flagged \\Deleted)',
                    'A3 STORE 1 +FLAGS (\\Seen \\Answered)',
                    'A4 STORE 2 FLAGS (\\Answered)',
                    'A5 STORE 1 -FLAGS.SILENT (\\Seen \\Flagged)',
                    'A6 FETCH 1:2 FLAGS',
                    'A7 STORE 1 +FLAGS (\\Bogus)',
                    'A8 UID STORE 1 +FLAGS ()'
                ],
                resp => {
                    // none of the flags can be changed
                    assert.strictEqual(tagged(resp, 'A2'), 'NO [NOPERM]');
                    // \Answered needs "w", \Seen is set
                    assert.match(resp, /^\* 1 FETCH \(FLAGS \(\\Flagged \\Seen\)\)\r\nA3 OK/m);
                    // replacing the flags keeps \Deleted, which needs "t", and clears \Seen
                    assert.match(resp, /^\* 2 FETCH \(FLAGS \(\\Deleted\)\)\r\nA4 OK/m);
                    assert.match(resp, /^\* 1 FETCH \(FLAGS \(\\Flagged\)\)\r\n\* 2 FETCH \(FLAGS \(\\Deleted\)\)\r\nA6 OK/m);
                    // invalid flags are still refused with BAD
                    assert.strictEqual(tagged(resp, 'A7'), 'BAD');
                    assert.match(resp, /^A8 OK /m);
                    done();
                }
            );
        });

        it('refuses STORE that replaces flags without "s", "w" or "t"', (t, done) => {
            run([BOB, 'A1 SELECT Insert', 'A2 STORE 1:* FLAGS (\\Seen)', 'A3 STORE 1:* FLAGS.SILENT ()'], resp => {
                // "i" makes the mailbox READ-WRITE
                assert.match(resp, /^A1 OK \[READ-WRITE\]/m);
                assert.strictEqual(tagged(resp, 'A2'), 'NO [NOPERM]');
                assert.strictEqual(tagged(resp, 'A3'), 'NO [NOPERM]');
                done();
            });
        });

        it('does not set \\Seen with FETCH without "s" (section 4)', (t, done) => {
            run([BOB, 'A1 SELECT NoSeen', 'A2 FETCH 1 BODY[TEXT]', 'A3 FETCH 1 FLAGS', 'A4 SELECT INBOX', 'A5 FETCH 1 (BODY[TEXT])'], resp => {
                assert.match(resp, /^\* 1 FETCH \(BODY\[TEXT\] \{8\}\r\nBody 5\r\n\)\r\nA2 OK/m);
                assert.match(resp, /^\* 1 FETCH \(FLAGS \(\)\)\r\nA3 OK/m);
                // with "s" it is set as usual
                assert.match(resp, /^\* 1 FETCH \(BODY\[TEXT\] \{8\}\r\nBody 1\r\n FLAGS \(\\Flagged \\Seen\)\)\r\nA5 OK/m);
                done();
            });
        });

        it('needs "e" for EXPUNGE, CLOSE closes the mailbox without expunging (section 4)', (t, done) => {
            run([BOB, 'A1 SELECT INBOX', 'A2 EXPUNGE', 'A3 UID EXPUNGE 2', 'A4 CLOSE', 'A5 STATUS INBOX (MESSAGES)'], resp => {
                assert.strictEqual(tagged(resp, 'A2'), 'NO [NOPERM]');
                assert.strictEqual(tagged(resp, 'A3'), 'NO [NOPERM]');
                assert.match(resp, /^A4 OK /m);
                assert.doesNotMatch(resp, /EXPUNGE\r$/m);
                assert.match(resp, /^\* STATUS "?INBOX"? \(MESSAGES 2\)\r$/m);
                done();
            });
        });

        it('expunges with "e"', (t, done) => {
            run([BOB, 'A1 SELECT Shared', 'A2 STORE 1 +FLAGS.SILENT (\\Deleted)', 'A3 CLOSE', 'A4 STATUS Shared (MESSAGES)'], resp => {
                assert.match(resp, /^\* STATUS "?Shared"? \(MESSAGES 0\)\r$/m);
                done();
            });
        });

        it('needs "i" for APPEND, and stores only the flags the user has rights for (section 4)', (t, done) => {
            run(
                [
                    BOB,
                    'A1 APPEND Insert (\\Seen \\Flagged \\Deleted) {3}\r\nabc',
                    'A2 APPEND Shared (\\Seen $Work) {3}\r\nabc',
                    'A3 APPEND ReadOnly {3}\r\nabc',
                    'A4 APPEND Secret {3}\r\nabc',
                    'A5 APPEND Insert (\\Bogus) {3}\r\nabc'
                ],
                resp => {
                    assert.match(resp, /^A1 OK /m);
                    assert.match(resp, /^A2 OK /m);
                    assert.strictEqual(tagged(resp, 'A3'), 'NO [NOPERM]');
                    // a mailbox the user can not see does not exist (section 6)
                    assert.strictEqual(tagged(resp, 'A4'), 'NO [TRYCREATE]');
                    assert.strictEqual(tagged(resp, 'A5'), 'BAD');
                    assert.deepStrictEqual(ctx.server.getMailbox('Insert').messages[0].flags, []);
                    assert.deepStrictEqual(ctx.server.getMailbox('Shared').messages[1].flags, ['\\Seen', '$Work']);
                    assert.strictEqual(ctx.server.getMailbox('ReadOnly').messages.length, 1);
                    assert.strictEqual(ctx.server.getMailbox('Secret').messages.length, 1);
                    done();
                }
            );
        });

        it('needs "i" for COPY, and copies only the flags the user has rights for (section 4)', (t, done) => {
            run([BOB, 'A1 SELECT INBOX', 'A2 COPY 1:2 Insert', 'A3 UID COPY 1 ReadOnly', 'A4 COPY 1 Secret', 'A5 COPY 2 Shared'], resp => {
                assert.match(resp, /^A2 OK /m);
                assert.strictEqual(tagged(resp, 'A3'), 'NO [NOPERM]');
                assert.strictEqual(tagged(resp, 'A4'), 'NO [TRYCREATE]');
                assert.match(resp, /^A5 OK /m);
                assert.deepStrictEqual(
                    ctx.server.getMailbox('Insert').messages.map(msg => msg.flags),
                    [[], []]
                );
                assert.deepStrictEqual(ctx.server.getMailbox('Shared').messages[1].flags, ['\\Deleted', '\\Seen']);
                assert.strictEqual(ctx.server.getMailbox('Secret').messages.length, 1);
                done();
            });
        });

        it('needs "t" and "e" on the source and "i" on the target for MOVE (RFC 6851 section 4.2)', (t, done) => {
            run([BOB, 'A1 SELECT INBOX', 'A2 MOVE 1 Shared', 'A3 SELECT Shared', 'A4 UID MOVE 1 ReadOnly', 'A5 MOVE 1 Insert'], resp => {
                assert.strictEqual(tagged(resp, 'A2'), 'NO [NOPERM]');
                assert.strictEqual(tagged(resp, 'A4'), 'NO [NOPERM]');
                assert.match(resp, /^\* 1 EXPUNGE\r\n(?:\* [^\r]*\r\n)*A5 OK/m);
                assert.strictEqual(ctx.server.getMailbox('INBOX').messages.length, 2);
                assert.deepStrictEqual(ctx.server.getMailbox('Insert').messages[0].flags, []);
                done();
            });
        });

        it('needs "k" on the parent for CREATE, and the new mailbox inherits its ACL (section 4)', (t, done) => {
            run([BOB, 'A1 CREATE Shared/New', 'A2 CREATE Lookup/New', 'A3 CREATE Top', 'A4 CREATE Secret/New', 'A5 MYRIGHTS Shared/New'], resp => {
                assert.match(resp, /^A1 OK /m);
                assert.strictEqual(tagged(resp, 'A2'), 'NO [NOPERM]');
                // there is no parent to have "k" on
                assert.strictEqual(tagged(resp, 'A3'), 'NO [NOPERM]');
                assert.strictEqual(tagged(resp, 'A4'), 'NO [NOPERM]');
                assert.match(resp, /^\* MYRIGHTS Shared\/New lrswiktecd\r$/m);
                done();
            });
        });

        it('needs "x" for DELETE (section 4)', (t, done) => {
            run([BOB, 'A1 DELETE Shared/Sub', 'A2 DELETE Secret', 'A3 DELETE Deletable', 'A4 DELETE Hidden'], resp => {
                assert.strictEqual(tagged(resp, 'A1'), 'NO [NOPERM]');
                assert.strictEqual(tagged(resp, 'A2'), 'NO [NONEXISTENT]');
                assert.match(resp, /^A3 OK /m);
                assert.strictEqual(tagged(resp, 'A4'), 'NO [NONEXISTENT]');
                assert.ok(!ctx.server.getMailbox('Deletable'));
                assert.ok(ctx.server.getMailbox('Hidden'));
                done();
            });
        });

        it('needs "x" on the mailbox and "k" on the new parent for RENAME (section 4)', (t, done) => {
            run([BOB, 'A1 RENAME Deletable Top', 'A2 RENAME Shared/Sub Shared/Other', 'A3 RENAME Deletable Shared/Moved', 'A4 MYRIGHTS Shared/Moved'], resp => {
                assert.strictEqual(tagged(resp, 'A1'), 'NO [NOPERM]');
                assert.strictEqual(tagged(resp, 'A2'), 'NO [NOPERM]');
                assert.match(resp, /^A3 OK /m);
                // RENAME keeps the ACL
                assert.match(resp, /^\* MYRIGHTS Shared\/Moved lrxc\r$/m);
                done();
            });
        });

        it('needs "l" for SUBSCRIBE, which checks that the mailbox exists (section 4)', (t, done) => {
            run([BOB, 'A1 SUBSCRIBE Hidden', 'A2 SUBSCRIBE Secret', 'A3 SUBSCRIBE Lookup', 'A4 UNSUBSCRIBE Lookup'], resp => {
                assert.strictEqual(tagged(resp, 'A1'), 'NO [NONEXISTENT]');
                assert.strictEqual(tagged(resp, 'A2'), 'NO [NONEXISTENT]');
                assert.match(resp, /^A3 OK /m);
                assert.match(resp, /^A4 OK /m);
                done();
            });
        });

        it('gives users without an ACL entry the rights of "anyone"', (t, done) => {
            run(['L1 LOGIN eve evepass', 'A1 LIST "" "*"', 'A2 MYRIGHTS Shared', 'A3 SELECT INBOX'], resp => {
                const listed = [...resp.matchAll(/^\* LIST \([^)]*\) "\/" "?([^"\r]+)"?\r$/gm)].map(m => m[1]);
                assert.deepStrictEqual(listed.sort(), ['Neg', 'Shared']);
                assert.match(resp, /^\* MYRIGHTS Shared l\r$/m);
                assert.strictEqual(tagged(resp, 'A3'), 'NO [NONEXISTENT]');
                done();
            });
        });

        it('does not restrict the owner', (t, done) => {
            run([OWNER, 'A1 SELECT Secret', 'A2 STORE 1 +FLAGS (\\Deleted)', 'A3 EXPUNGE', 'A4 LIST "" Secret'], resp => {
                assert.match(resp, /^A1 OK \[READ-WRITE\]/m);
                assert.match(resp, /^\* 1 EXPUNGE\r$/m);
                assert.match(resp, /^\* LIST \([^)]*\) "\/" "?Secret"?\r$/m);
                done();
            });
        });

        it('deletes the ACL with the mailbox (section 4)', (t, done) => {
            run(
                [OWNER, 'A1 CREATE Shared/Sub/Deep', 'A2 DELETE Shared/Sub', 'A3 GETACL Shared/Sub', 'A4 CREATE Lookup/Fresh', 'A5 GETACL Lookup/Fresh'],
                resp => {
                    // Shared/Sub stays as a \Noselect placeholder for its child, without the ACL
                    assert.match(resp, /^\* ACL Shared\/Sub testuser lrswipkxteacd\r$/m);
                    // inherited from Lookup
                    assert.match(resp, /^\* ACL Lookup\/Fresh testuser lrswipkxteacd bob l\r$/m);
                    done();
                }
            );
        });
    });

    it('uses the rights from SELECT time until the mailbox is selected again (section 5.1.1)', (t, done) => {
        openSession(ctx.server.address().port, owner => {
            openSession(ctx.server.address().port, bob => {
                bob.run(BOB, () => {
                    bob.run('B1 SELECT INBOX', resp => {
                        assert.match(resp, /^B1 OK \[READ-WRITE\]/m);
                        owner.run(OWNER, () => {
                            owner.run('O1 SETACL INBOX bob +e', () => {
                                bob.run('B2 EXPUNGE', resp => {
                                    assert.match(resp, /^B2 NO \[NOPERM\]/m);
                                    bob.run('B3 SELECT INBOX', () => {
                                        bob.run('B4 EXPUNGE', resp => {
                                            assert.match(resp, /^\* 2 EXPUNGE\r\nB4 OK/m);
                                            owner.close();
                                            bob.close();
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
    });
});

describe('ACL options', () => {
    describe('with X-GM-EXT-1', () => {
        const ctx = setupServer(() => ({ plugins: ['ACL', 'X-GM-EXT-1'], users: users(), storage: storage() }));

        // labels are shared message data like keywords, so changing them needs "w" (RFC 4314 section 4)
        it('needs "w" to STORE labels', (t, done) => {
            ctx.run(
                [
                    BOB,
                    'A1 SELECT Insert',
                    'A2 STORE 1 +X-GM-LABELS (stolen)',
                    'A3 SELECT NoSeen',
                    'A4 STORE 1 +X-GM-LABELS (work)',
                    'A5 STORE 1 X-GM-FOO (x)',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString('binary');
                    assert.strictEqual(tagged(resp, 'A2'), 'NO [NOPERM]');
                    assert.match(resp, /^A4 OK /m);
                    // unknown items are still a syntax error
                    assert.strictEqual(tagged(resp, 'A5'), 'BAD');
                    done();
                }
            );
        });
    });

    describe('aclOwner', () => {
        const ctx = setupServer(() => ({ plugins: ['ACL'], users: users(), storage: storage(), aclOwner: 'bob' }));

        it('makes another user the owner', (t, done) => {
            ctx.run([OWNER, 'A1 MYRIGHTS Neg', 'A2 SELECT Secret', 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                // only "-bob" has negative rights
                assert.match(resp, /^\* MYRIGHTS Neg lr\r$/m);
                assert.strictEqual(tagged(resp, 'A2'), 'NO [NONEXISTENT]');
                done();
            });
        });
    });

    describe('AUTHENTICATE PLAIN', () => {
        const ctx = setupServer(() => ({ plugins: ['ACL', 'AUTH-PLAIN'], users: users(), storage: storage() }));

        it('knows the user that logged in', (t, done) => {
            ctx.run(['A1 AUTHENTICATE PLAIN', Buffer.from('\0bob\0bobpass').toString('base64'), 'A2 MYRIGHTS INBOX', 'ZZ LOGOUT'], resp => {
                assert.match(resp.toString('binary'), /^\* MYRIGHTS INBOX lrs\r$/m);
                done();
            });
        });
    });

    describe('invalid storage', () => {
        const ctx = setupServer(() => ({ plugins: ['ACL'], storage: { INBOX: { acl: { bob: 'lrZ' } } } }));

        it('answers NO [SERVERBUG]', (t, done) => {
            ctx.run([OWNER, 'A1 GETACL INBOX', 'ZZ LOGOUT'], resp => {
                assert.match(resp.toString('binary'), /^A1 NO \[SERVERBUG\] /m);
                done();
            });
        });
    });

    describe('load order', () => {
        // MOVE and UID EXPUNGE are enforced also when their plugins are loaded after ACL
        const ctx = setupServer(() => ({ plugins: ['MOVE', 'ACL', 'UIDPLUS'], users: users(), storage: storage() }));

        it('enforces commands of plugins loaded later', (t, done) => {
            ctx.run([BOB, 'A1 SELECT INBOX', 'A2 MOVE 1 Shared', 'A3 UID EXPUNGE 1', 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                assert.strictEqual(tagged(resp, 'A2'), 'NO [NOPERM]');
                assert.strictEqual(tagged(resp, 'A3'), 'NO [NOPERM]');
                done();
            });
        });
    });

    describe('without the plugin', () => {
        const ctx = setupServer(() => ({ users: users(), storage: storage() }));

        it('has no ACL commands and no restrictions', (t, done) => {
            ctx.run([BOB, 'A0 CAPABILITY', 'A1 GETACL INBOX', 'A2 SELECT Secret', 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                assert.doesNotMatch(resp, /\bACL\b/);
                assert.strictEqual(tagged(resp, 'A1'), 'BAD');
                assert.match(resp, /^A2 OK \[READ-WRITE\]/m);
                done();
            });
        });
    });
});
