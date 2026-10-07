'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer, assertTagged } = require('./helpers');

// Mailbox names that are not atoms must be sent as strings: "\" is a quoted-special, and an atom
// NIL would be read back as NIL, not as a mailbox name (RFC 3501 section 9, mailbox = "INBOX" / astring)
describe('mailbox names that are not atoms', () => {
    const ctx = setupServer(() => ({
        plugins: ['LIST-EXTENDED', 'LIST-STATUS', 'NAMESPACE', 'METADATA', 'QUOTA', 'ACL', 'MULTISEARCH', 'OBJECTID'],
        storage: {
            INBOX: {},
            '': {
                folders: {
                    '\\Back': { messages: ['Subject: a\r\n\r\na'] },
                    NIL: { messages: ['Subject: b\r\n\r\nb'] }
                }
            },
            '\\Shared/': { type: 'shared', separator: '/', folders: { list: {} } }
        }
    }));

    const run = (commands, callback) => ctx.run(['A1 LOGIN testuser testpass', ...commands, 'ZZ LOGOUT'], resp => callback(resp.toString('binary')));

    it('quotes them in every response', (t, done) => {
        run(
            [
                'A2 LIST "" *',
                'A3 LSUB "" *',
                'A4 STATUS "\\\\Back" (MESSAGES)',
                'A5 STATUS "NIL" (MESSAGES)',
                'A6 LIST (SUBSCRIBED) "" "*" RETURN (STATUS (MESSAGES))',
                'A7 NAMESPACE',
                'A8 SETMETADATA "\\\\Back" (/private/comment "x")',
                'A9 GETMETADATA "\\\\Back" /private/comment',
                'A10 GETQUOTAROOT "NIL"',
                'A11 GETACL "\\\\Back"',
                'A12 MYRIGHTS "NIL"',
                'A13 LISTRIGHTS "\\\\Back" anyone',
                'A14 ESEARCH IN (mailboxes ("\\\\Back" "NIL")) ALL',
                'A15 LIST "\\\\Shared/" "*"'
            ],
            resp => {
                assertTagged(resp, {
                    A2: 'OK',
                    A3: 'OK',
                    A4: 'OK',
                    A5: 'OK',
                    A6: 'OK',
                    A7: 'OK',
                    A8: 'OK',
                    A9: 'OK',
                    A10: 'OK',
                    A11: 'OK',
                    A12: 'OK',
                    A13: 'OK',
                    A14: 'OK',
                    A15: 'OK'
                });
                for (const command of ['LIST', 'LSUB']) {
                    assert.match(resp, new RegExp('^\\* ' + command + ' \\([^)]*\\) "/" "\\\\\\\\Back"\\r$', 'm'));
                    assert.match(resp, new RegExp('^\\* ' + command + ' \\([^)]*\\) "/" "NIL"\\r$', 'm'));
                }
                assert.match(resp, /^\* LIST \([^)]*\) "\/" "\\\\Shared\/list"\r$/m);
                assert.match(resp, /^\* STATUS "\\\\Back" \(MESSAGES 1\)\r$/m);
                assert.match(resp, /^\* STATUS "NIL" \(MESSAGES 1\)\r$/m);
                assert.match(resp, /^\* NAMESPACE \(\("" "\/"\)\) NIL \(\("\\\\Shared\/" "\/"\)\)\r$/m);
                assert.match(resp, /^\* METADATA "\\\\Back" \(\/private\/comment "x"\)\r$/m);
                assert.match(resp, /^\* QUOTAROOT "NIL" /m);
                assert.match(resp, /^\* ACL "\\\\Back" /m);
                assert.match(resp, /^\* MYRIGHTS "NIL" /m);
                assert.match(resp, /^\* LISTRIGHTS "\\\\Back" /m);
                assert.match(resp, /^\* ESEARCH \(TAG "A14" MAILBOX "\\\\Back" UIDVALIDITY \d+\) UID ALL 1\r$/m);
                assert.match(resp, /^\* ESEARCH \(TAG "A14" MAILBOX "NIL" UIDVALIDITY \d+\) UID ALL 1\r$/m);
                done();
            }
        );
    });
});
