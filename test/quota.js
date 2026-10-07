'use strict';

// QUOTA, RFC 9208 (https://www.rfc-editor.org/rfc/rfc9208.txt)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');
const { openSession } = require('./helpers/session');

const LOGIN = 'L1 LOGIN testuser testpass';

// 40 octets each
const MESSAGE = 'Subject: quota test\r\n\r\nHello, world!!!\r\n';

function storage() {
    return {
        INBOX: {
            messages: [{ raw: MESSAGE }, { raw: MESSAGE, flags: ['\\Deleted'] }]
        },
        '': {
            folders: {
                Archive: { messages: [{ raw: MESSAGE }] },
                Parent: { flags: ['\\Noselect'], folders: { Child: {} } }
            }
        },
        '#shared/': {
            type: 'shared',
            folders: {
                Team: { messages: [{ raw: MESSAGE }] }
            }
        }
    };
}

function append(size) {
    return 'A9 APPEND INBOX {' + size + '}\r\n' + 'x'.repeat(size);
}

describe('QUOTA', () => {
    describe('without limits', () => {
        const ctx = setupServer(() => ({ plugins: ['QUOTA'], storage: storage() }));

        // RFC 9208 sections 1, 3.1.1 and 5: QUOTA, every supported resource and QUOTASET are advertised
        it('advertises QUOTA, the resource types and QUOTASET', (t, done) => {
            ctx.run([LOGIN, 'A1 CAPABILITY', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^\* CAPABILITY .*\bQUOTA QUOTA=RES-STORAGE QUOTA=RES-MESSAGE QUOTA=RES-MAILBOX QUOTASET\b/m);
                assert.doesNotMatch(resp, /QUOTA=RES-ANNOTATION-STORAGE/);
                done();
            });
        });

        // RFC 9208 section 4.2.1: resources that are not listed are not limited, an empty list means no limits
        it('GETQUOTA lists no resources when nothing is limited', (t, done) => {
            ctx.run([LOGIN, 'A1 GETQUOTA "User quota"', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^\* QUOTA "User quota" \(\)\r\nA1 OK /m);
                done();
            });
        });

        it('allows appending anything', (t, done) => {
            ctx.run([LOGIN, append(5000), 'ZZ LOGOUT'], resp => {
                assert.match(resp.toString(), /^A9 OK /m);
                done();
            });
        });
    });

    describe('with limits', () => {
        const ctx = setupServer(() => ({
            plugins: ['QUOTA', 'MOVE', 'UIDPLUS'],
            quota: { root: 'User quota', STORAGE: 1, MESSAGE: 5, MAILBOX: 4 },
            storage: storage()
        }));

        // RFC 9208 sections 4.1.1 and 5.1: STORAGE is in units of 1024 octets
        it('GETQUOTA reports usage and limits', (t, done) => {
            ctx.run([LOGIN, 'A1 GETQUOTA "User quota"', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                // 3 messages of 40 octets, INBOX, Archive and Parent/Child (the \Noselect placeholder is not a mailbox)
                assert.match(resp, /^\* QUOTA "User quota" \(STORAGE 1 1 MESSAGE 3 5 MAILBOX 3 4\)\r\nA1 OK /m);
                done();
            });
        });

        it('GETQUOTA of an unknown quota root fails', (t, done) => {
            ctx.run([LOGIN, 'A1 GETQUOTA ""', 'A2 GETQUOTA "user quota"', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^A1 NO \[NONEXISTENT\] /m);
                assert.match(resp, /^A2 NO \[NONEXISTENT\] /m);
                assert.doesNotMatch(resp, /^\* QUOTA /m);
                done();
            });
        });

        // RFC 9208 section 4.1.2: QUOTAROOT and the QUOTA of every root, the mailbox does not have to exist
        it('GETQUOTAROOT lists the quota root of personal mailboxes', (t, done) => {
            ctx.run([LOGIN, 'A1 GETQUOTAROOT inbox', 'A2 GETQUOTAROOT Archive', 'A3 GETQUOTAROOT "Not yet"', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^\* QUOTAROOT INBOX "User quota"\r\n\* QUOTA "User quota" \(STORAGE 1 1 MESSAGE 3 5 MAILBOX 3 4\)\r\nA1 OK /m);
                assert.match(resp, /^\* QUOTAROOT Archive "User quota"\r\n\* QUOTA "User quota" \(/m);
                assert.match(resp, /^\* QUOTAROOT "Not yet" "User quota"\r\n\* QUOTA "User quota" \(/m);
                done();
            });
        });

        // RFC 9208 section 4.2.2: a mailbox without quota roots
        it('GETQUOTAROOT of a shared mailbox lists no quota root', (t, done) => {
            ctx.run([LOGIN, 'A1 GETQUOTAROOT "#shared/Team"', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^\* QUOTAROOT #shared\/Team\r\nA1 OK /m);
                assert.doesNotMatch(resp, /^\* QUOTA /m);
                done();
            });
        });

        // RFC 9208 section 4.1.3: the new limits replace all earlier ones, the result is reported with QUOTA
        it('SETQUOTA replaces the limits', (t, done) => {
            ctx.run(
                [
                    LOGIN,
                    'A1 SETQUOTA "User quota" (message 100 STORAGE 200)',
                    'A2 GETQUOTA "User quota"',
                    'A3 SETQUOTA "User quota" ()',
                    'A4 GETQUOTA "User quota"',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString();
                    assert.match(resp, /^\* QUOTA "User quota" \(STORAGE 1 200 MESSAGE 3 100\)\r\nA1 OK /m);
                    assert.match(resp, /^\* QUOTA "User quota" \(STORAGE 1 200 MESSAGE 3 100\)\r\nA2 OK /m);
                    assert.match(resp, /^\* QUOTA "User quota" \(\)\r\nA3 OK /m);
                    assert.match(resp, /^\* QUOTA "User quota" \(\)\r\nA4 OK /m);
                    done();
                }
            );
        });

        it('SETQUOTA refuses what can not be set', (t, done) => {
            ctx.run(
                [
                    LOGIN,
                    'A1 SETQUOTA "Other root" (STORAGE 10)',
                    'A2 SETQUOTA "User quota" (ANNOTATION-STORAGE 10)',
                    'A3 SETQUOTA "User quota" (STORAGE 10 STORAGE 20)',
                    'A4 SETQUOTA "User quota" (STORAGE 9223372036854775807)',
                    'A5 GETQUOTA "User quota"',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString();
                    assert.match(resp, /^A1 NO \[NONEXISTENT\] /m);
                    assert.match(resp, /^A2 NO \[CANNOT\] /m);
                    assert.match(resp, /^A3 NO \[CANNOT\] /m);
                    assert.match(resp, /^A4 NO \[LIMIT\] /m);
                    // nothing was changed
                    assert.match(resp, /^\* QUOTA "User quota" \(STORAGE 1 1 MESSAGE 3 5 MAILBOX 3 4\)\r\nA5 OK /m);
                    done();
                }
            );
        });

        // RFC 9208 section 4.1.4: DELETED counts \Deleted messages, DELETED-STORAGE may be the sum of their RFC822.SIZE
        it('STATUS reports DELETED and DELETED-STORAGE', (t, done) => {
            ctx.run([LOGIN, 'A1 STATUS INBOX (MESSAGES DELETED DELETED-STORAGE)', 'A2 STATUS Archive (DELETED-STORAGE DELETED)', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^\* STATUS INBOX \(MESSAGES 2 DELETED 1 DELETED-STORAGE 40\)\r\nA1 OK /m);
                assert.match(resp, /^\* STATUS Archive \(DELETED-STORAGE 0 DELETED 0\)\r\nA2 OK /m);
                done();
            });
        });

        // RFC 9208 section 4.3.1: NO [OVERQUOTA] when the addition puts the mailbox over a limit
        it('APPEND over the STORAGE limit fails with OVERQUOTA', (t, done) => {
            ctx.run([LOGIN, append(1024 - 120 + 1), 'A2 STATUS INBOX (MESSAGES)', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^A9 NO \[OVERQUOTA\] /m);
                assert.match(resp, /^\* STATUS INBOX \(MESSAGES 2\)/m);
                done();
            });
        });

        it('APPEND up to the STORAGE limit succeeds', (t, done) => {
            ctx.run([LOGIN, append(1024 - 120), 'A2 GETQUOTA "User quota"', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^A9 OK /m);
                assert.match(resp, /^\* QUOTA "User quota" \(STORAGE 1 1 MESSAGE 4 5 MAILBOX 3 4\)/m);
                done();
            });
        });

        it('APPEND over the MESSAGE limit fails with OVERQUOTA', (t, done) => {
            ctx.run([LOGIN, 'A1 SETQUOTA "User quota" (MESSAGE 3)', append(1), 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^A1 OK /m);
                assert.match(resp, /^A9 NO \[OVERQUOTA\] /m);
                done();
            });
        });

        it('APPEND to a missing mailbox still asks for CREATE', (t, done) => {
            ctx.run([LOGIN, 'A1 SETQUOTA "User quota" (MESSAGE 0)', 'A2 APPEND Nope {1}\r\nx', 'ZZ LOGOUT'], resp => {
                assert.match(resp.toString(), /^A2 NO \[TRYCREATE\] /m);
                done();
            });
        });

        it('mailboxes outside the quota root are not limited', (t, done) => {
            ctx.run([LOGIN, 'A1 SETQUOTA "User quota" (MESSAGE 0 STORAGE 0)', 'A2 APPEND "#shared/Team" {1}\r\nx', 'ZZ LOGOUT'], resp => {
                assert.match(resp.toString(), /^A2 OK /m);
                done();
            });
        });

        it('COPY over the MESSAGE limit fails with OVERQUOTA and copies nothing', (t, done) => {
            ctx.run([LOGIN, 'L2 SELECT INBOX', 'A1 SETQUOTA "User quota" (MESSAGE 4)', 'A2 COPY 1:2 Archive', 'A3 UID COPY 1 Archive', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^A2 NO \[OVERQUOTA\] /m);
                assert.match(resp, /^A3 OK \[COPYUID 1 1 2\] /m);
                assert.strictEqual(ctx.server.getMailbox('Archive').messages.length, 2);
                done();
            });
        });

        // moving within the quota root does not change the usage
        it('MOVE within the quota root is not limited', (t, done) => {
            ctx.run([LOGIN, 'L2 SELECT INBOX', 'A1 SETQUOTA "User quota" (MESSAGE 3 STORAGE 0)', 'A2 MOVE 1:2 Archive', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^A2 OK /m);
                assert.strictEqual(ctx.server.getMailbox('Archive').messages.length, 3);
                done();
            });
        });

        it('MOVE into the quota root fails with OVERQUOTA', (t, done) => {
            ctx.run([LOGIN, 'L2 SELECT "#shared/Team"', 'A1 SETQUOTA "User quota" (MESSAGE 3)', 'A2 MOVE 1 Archive', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^A2 NO \[OVERQUOTA\] /m);
                assert.doesNotMatch(resp, /EXPUNGE/);
                assert.strictEqual(ctx.server.getMailbox('#shared/Team').messages.length, 1);
                done();
            });
        });

        // MAILBOX counts mailboxes, CREATE also creates missing parents
        it('CREATE over the MAILBOX limit fails with OVERQUOTA', (t, done) => {
            ctx.run([LOGIN, 'A1 CREATE a/b', 'A2 CREATE c', 'A3 CREATE Parent', 'A4 CREATE Archive', 'A5 CREATE "#shared/x"', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^A1 NO \[OVERQUOTA\] /m);
                assert.match(resp, /^A2 OK /m);
                assert.match(resp, /^A3 NO \[OVERQUOTA\] /m);
                // errors other than the quota are reported as before
                assert.match(resp, /^A4 NO \[ALREADYEXISTS\] /m);
                assert.match(resp, /^A5 NO \[NOPERM\] /m);
                assert.ok(!ctx.server.getMailbox('a'));
                done();
            });
        });

        // RFC 3501 section 6.3.5: renaming INBOX creates a new mailbox
        it('RENAME INBOX counts as a new mailbox', (t, done) => {
            ctx.run([LOGIN, 'A1 RENAME Archive Old', 'A2 CREATE x', 'A3 RENAME INBOX Saved', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^A1 OK /m);
                assert.match(resp, /^A2 OK /m);
                assert.match(resp, /^A3 NO \[OVERQUOTA\] /m);
                done();
            });
        });

        it('expunging frees quota', (t, done) => {
            ctx.run([LOGIN, 'L2 SELECT INBOX', 'A1 SETQUOTA "User quota" (MESSAGE 3)', 'A2 EXPUNGE', append(1), 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^A9 OK /m);
                done();
            });
        });

        // SETQUOTA from one session limits the others
        it('limits apply to every session', (t, done) => {
            openSession(ctx.server.address().port, first => {
                openSession(ctx.server.address().port, second => {
                    first.run(LOGIN, () => {
                        second.run(LOGIN, () => {
                            first.run('A1 SETQUOTA "User quota" (MESSAGE 3)', () => {
                                second.run('B1 APPEND INBOX {1}\r\nx', resp => {
                                    assert.match(resp, /^B1 NO \[OVERQUOTA\] /m);
                                    first.close();
                                    second.close();
                                    done();
                                });
                            });
                        });
                    });
                });
            });
        });
    });

    describe('with soft limits', () => {
        const ctx = setupServer(() => ({
            plugins: ['QUOTA', 'UIDPLUS'],
            quota: { root: '', MESSAGE: 3, MAILBOX: 3, soft: true },
            storage: storage()
        }));

        // RFC 9208 section 4.3.1, examples 2 and 3: an untagged NO [OVERQUOTA] and the command completes
        it('APPEND and COPY over a soft limit warn and succeed', (t, done) => {
            ctx.run([LOGIN, append(1), 'L2 SELECT INBOX', 'A3 COPY 1 Archive', 'A4 GETQUOTA ""', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^\* NO \[OVERQUOTA\] Soft quota has been exceeded\r\nA9 OK \[APPENDUID 1 3\] /m);
                assert.match(resp, /^\* NO \[OVERQUOTA\] Soft quota has been exceeded\r\nA3 OK \[COPYUID 1 1 2\] /m);
                assert.match(resp, /^\* QUOTA "" \(MESSAGE 5 3 MAILBOX 3 3\)\r\nA4 OK /m);
                done();
            });
        });

        it('CREATE over a soft limit warns and succeeds', (t, done) => {
            ctx.run([LOGIN, 'A1 CREATE x', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^\* NO \[OVERQUOTA\] Soft quota has been exceeded\r\nA1 OK /m);
                assert.ok(ctx.server.getMailbox('x'));
                done();
            });
        });

        it('stays quiet within the limits', (t, done) => {
            ctx.run([LOGIN, 'A1 SETQUOTA "" (MESSAGE 10)', append(1), 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.doesNotMatch(resp, /OVERQUOTA/);
                assert.match(resp, /^A9 OK /m);
                done();
            });
        });
    });

    describe('with LIST-STATUS', () => {
        const ctx = setupServer(() => ({ plugins: ['QUOTA', 'LIST-STATUS'], storage: storage() }));

        // RFC 5819 section 1: any STATUS item can be a STATUS return option of LIST
        it('returns DELETED and DELETED-STORAGE with LIST', (t, done) => {
            ctx.run([LOGIN, 'A1 LIST "" "INBOX" RETURN (STATUS (DELETED DELETED-STORAGE))', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^\* LIST \([^)]*\) "\/" "?INBOX"?\r\n\* STATUS INBOX \(DELETED 1 DELETED-STORAGE 40\)\r\nA1 OK /m);
                done();
            });
        });
    });

    it('refuses invalid limits in the server options', () => {
        const imapkit = require('../lib/server');
        assert.throws(() => imapkit({ plugins: ['QUOTA'], quota: { STORAGE: -1 } }), /Invalid quota limit/);
        assert.throws(() => imapkit({ plugins: ['QUOTA'], quota: { MESSAGE: 'many' } }), /Invalid quota limit/);
    });
});
