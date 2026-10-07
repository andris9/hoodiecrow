'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');

describe('Hoodiecrow tests', () => {
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
