'use strict';

// REPLACE, RFC 8508 (https://www.rfc-editor.org/rfc/rfc8508.txt)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');
const { openSession } = require('./helpers/session');

const msg = n => 'Subject: message ' + n + '\r\n\r\nBody ' + n + '\r\n';
const literal = str => '{' + str.length + '}\r\n' + str;

function storage() {
    return {
        INBOX: {
            messages: [1, 2, 3].map(n => ({ raw: msg(n), uid: n, flags: ['\\Draft', '$Old'] }))
        },
        '': {
            folders: {
                Sent: {}
            }
        }
    };
}

const LOGIN = 'A1 LOGIN testuser testpass';
const SELECT = 'A2 SELECT INBOX';

describe('REPLACE', () => {
    const ctx = setupServer(() => ({ plugins: ['REPLACE', 'UIDPLUS', 'MULTIAPPEND', 'CATENATE'], storage: storage() }));

    it('is advertised', (t, done) => {
        ctx.run(['A1 CAPABILITY', 'ZZ LOGOUT'], resp => {
            assert.match(resp.toString(), /^\* CAPABILITY .*\bREPLACE\b/m);
            done();
        });
    });

    it('appends the new message and expunges the old one (RFC 8508 sections 3.2 and 4.3)', (t, done) => {
        const cmds = [LOGIN, SELECT, 'A3 REPLACE 2 INBOX (\\Seen) ' + literal(msg(4)), 'A4 FETCH 1:* (UID FLAGS)', 'ZZ LOGOUT'];
        ctx.run(cmds, resp => {
            resp = resp.toString();
            // APPENDUID in an untagged OK before the EXISTS and EXPUNGE responses, like the example in section 3.2
            assert.match(resp, /^\+ Go ahead\r\n\* OK \[APPENDUID 1 4\] [^\r\n]+\r\n\* 4 EXISTS\r\n\* 2 EXPUNGE\r\nA3 OK [^\r\n]+\r\n/m);
            // no flags are inherited from the replaced message (RFC 8508 section 1)
            assert.match(
                resp,
                /^\* 1 FETCH \(UID 1 FLAGS \(\\Draft \$Old\)\)\r\n\* 2 FETCH \(UID 3 FLAGS \(\\Draft \$Old\)\)\r\n\* 3 FETCH \(UID 4 FLAGS \(\\Seen \\Recent\)\)\r\n/m
            );
            done();
        });
    });

    it('UID REPLACE takes a UID (RFC 8508 section 3.3)', (t, done) => {
        const cmds = [LOGIN, SELECT, 'A3 UID REPLACE 3 INBOX ' + literal(msg(4)), 'A4 UID FETCH 1:* UID', 'ZZ LOGOUT'];
        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.match(resp, /^\* OK \[APPENDUID 1 4\] [^\r\n]+\r\n\* 4 EXISTS\r\n\* 3 EXPUNGE\r\nA3 OK /m);
            assert.match(resp, /^\* 1 FETCH \(UID 1\)\r\n\* 2 FETCH \(UID 2\)\r\n\* 3 FETCH \(UID 4\)\r\n/m);
            done();
        });
    });

    it('accepts "*" as the last message (RFC 3501 section 9, seq-number)', (t, done) => {
        ctx.run([LOGIN, SELECT, 'A3 REPLACE * INBOX ' + literal(msg(4)), 'A4 UID REPLACE * INBOX ' + literal(msg(5)), 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^\* 3 EXPUNGE\r\nA3 OK /m);
            assert.match(resp, /^\* 3 EXPUNGE\r\nA4 OK /m);
            done();
        });
    });

    it('can replace into another mailbox (RFC 8508 section 3.4)', (t, done) => {
        const cmds = [LOGIN, SELECT, 'A3 REPLACE 1 Sent ' + literal(msg(4)), 'A4 STATUS Sent (MESSAGES)', 'ZZ LOGOUT'];
        ctx.run(cmds, resp => {
            resp = resp.toString();
            // no EXISTS for the selected mailbox, the count shrinks by the EXPUNGE
            assert.match(resp, /^\* OK \[APPENDUID 1 1\] [^\r\n]+\r\n\* 1 EXPUNGE\r\nA3 OK /m);
            assert.match(resp, /^\* STATUS Sent \(MESSAGES 1\)/m);
            done();
        });
    });

    it('works with CATENATE and a URL of the replaced message (RFC 8508 section 4.2)', (t, done) => {
        const cmds = [
            LOGIN,
            SELECT,
            'A3 UID REPLACE 2 INBOX CATENATE (TEXT {12}\r\nX-New: yes\r\n URL "/INBOX/;UID=2")',
            'A4 UID FETCH 4 BODY.PEEK[]',
            'ZZ LOGOUT'
        ];
        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.match(resp, /^\* 2 EXPUNGE\r\nA3 OK /m);
            assert.ok(resp.indexOf('BODY[] {' + (12 + msg(2).length) + '}\r\nX-New: yes\r\n' + msg(2) + ' UID 4)') >= 0, resp);
            done();
        });
    });

    it('returns BADURL and keeps the old message when a URL fails', (t, done) => {
        ctx.run([LOGIN, SELECT, 'A3 REPLACE 1 INBOX CATENATE (URL "/INBOX/;UID=99")', 'A4 FETCH 1:* UID', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^A3 NO \[BADURL \/INBOX\/;UID=99\] /m);
            assert.doesNotMatch(resp, /EXPUNGE/);
            assert.match(resp, /^\* 3 FETCH \(UID 3\)/m);
            done();
        });
    });

    it('takes a single message even with MULTIAPPEND (RFC 8508 section 4.7)', (t, done) => {
        ctx.run([LOGIN, SELECT, 'A3 REPLACE 1 INBOX ' + literal(msg(4)) + ' ' + literal(msg(5)), 'A4 FETCH 1:* UID', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^A3 BAD /m);
            assert.doesNotMatch(resp, /EXPUNGE|EXISTS\r\nA3/);
            done();
        });
    });

    it('keeps the old message when the new one is refused (RFC 8508 section 3.4)', (t, done) => {
        const cmds = [
            LOGIN,
            SELECT,
            'A3 REPLACE 1 Missing ' + literal(msg(4)),
            'A4 REPLACE 1 INBOX {0}\r\n',
            'A5 REPLACE 1 INBOX (\\Recent) ' + literal(msg(4)),
            'A6 FETCH 1:* UID',
            'ZZ LOGOUT'
        ];
        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.match(resp, /^A3 NO \[TRYCREATE\] /m);
            // a zero-length message is a NO with MULTIAPPEND (RFC 3502 section 6.3.11)
            assert.match(resp, /^A4 NO /m);
            assert.match(resp, /^A5 BAD /m);
            assert.doesNotMatch(resp, /EXPUNGE/);
            assert.match(resp, /^\* 3 FETCH \(UID 3\)/m);
            done();
        });
    });

    it('refuses a sequence number past the last message with BAD before the literal (RFC 3501 section 9)', (t, done) => {
        ctx.run([LOGIN, SELECT, 'A3 REPLACE 4 INBOX ' + literal(msg(4)), 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^A3 BAD /m);
            assert.doesNotMatch(resp, /^\+ /m);
            done();
        });
    });

    it('refuses a UID that does not exist with NO before the literal (RFC 8508 section 3.2)', (t, done) => {
        ctx.run([LOGIN, SELECT, 'A3 UID REPLACE 9 INBOX ' + literal(msg(4)), 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^A3 NO /m);
            assert.doesNotMatch(resp, /^\+ /m);
            done();
        });
    });

    it('refuses a missing message without a literal as well', (t, done) => {
        ctx.run(
            [LOGIN, SELECT, 'A3 REPLACE 9 INBOX CATENATE (URL "/INBOX/;UID=1")', 'A4 UID REPLACE 9 INBOX CATENATE (URL "/INBOX/;UID=1")', 'ZZ LOGOUT'],
            resp => {
                resp = resp.toString();
                assert.match(resp, /^A3 BAD /m);
                assert.match(resp, /^A4 NO /m);
                done();
            }
        );
    });

    it('refuses a read-only mailbox with NO', (t, done) => {
        ctx.run([LOGIN, 'A2 EXAMINE INBOX', 'A3 REPLACE 1 INBOX ' + literal(msg(4)), 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^A3 NO \[CLIENTBUG\] /m);
            assert.doesNotMatch(resp, /^\+ /m);
            assert.doesNotMatch(resp, /EXPUNGE/);
            done();
        });
    });

    it('is only valid in the selected state (RFC 8508 section 3.5)', (t, done) => {
        ctx.run([LOGIN, 'A3 REPLACE 1 INBOX ' + literal(msg(4)), 'A4 UID REPLACE 1 INBOX ' + literal(msg(4)), 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^A3 BAD /m);
            assert.match(resp, /^A4 BAD /m);
            assert.doesNotMatch(resp, /^\+ /m);
            done();
        });
    });

    const BAD_SYNTAX = [
        ['a sequence set', 'REPLACE 1:2 INBOX {3}\r\nabc'],
        ['sequence number 0', 'REPLACE 0 INBOX {3}\r\nabc'],
        // RFC 3501 section 9: nz-number is a 32-bit value
        ['a UID above 2^32-1', 'UID REPLACE 4294967296 INBOX {3}\r\nabc'],
        ['no mailbox', 'REPLACE 1'],
        ['no message', 'REPLACE 1 INBOX'],
        ['an invalid mailbox name', 'REPLACE 1 "&Jjo!" {3}\r\nabc']
    ];
    for (const [description, command] of BAD_SYNTAX) {
        it('refuses ' + description + ' with BAD', (t, done) => {
            ctx.run([LOGIN, SELECT, 'A3 ' + command, 'ZZ LOGOUT'], resp => {
                assert.match(resp.toString(), /^A3 BAD /m);
                done();
            });
        });
    }

    it('another session sees the new message and the EXPUNGE', (t, done) => {
        openSession(ctx.server.address().port, a => {
            a.run('S1 LOGIN testuser testpass', () => {
                a.run('S2 SELECT INBOX', () => {
                    ctx.run([LOGIN, SELECT, 'A3 REPLACE 1 INBOX ' + literal(msg(4)), 'ZZ LOGOUT'], () => {
                        a.run('S3 NOOP', output => {
                            a.close();
                            assert.match(output, /^\* 4 EXISTS\r\n\* 1 EXPUNGE\r\n/m);
                            done();
                        });
                    });
                });
            });
        });
    });

    it('is ambiguous when pipelined after a command that is not FETCH, STORE or SEARCH (RFC 3501 section 5.5)', (t, done) => {
        openSession(ctx.server.address().port, session => {
            session.run('S1 LOGIN testuser testpass', () => {
                session.run('S2 SELECT INBOX', () => {
                    session.run(
                        'S3 NOOP\r\nS4 REPLACE 1 INBOX ()',
                        output => {
                            session.close();
                            assert.match(output, /^S4 BAD Commands with message sequence numbers must wait/m);
                            done();
                        },
                        'S4'
                    );
                });
            });
        });
    });
});

describe('REPLACE without UIDPLUS', () => {
    const ctx = setupServer(() => ({ plugins: ['REPLACE'], storage: storage() }));

    it('sends no APPENDUID', (t, done) => {
        ctx.run([LOGIN, SELECT, 'A3 REPLACE 1 INBOX ' + literal(msg(4)), 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.doesNotMatch(resp, /APPENDUID|^\* OK Replacement/m);
            assert.match(resp, /^\* 4 EXISTS\r\n\* 1 EXPUNGE\r\nA3 OK /m);
            done();
        });
    });

    it('accepts a zero-length message without MULTIAPPEND', (t, done) => {
        ctx.run([LOGIN, SELECT, 'A3 REPLACE 1 INBOX {0}\r\n', 'ZZ LOGOUT'], resp => {
            assert.match(resp.toString(), /^A3 OK /m);
            done();
        });
    });
});

describe('REPLACE with CONDSTORE', () => {
    const ctx = setupServer(() => ({ plugins: ['REPLACE', 'CONDSTORE'], storage: storage() }));

    // RFC 8508 section 4.5: the replaced message is removed as if with UID EXPUNGE
    it('raises HIGHESTMODSEQ', (t, done) => {
        ctx.run(
            [
                LOGIN,
                'A2 STATUS INBOX (HIGHESTMODSEQ)',
                'A3 SELECT INBOX',
                'A4 REPLACE 1 INBOX ' + literal(msg(4)),
                'A5 STATUS INBOX (HIGHESTMODSEQ)',
                'ZZ LOGOUT'
            ],
            resp => {
                resp = resp.toString();
                const values = [...resp.matchAll(/^\* STATUS INBOX \(HIGHESTMODSEQ (\d+)\)/gm)].map(match => Number(match[1]));
                assert.strictEqual(values.length, 2, resp);
                assert.ok(values[1] > values[0], resp);
                done();
            }
        );
    });
});
