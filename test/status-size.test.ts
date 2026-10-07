// STATUS=SIZE, RFC 8438 (https://www.rfc-editor.org/rfc/rfc8438.txt), and the IMAP4rev2 DELETED
// status item, RFC 9051 section 6.3.11

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { setupServer } from './helpers/index.js';
import type { IMAPServer } from '../src/server.js';

const LOGIN = 'A1 LOGIN testuser testpass';

const MESSAGES = ['Subject: one\r\n\r\nHello', 'Subject: two\r\n\r\nHello world', 'Subject: three\r\n\r\n\u20ac'];
// RFC822.SIZE counts octets, the last message is UTF-8 encoded
const SIZE = MESSAGES.reduce((size, raw) => size + Buffer.byteLength(raw), 0);

const storage = () => ({
    INBOX: {
        messages: MESSAGES.map((raw, i) => ({ raw, flags: i ? ['\\Deleted'] : [] }))
    },
    '': {
        folders: {
            Empty: {}
        }
    }
});

describe('STATUS=SIZE', () => {
    const ctx = setupServer(() => ({ plugins: ['STATUS=SIZE', 'LIST-STATUS'], storage: storage() }));

    const run = (commands: string[], callback: (resp: string) => void) => ctx.run([LOGIN, ...commands, 'ZZ LOGOUT'], resp => callback(resp.toString('binary')));

    it('advertises the STATUS=SIZE capability', (t, done) => {
        run(['A2 CAPABILITY'], resp => {
            assert.match(resp, /^\* CAPABILITY .*\bSTATUS=SIZE\b/m);
            done();
        });
    });

    it('returns the sum of RFC822.SIZE values (RFC 8438 section 3)', (t, done) => {
        run(['A2 SELECT INBOX', 'A3 FETCH 1:* RFC822.SIZE', 'A4 STATUS INBOX (MESSAGES SIZE)', 'A5 STATUS Empty (size)'], resp => {
            const sizes = [...resp.matchAll(/^\* \d+ FETCH \(RFC822\.SIZE (\d+)\)/gm)].map(match => Number(match[1]));
            assert.strictEqual(
                sizes.reduce((a, b) => a + b, 0),
                SIZE
            );
            assert.match(resp, new RegExp('^\\* STATUS INBOX \\(MESSAGES 3 SIZE ' + SIZE + '\\)\\r\\nA4 OK', 'm'));
            assert.match(resp, /^\* STATUS Empty \(SIZE 0\)\r\nA5 OK/m);
            done();
        });
    });

    it('follows APPEND and EXPUNGE', (t, done) => {
        run(['A2 APPEND Empty {5}\r\nHello', 'A3 STATUS Empty (SIZE)', 'A4 SELECT INBOX', 'A5 EXPUNGE', 'A6 STATUS INBOX (SIZE)'], resp => {
            assert.match(resp, /^\* STATUS Empty \(SIZE 5\)\r\nA3 OK/m);
            assert.match(resp, new RegExp('^\\* STATUS INBOX \\(SIZE ' + Buffer.byteLength(MESSAGES[0]) + '\\)\\r\\nA6 OK', 'm'));
            done();
        });
    });

    it('works as a LIST-STATUS item (RFC 8438 section 3)', (t, done) => {
        run(['A2 LIST "" "%" RETURN (STATUS (MESSAGES SIZE))'], resp => {
            assert.match(resp, new RegExp('^\\* STATUS INBOX \\(MESSAGES 3 SIZE ' + SIZE + '\\)\\r\\n', 'm'));
            assert.match(resp, /^\* STATUS Empty \(MESSAGES 0 SIZE 0\)\r\n/m);
            done();
        });
    });

    it('does not offer the IMAP4rev2 DELETED item (RFC 9051 section 6.3.11)', (t, done) => {
        run(['A2 STATUS INBOX (DELETED)', 'A3 LIST "" "%" RETURN (STATUS (DELETED))'], resp => {
            assert.match(resp, /^A2 BAD /m);
            assert.match(resp, /^A3 BAD /m);
            done();
        });
    });
});

describe('STATUS without STATUS=SIZE', () => {
    const ctx = setupServer(() => ({ storage: storage() }));

    it('rejects SIZE and DELETED', (t, done) => {
        ctx.run([LOGIN, 'A2 CAPABILITY', 'A3 STATUS INBOX (SIZE)', 'A4 STATUS INBOX (DELETED)', 'A5 STATUS Nonexistent (FOO)', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.doesNotMatch(resp, /STATUS=SIZE/);
            assert.match(resp, /^A3 BAD /m);
            assert.match(resp, /^A4 BAD /m);
            // invalid items are BAD even for a mailbox that does not exist
            assert.match(resp, /^A5 BAD /m);
            done();
        });
    });
});

describe('STATUS DELETED turned on by a plugin', () => {
    // what an IMAP4rev2 mode would do
    const rev2 = (server: IMAPServer) => server.allowedStatus.push('DELETED');
    const ctx = setupServer(() => ({ plugins: ['status-size', rev2], storage: storage() }));

    it('counts messages with the \\Deleted flag (RFC 9051 section 6.3.11)', (t, done) => {
        ctx.run([LOGIN, 'A2 STATUS INBOX (DELETED SIZE)', 'A3 STATUS Empty (DELETED)', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, new RegExp('^\\* STATUS INBOX \\(DELETED 2 SIZE ' + SIZE + '\\)\\r\\nA2 OK', 'm'));
            assert.match(resp, /^\* STATUS Empty \(DELETED 0\)\r\nA3 OK/m);
            done();
        });
    });
});
