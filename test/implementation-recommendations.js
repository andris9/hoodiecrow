'use strict';

// The server side recommendations of RFC 2683 (IMAP4 Implementation Recommendations) that hoodiecrow follows.
// Multi-accessed mailboxes (sections 3.1.1 and 3.4.6, RFC 2180) are covered in test/multi-access.js, RFC822.SIZE
// (section 3.4.5) in test/mime-fidelity.js, CHARSET UTF-8 in SEARCH (section 3.2.3) in test/search.js.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');
const { openSession } = require('./helpers/session');

const message = subject => 'From: sender@example.com\r\nSubject: ' + subject + '\r\n\r\nBody\r\n';

function storage() {
    return {
        INBOX: {
            messages: [
                { raw: message('plain'), uid: 1, internaldate: '14-Sep-2026 21:22:28 -0700' },
                { raw: message('say "hi" to C:\\temp'), uid: 2 }
            ]
        },
        '': {
            separator: '/',
            folders: {
                Archive: {
                    folders: {
                        2026: { messages: [{ raw: message('old'), uid: 1 }] }
                    }
                }
            }
        }
    };
}

const login = ['A1 LOGIN testuser testpass'];

describe('RFC 2683 implementation recommendations', () => {
    const ctx = setupServer(() => ({ storage: storage() }));

    const run = cmds => new Promise(resolve => ctx.run(cmds, resp => resolve(resp.toString('binary'))));

    const session = () =>
        new Promise(resolve => {
            openSession(ctx.server.address().port, s => {
                const cmd = line => new Promise(done => s.run(line, done));
                cmd('L1 LOGIN testuser testpass').then(() => resolve({ cmd, session: s }));
            });
        });

    it('does not expunge when the client closes the socket without LOGOUT, or logs out (section 3.1.2)', async () => {
        const a = await session();
        await a.cmd('S1 SELECT INBOX');
        await a.cmd('S2 STORE 1 +FLAGS.SILENT (\\Deleted)');
        a.session.close();

        const b = await session();
        await b.cmd('S1 SELECT INBOX');
        await b.cmd('S2 STORE 2 +FLAGS.SILENT (\\Deleted)');
        assert.match(await b.cmd('S3 LOGOUT'), /^\* BYE /m);

        const resp = await run([...login, 'A2 SELECT INBOX', 'A3 FETCH 1:* (UID FLAGS)', 'ZZ LOGOUT']);
        assert.match(resp, /^\* 2 EXISTS\r$/m);
        assert.match(resp, /^\* 1 FETCH \(UID 1 FLAGS \(\\Deleted\)\)\r$/m);
        assert.match(resp, /^\* 2 FETCH \(UID 2 FLAGS \(\\Deleted\)\)\r$/m);
    });

    it('accepts command lines of 8000 octets and more (section 3.2.1.5)', async () => {
        // the client should keep its lines short, but the server should accept at least 8000 octets
        const set = new Array(5000).fill('1').join(',');
        assert.ok(set.length > 8000);
        const resp = await run([...login, 'A2 SELECT INBOX', 'A3 FETCH ' + set + ' (UID)', 'ZZ LOGOUT']);
        assert.match(resp, /^\* 1 FETCH \(UID 1\)\r$/m);
        assert.match(resp, /^A3 OK /m);
    });

    it('sends INTERNALDATE as an IMAP date-time, not an RFC 822 date (section 3.4.1)', async () => {
        const resp = await run([...login, 'A2 EXAMINE INBOX', 'A3 FETCH 1 INTERNALDATE', 'ZZ LOGOUT']);
        assert.match(resp, /^\* 1 FETCH \(INTERNALDATE "14-Sep-2026 21:22:28 -0700"\)\r$/m);
    });

    it('takes and sends double quotes and backslashes escaped in quoted strings (section 3.4.2)', async () => {
        const resp = await run([...login, 'A2 EXAMINE INBOX', 'A3 SEARCH SUBJECT "\\"hi\\" to C:\\\\temp"', 'A4 FETCH 2 ENVELOPE', 'ZZ LOGOUT']);
        assert.match(resp, /^\* SEARCH 2\r$/m);
        assert.match(resp, /^\* 2 FETCH \(ENVELOPE \(NIL "say \\"hi\\" to C:\\\\temp" /m);
    });

    it('keeps UIDs per mailbox and never reuses them (section 3.4.3)', async () => {
        const raw = message('new');
        const resp = await run([
            ...login,
            'A2 SELECT INBOX',
            'A3 STORE 2 +FLAGS.SILENT (\\Deleted)',
            'A4 EXPUNGE',
            'A5 APPEND INBOX {' + raw.length + '}\r\n' + raw,
            'A6 FETCH 1:* (UID)',
            'A7 STATUS Archive/2026 (UIDNEXT)',
            'ZZ LOGOUT'
        ]);
        // the expunged UID 2 is not given to the new message
        assert.match(resp, /^\* 2 FETCH \(UID 3\)\r$/m);
        // UIDs are not unique across mailboxes
        assert.match(resp, /^\* STATUS Archive\/2026 \(UIDNEXT 2\)\r$/m);
    });

    it('treats the reference argument of LIST as the context of the mailbox name (section 3.4.9)', async () => {
        const resp = await run([...login, 'A2 LIST Archive/ %', 'A3 LIST Archive/ 2026', 'A4 LIST "" Archive/%', 'ZZ LOGOUT']);
        assert.match(resp, /^\* LIST \(\\HasNoChildren\) "\/" "?Archive\/2026"?\r\nA2 OK/m);
        assert.match(resp, /^\* LIST \(\\HasNoChildren\) "\/" "?Archive\/2026"?\r\nA3 OK/m);
        assert.match(resp, /^\* LIST \(\\HasNoChildren\) "\/" "?Archive\/2026"?\r\nA4 OK/m);
    });

    it('deletes a mailbox that is not empty (section 3.4.12)', async () => {
        const resp = await run([...login, 'A2 DELETE Archive/2026', 'A3 STATUS Archive/2026 (MESSAGES)', 'ZZ LOGOUT']);
        assert.match(resp, /^A2 OK /m);
        assert.match(resp, /^A3 NO /m);
    });
});
