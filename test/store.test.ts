import { describe, it } from 'node:test';
import assert from 'node:assert';
import { setupServer } from './helpers/index.js';

describe('ImapKit tests', () => {
    const ctx = setupServer(() => ({
        storage: {
            INBOX: {
                messages: [
                    {
                        raw: 'Subject: hello 1\r\n\r\nWorld 1!',
                        flags: ['\\Seen']
                    },
                    {
                        raw: 'Subject: hello 1\r\n\r\nWorld 1!',
                        flags: ['\\Seen', '\\Deleted']
                    }
                ]
            }
        }
    }));

    it('Add flags', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 STORE 1 +FLAGS (\\Deleted)', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();

            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('FLAGS (\\Seen \\Deleted)') >= 0);

            done();
        });
    });

    it('Invalid system flag', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 STORE 1 +FLAGS (\\XNotValid)', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();

            assert.ok(resp.indexOf('\nA3 BAD') >= 0);
            assert.ok(resp.indexOf('FLAGS (\\Seen \\XNotValid)') < 0);

            done();
        });
    });

    it('Custom flag', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 STORE 1 +FLAGS ("Custom Flag")', 'A4 STORE 1 +FLAGS ("CustomFlag")', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();

            // RFC 3501 9: a keyword is an atom, it can not contain a space
            assert.ok(resp.indexOf('\nA3 BAD') >= 0);
            assert.ok(resp.indexOf('\nA4 OK') >= 0);
            assert.ok(resp.indexOf('FLAGS (\\Seen CustomFlag)') >= 0);

            done();
        });
    });

    it('Remove flags', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 STORE 2 -FLAGS (\\Seen)', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();

            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('FLAGS (\\Deleted)') >= 0);

            done();
        });
    });

    it('Set flags', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 STORE 2 FLAGS (MyFlag $My$Flag)', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();

            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('(FLAGS (MyFlag $My$Flag))') >= 0);

            done();
        });
    });

    it('Add flags silent', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 STORE 1 +FLAGS.SILENT (\\Deleted)', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();

            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('FLAGS (\\Seen \\Deleted)') < 0);

            done();
        });
    });

    it('Remove flags silent', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 STORE 2 -FLAGS.SILENT (\\Seen)', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();

            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('FLAGS (\\Deleted)') < 0);

            done();
        });
    });

    it('Set flags silent', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 STORE 2 FLAGS.SILENT (MyFlag $My$Flag)', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();

            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('(FLAGS (MyFlag $My$Flag))') < 0);

            done();
        });
    });

    it('Keywords that are not atoms', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 STORE 1 +FLAGS (a]b)', 'A4 STORE 1 FLAGS ("a*b")', 'A5 FETCH 1 FLAGS', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();

            assert.ok(resp.indexOf('\nA3 BAD') >= 0);
            assert.ok(resp.indexOf('\nA4 BAD') >= 0);
            assert.ok(resp.indexOf('* 1 FETCH (FLAGS (\\Seen))') >= 0);

            done();
        });
    });

    it('Read-only mailbox', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 EXAMINE INBOX',
            'A3 STORE 1 +FLAGS (\\Flagged)',
            'A4 UID STORE 1 +FLAGS (\\Flagged)',
            'A5 FETCH 1 FLAGS',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();

            assert.ok(resp.indexOf('\nA3 NO') >= 0);
            assert.ok(resp.indexOf('\nA4 NO') >= 0);
            assert.ok(resp.indexOf('* 1 FETCH (FLAGS (\\Seen))') >= 0);

            done();
        });
    });
});

describe('Custom flags not allowed', () => {
    const ctx = setupServer(() => ({
        storage: {
            INBOX: {
                allowPermanentFlags: false,
                messages: [
                    {
                        raw: 'Subject: hello 1\r\n\r\nWorld 1!',
                        flags: ['\\Seen']
                    }
                ]
            }
        }
    }));

    it('System flag', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 STORE 1 +FLAGS (\\Deleted)', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();

            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('FLAGS (\\Seen \\Deleted)') >= 0);

            done();
        });
    });

    it('Custom flag', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 STORE 1 +FLAGS (CustomFlag)', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();

            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('FLAGS (\\Seen)') >= 0);

            done();
        });
    });

    it('STORE echoes \\Recent with the other flags', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 APPEND INBOX {3}\r\nabc', 'A4 STORE 2 +FLAGS (\\Flagged)', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\n* 2 FETCH (FLAGS (\\Flagged \\Recent))\r\n') >= 0, resp);
            done();
        });
    });
});

// RFC 3501 section 7.1 (RFC 9051 section 7.1): PERMANENTFLAGS "indicates which of the known flags the client can
// change permanently", a STORE of a flag that is not in the list is ignored. Flags that messages of the mailbox
// already have are in PERMANENTFLAGS, so STORE must accept them, and APPEND and COPY (RFC 3501 sections 6.3.11 and
// 6.4.7, the flags SHOULD be set) keep only flags the target mailbox can store
describe('PERMANENTFLAGS and STORE agree', () => {
    const ctx = setupServer(() => ({
        storage: {
            INBOX: {
                allowPermanentFlags: false,
                permanentFlags: ['\\Seen'],
                messages: [
                    { raw: 'Subject: hello 1\r\n\r\nWorld 1!', flags: ['\\Seen', '\\Flagged', '$Known'] },
                    { raw: 'Subject: hello 2\r\n\r\nWorld 2!', flags: [] }
                ]
            },
            '': {
                folders: {
                    Other: {
                        messages: [{ raw: 'Subject: other\r\n\r\nOther', flags: ['\\Draft', '$Known', '$Fresh'] }]
                    }
                }
            }
        }
    }));

    it('STORE sets the flags PERMANENTFLAGS lists and ignores the others', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 SELECT INBOX',
            'A3 STORE 2 +FLAGS (\\Flagged $Known \\Deleted $New)',
            'A4 STORE 2 FLAGS (\\Seen \\Answered $Known $Other)',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.match(resp, /^\* OK \[PERMANENTFLAGS \(\\Seen \\Flagged \$Known\)\]/m);
            assert.match(resp, /^\* 2 FETCH \(FLAGS \(\\Flagged \$Known\)\)\r$/m);
            assert.match(resp, /^\* 2 FETCH \(FLAGS \(\\Seen \$Known\)\)\r$/m);
            done();
        });
    });

    it('APPEND and COPY keep only the permanent flags', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 APPEND INBOX (\\Flagged \\Deleted $New) {3}\r\nabc',
            'A3 SELECT Other',
            'A4 COPY 1 INBOX',
            'A5 SELECT INBOX',
            'A6 FETCH 3:4 FLAGS',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.match(resp, /^\* 3 FETCH \(FLAGS \(\\Flagged \\Recent\)\)\r$/m);
            assert.match(resp, /^\* 4 FETCH \(FLAGS \(\$Known \\Recent\)\)\r$/m);
            assert.match(resp, /^\* OK \[PERMANENTFLAGS \(\\Seen \\Flagged \$Known\)\]/m);
            done();
        });
    });

    it('the control API uses the same permanent flags', () => {
        assert.deepStrictEqual(ctx.server.control.setFlags('INBOX', [2], ['\\Flagged', '$Known'], 'add'), [{ uid: 2, flags: ['\\Flagged', '$Known'] }]);
        assert.throws(() => ctx.server.control.setFlags('INBOX', [2], ['\\Deleted'], 'add'), { code: 'INVALID' });
        assert.strictEqual(ctx.server.control.addMessage('INBOX', { raw: 'Subject: x\r\n\r\nx', flags: ['$Known'] }).uid, 3);
        assert.throws(() => ctx.server.control.addMessage('INBOX', { raw: 'Subject: x\r\n\r\nx', flags: ['$New'] }), { code: 'INVALID' });
    });
});
