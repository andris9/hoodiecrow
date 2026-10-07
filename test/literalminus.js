'use strict';

// LITERAL-, RFC 7888 (https://www.rfc-editor.org/rfc/rfc7888.txt)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const imapkit = require('../lib/server');
const { setupServer } = require('./helpers');
const { openSession } = require('./helpers/session');

const message = size => {
    const header = 'Subject: test\r\n\r\n';
    return header + 'x'.repeat(size - header.length);
};

describe('LITERAL-', () => {
    const ctx = setupServer(() => ({ plugins: ['LITERAL-'], storage: { INBOX: {}, '': {} } }));

    it('is advertised instead of LITERAL+', (t, done) => {
        ctx.run(['A1 CAPABILITY'], resp => {
            resp = resp.toString('binary');
            assert.match(resp, /^\* CAPABILITY .*LITERAL-/m);
            assert.doesNotMatch(resp, /LITERAL\+/);
            done();
        });
    });

    // RFC 7888 section 3: no continuation request for a non-synchronizing literal
    it('accepts non-synchronizing literals up to 4096 octets', (t, done) => {
        ctx.run(['A1 LOGIN {8+}\r\ntestuser {8+}\r\ntestpass', 'A2 APPEND INBOX {4096+}\r\n' + message(4096), 'A3 STATUS INBOX (MESSAGES)'], resp => {
            resp = resp.toString('binary');
            assert.doesNotMatch(resp, /^\+ /m);
            assert.match(resp, /^A1 OK /m);
            assert.match(resp, /^A2 OK /m);
            assert.match(resp, /^\* STATUS INBOX \(MESSAGES 1\)$/m);
            done();
        });
    });

    it('accepts larger synchronizing literals', (t, done) => {
        ctx.run(['A1 LOGIN testuser testpass', 'A2 APPEND INBOX {5000}\r\n' + message(5000)], resp => {
            resp = resp.toString('binary');
            assert.match(resp, /^\+ /m);
            assert.match(resp, /^A2 OK /m);
            done();
        });
    });

    // RFC 7888 sections 4 and 5: the server reads the literal and rejects the command, for APPEND the
    // BAD response MUST contain TOOBIG
    it('refuses a larger non-synchronizing literal with BAD [TOOBIG] and reads past it', (t, done) => {
        openSession(ctx.server.address().port, session => {
            session.run('A1 LOGIN testuser testpass', () => {
                // a second literal of the same command, and a command right after it
                session.run(
                    'A2 APPEND INBOX {4097+}\r\n' + message(4097) + ' {3+}\r\nabc\r\nA3 STATUS INBOX (MESSAGES)',
                    resp => {
                        assert.match(resp, /^A2 BAD \[TOOBIG\] /m);
                        assert.doesNotMatch(resp, /^\+ /m);
                        assert.match(resp, /^\* STATUS INBOX \(MESSAGES 0\)$/m);
                        assert.match(resp, /^A3 OK /m);
                        session.close();
                        done();
                    },
                    'A3'
                );
            });
        });
    });

    it('refuses a larger non-synchronizing literal before login', (t, done) => {
        ctx.run(['A1 LOGIN {5000+}\r\n' + 'x'.repeat(5000) + ' testpass', 'A2 LOGIN testuser testpass'], resp => {
            resp = resp.toString('binary');
            assert.match(resp, /^A1 BAD \[TOOBIG\] /m);
            assert.match(resp, /^A2 OK /m);
            done();
        });
    });

    // the client waits for a continuation request that never comes, the next command is a new one
    it('does not ask for a synchronizing literal of a refused command', (t, done) => {
        openSession(ctx.server.address().port, session => {
            session.run('A1 LOGIN testuser testpass', () => {
                session.raw('A2 APPEND INBOX {4097+}\r\n' + message(4097) + ' {3}\r\n');
                session.run(
                    'A3 NOOP',
                    resp => {
                        assert.match(resp, /^A2 BAD \[TOOBIG\] /m);
                        assert.doesNotMatch(resp, /^\+ /m);
                        assert.match(resp, /^A3 OK /m);
                        session.close();
                        done();
                    },
                    'A3'
                );
            });
        });
    });

    // RFC 7888 section 5: a BYE for a literal that is too large SHOULD include TOOBIG
    it('closes the connection with BYE [TOOBIG] for a literal over the size limit', (t, done) => {
        ctx.run(['A1 LOGIN testuser {70000+}\r\n' + 'x'.repeat(70000)], resp => {
            assert.match(resp.toString('binary'), /^\* BYE \[TOOBIG\] /m);
            done();
        });
    });
});

describe('LITERAL+ and LITERAL-', () => {
    // RFC 7888 section 5: servers MUST NOT advertise both
    it('can not be loaded together', () => {
        assert.throws(() => imapkit({ plugins: ['LITERAL+', 'LITERAL-'] }), /LITERAL/);
        assert.throws(() => imapkit({ plugins: ['LITERALMINUS', 'LITERALPLUS'] }), /LITERAL/);
    });
});
