'use strict';

// RFC 5530 response codes (https://www.rfc-editor.org/rfc/rfc5530.txt), listed in RFC 9051 section 7.1. They are sent
// to IMAP4rev1 sessions as well, RFC 3501 section 7.1 lets clients ignore response codes they do not know

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');
const { openSession } = require('./helpers/session');

const LOGIN = 'L1 LOGIN testuser testpass';
const b64 = str => Buffer.from(str, 'binary').toString('base64');

const storage = () => ({
    INBOX: { messages: [{ raw: 'Subject: one\r\n\r\n1' }, { raw: 'Subject: two\r\n\r\n2' }, { raw: 'Subject: three\r\n\r\n3' }] },
    '': {
        separator: '/',
        folders: {
            Parent: { flags: ['\\Noselect'], folders: { Child: {} } }
        }
    }
});

describe('RFC 5530 response codes', () => {
    const ctx = setupServer(() => ({ plugins: ['SASL-IR', 'AUTH-PLAIN', 'OAUTHBEARER', 'XOAUTH2'], storage: storage() }));
    const run = cmds => new Promise(resolve => ctx.run(cmds.concat('ZZ LOGOUT'), resp => resolve(resp.toString('binary'))));

    it('AUTHENTICATIONFAILED for a rejected LOGIN or AUTHENTICATE', async () => {
        const resp = await run([
            'A1 LOGIN testuser wrong',
            'A2 LOGIN nobody testpass',
            'A3 AUTHENTICATE PLAIN ' + b64('\x00testuser\x00wrong'),
            'A4 AUTHENTICATE OAUTHBEARER ' + b64('n,a=testuser,\x01auth=Bearer wrong\x01\x01'),
            'AQ==',
            'A5 AUTHENTICATE XOAUTH2 ' + b64('user=nobody\x01auth=Bearer testtoken\x01\x01'),
            'A6 AUTHENTICATE XOAUTH2 ' + b64('user=testuser\x01auth=Bearer wrong\x01\x01'),
            ''
        ]);
        for (const tag of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6']) {
            assert.match(resp, new RegExp('^' + tag + ' NO \\[AUTHENTICATIONFAILED\\] ', 'm'), tag);
        }
    });

    it('AUTHORIZATIONFAILED when AUTH=PLAIN asks to act as another user', async () => {
        const resp = await run([
            'A1 AUTHENTICATE PLAIN ' + b64('otheruser\x00testuser\x00testpass'),
            'A2 AUTHENTICATE PLAIN ' + b64('otheruser\x00testuser\x00wrong')
        ]);
        assert.match(resp, /^A1 NO \[AUTHORIZATIONFAILED\] /m);
        // the credentials are checked first
        assert.match(resp, /^A2 NO \[AUTHENTICATIONFAILED\] /m);
    });

    it('HASCHILDREN for DELETE of a \\Noselect name with children (RFC 9051 section 6.3.5)', async () => {
        const resp = await run([LOGIN, 'A1 DELETE Parent', 'A2 DELETE Parent/Child', 'A3 DELETE Parent']);
        assert.match(resp, /^A1 NO \[HASCHILDREN\] /m);
        assert.match(resp, /^A2 OK /m);
        assert.match(resp, /^A3 NO \[NONEXISTENT\] /m);
    });

    it('TRYCREATE for a \\Noselect target (RFC 9051 sections 6.3.12 and 6.4.7)', async () => {
        const resp = await run([LOGIN, 'A1 SELECT INBOX', 'A2 COPY 1 Parent', 'A3 APPEND Parent {1}\r\nx', 'A4 CREATE Parent', 'A5 COPY 1 Parent']);
        assert.match(resp, /^A2 NO \[TRYCREATE\] /m);
        assert.match(resp, /^A3 NO \[TRYCREATE\] /m);
        assert.match(resp, /^A5 OK /m);
    });

    it('CLIENTBUG for STATUS on the selected mailbox (RFC 9051 sections 6.3.11 and 7.1)', async () => {
        const resp = await run([LOGIN, 'A1 STATUS INBOX (MESSAGES)', 'A2 SELECT INBOX', 'A3 STATUS INBOX (MESSAGES)', 'A4 STATUS Parent/Child (MESSAGES)']);
        assert.match(resp, /^A1 OK Status completed\r$/m);
        assert.match(resp, /^\* STATUS INBOX \(MESSAGES 3\)\r\nA3 OK \[CLIENTBUG\] /m);
        assert.match(resp, /^A4 OK Status completed\r$/m);
    });

    it('EXPUNGEISSUED when another session expunged messages (RFC 9051 section 7.1)', async () => {
        const open = () =>
            new Promise(resolve => {
                openSession(ctx.server.address().port, session => {
                    const cmd = line => new Promise(done => session.run(line, done));
                    cmd(LOGIN)
                        .then(() => cmd('S1 SELECT INBOX'))
                        .then(() => resolve({ cmd, session }));
                });
            });
        const a = await open();
        const b = await open();
        try {
            await b.cmd('B1 STORE 2 +FLAGS.SILENT (\\Deleted)');
            await b.cmd('B2 EXPUNGE');

            // the EXPUNGE response must wait (RFC 3501 section 7.4.1), the code tells the client to send NOOP
            assert.match(await a.cmd('A1 FETCH 1:3 FLAGS'), /^A1 OK \[EXPUNGEISSUED\] /m);
            assert.match(await a.cmd('A2 SEARCH ALL'), /^\* SEARCH 1 2 3\r\nA2 OK \[EXPUNGEISSUED\] /m);
            assert.match(await a.cmd('A3 STORE 1 +FLAGS (\\Seen)'), /^A3 OK \[EXPUNGEISSUED\] /m);
            // RFC 2180 section 4.2.2: STORE on the expunged message itself fails
            assert.match(await a.cmd('A3 STORE 2 +FLAGS (\\Seen)'), /^A3 NO \[EXPUNGEISSUED\] /m);
            // UID commands deliver the EXPUNGE
            const output = await a.cmd('A4 UID FETCH 1 FLAGS');
            assert.match(output, /^\* 2 EXPUNGE\r$/m);
            assert.match(output, /^A4 OK [^[]/m);
            assert.match(await a.cmd('A5 FETCH 1 FLAGS'), /^A5 OK FETCH Completed\r$/m);
        } finally {
            a.session.close();
            b.session.close();
        }
    });
});
