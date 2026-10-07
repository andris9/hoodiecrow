'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');

describe('ImapKit tests', () => {
    const ctx = setupServer(() => ({
        storage: {
            INBOX: {
                messages: [
                    {
                        uid: 31,
                        raw: 'Subject: hello 1\r\n\r\nWorld 1!',
                        flags: ['\\Seen']
                    },
                    {
                        uid: 32,
                        raw: 'Subject: hello 1\r\n\r\nWorld 1!',
                        flags: ['\\Seen', '\\Deleted']
                    }
                ]
            }
        }
    }));

    it('Add flags', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 UID STORE 31 +FLAGS (\\Deleted)', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();

            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('FLAGS (\\Seen \\Deleted) UID 31') >= 0);

            done();
        });
    });

    it('Invalid system flag', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 UID STORE 31 +FLAGS (\\XNotValid)', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();

            assert.ok(resp.indexOf('\nA3 BAD') >= 0);
            assert.ok(resp.indexOf('FLAGS (\\Seen \\XNotValid)') < 0);

            done();
        });
    });

    it('Custom flag', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 SELECT INBOX',
            'A3 UID STORE 31 +FLAGS ("Custom Flag")',
            'A4 UID STORE 31 +FLAGS ("CustomFlag")',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();

            // RFC 3501 9: a keyword is an atom, it can not contain a space
            assert.ok(resp.indexOf('\nA3 BAD') >= 0);
            assert.ok(resp.indexOf('\nA4 OK') >= 0);
            assert.ok(resp.indexOf('FLAGS (\\Seen CustomFlag) UID 31') >= 0);

            done();
        });
    });

    it('Remove flags', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 UID STORE 32 -FLAGS (\\Seen)', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();

            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('FLAGS (\\Deleted) UID 32') >= 0);

            done();
        });
    });

    it('Set flags', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 UID STORE 32 FLAGS (MyFlag $My$Flag)', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();

            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('(FLAGS (MyFlag $My$Flag) UID 32)') >= 0);

            done();
        });
    });

    it('Add flags silent', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 UID STORE 31 +FLAGS.SILENT (\\Deleted)', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();

            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('FLAGS (\\Seen \\Deleted)') < 0);

            done();
        });
    });

    it('Remove flags silent', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 UID STORE 32 -FLAGS.SILENT (\\Seen)', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();

            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('FLAGS (\\Deleted)') < 0);

            done();
        });
    });

    it('Set flags silent', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 UID STORE 32 FLAGS.SILENT (MyFlag $My$Flag)', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();

            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('(FLAGS (MyFlag $My$Flag))') < 0);

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
                        uid: 31,
                        raw: 'Subject: hello 1\r\n\r\nWorld 1!',
                        flags: ['\\Seen']
                    }
                ]
            }
        }
    }));

    it('System flag', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 UID STORE 31 +FLAGS (\\Deleted)', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();

            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('FLAGS (\\Seen \\Deleted) UID 31') >= 0);

            done();
        });
    });

    it('Custom flag', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 UID STORE 31 +FLAGS (CustomFlag)', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();

            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('FLAGS (\\Seen) UID 31') >= 0);

            done();
        });
    });
});
