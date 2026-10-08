// MULTIAPPEND, RFC 3502 (https://www.rfc-editor.org/rfc/rfc3502.txt), and the APPENDUID uid-set of
// RFC 4315 section 3

import { describe, it } from 'node:test';
import assert from 'node:assert';
import net from 'node:net';
import { setupServer } from './helpers/index.js';
import { openSession } from './helpers/session.js';

const msg = (n: number) => 'Subject: message ' + n + '\r\n\r\nBody ' + n + '\r\n';
const literal = (str: string) => '{' + str.length + '}\r\n' + str;

function storage() {
    return {
        INBOX: {
            messages: [{ raw: msg(1), uid: 1 }]
        },
        '': {
            folders: {
                Target: {}
            }
        }
    };
}

describe('MULTIAPPEND', () => {
    const ctx = setupServer(() => ({ plugins: ['MULTIAPPEND', 'UIDPLUS'], storage: storage() }));

    it('is advertised', (t, done) => {
        ctx.run(['A1 CAPABILITY', 'ZZ LOGOUT'], resp => {
            assert.match(resp.toString(), /^\* CAPABILITY .*\bMULTIAPPEND\b/m);
            done();
        });
    });

    it('appends several messages with their own flags and dates, APPENDUID has a UID set (RFC 3502, RFC 4315 section 3)', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 APPEND Target (\\Seen) ' + literal(msg(2)) + ' (\\Flagged $Label) " 7-Feb-1994 22:43:04 -0800" ' + literal(msg(3)) + ' ' + literal(msg(4)),
            'A3 SELECT Target',
            'A4 FETCH 1:* (UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (Subject)])',
            'ZZ LOGOUT'
        ];
        ctx.run(cmds, resp => {
            resp = resp.toString();
            // every synchronizing literal gets its own continuation request (RFC 3501 section 4.3)
            assert.strictEqual(resp.match(/^\+ /gm).length, 3, resp);
            assert.match(resp, /^A2 OK \[APPENDUID 1 1:3\] /m);
            assert.match(resp, /^\* 1 FETCH \(UID 1 FLAGS \(\\Seen \\Recent\) /m);
            assert.match(resp, /^\* 2 FETCH \(UID 2 FLAGS \(\\Flagged \$Label \\Recent\) INTERNALDATE " 7-Feb-1994 22:43:04 -0800" /m);
            assert.match(resp, /^\* 3 FETCH \(UID 3 FLAGS \(\\Recent\) /m);
            assert.ok(resp.indexOf('Subject: message 2\r\n') < resp.indexOf('Subject: message 3\r\n'), resp);
            assert.ok(resp.indexOf('Subject: message 3\r\n') < resp.indexOf('Subject: message 4\r\n'), resp);
            done();
        });
    });

    it('sends a single UID for a single message (RFC 4315 section 3)', (t, done) => {
        ctx.run(['A1 LOGIN testuser testpass', 'A2 APPEND Target ' + literal(msg(2)), 'ZZ LOGOUT'], resp => {
            assert.match(resp.toString(), /^A2 OK \[APPENDUID 1 1\] /m);
            done();
        });
    });

    it('sends EXISTS to the session that has the mailbox selected', (t, done) => {
        ctx.run(['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 APPEND INBOX ' + literal(msg(2)) + ' ' + literal(msg(3)), 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^\* 2 EXISTS\r\n\* 3 EXISTS\r\n\* 2 RECENT\r\nA3 OK \[APPENDUID 1 2:3\] /m);
            done();
        });
    });

    it('a zero-length literal cancels the whole APPEND with NO (RFC 3502 section 6.3.11)', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 APPEND Target ' + literal(msg(2)) + ' {0}\r\n', 'A3 STATUS Target (MESSAGES UIDNEXT)', 'ZZ LOGOUT'];
        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.match(resp, /^A2 NO /m);
            assert.match(resp, /^\* STATUS Target \(MESSAGES 0 UIDNEXT 1\)/m);
            done();
        });
    });

    it('stores nothing when a later message breaks the grammar', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 APPEND Target ' + literal(msg(2)) + ' (\\Recent) ' + literal(msg(3)),
            'A3 STATUS Target (MESSAGES)',
            'ZZ LOGOUT'
        ];
        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.match(resp, /^A2 BAD /m);
            assert.match(resp, /^\* STATUS Target \(MESSAGES 0\)/m);
            done();
        });
    });

    it('refuses a date-time that is not followed by a message', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 APPEND Target ' + literal(msg(2)) + ' "07-Feb-1994 22:43:04 -0800"',
            'A3 STATUS Target (MESSAGES)',
            'ZZ LOGOUT'
        ];
        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.match(resp, /^A2 BAD /m);
            assert.match(resp, /^\* STATUS Target \(MESSAGES 0\)/m);
            done();
        });
    });

    it('returns TRYCREATE for a missing mailbox', (t, done) => {
        ctx.run(['A1 LOGIN testuser testpass', 'A2 APPEND Missing ' + literal(msg(2)) + ' ' + literal(msg(3)), 'ZZ LOGOUT'], resp => {
            assert.match(resp.toString(), /^A2 NO \[TRYCREATE\] /m);
            done();
        });
    });

    it('refuses the data of the second literal sent before the continuation request (RFC 3501 section 4.3)', (t, done) => {
        const socket = net.connect(ctx.port, 'localhost');
        let resp = '';
        let step = 0;
        socket.on('data', chunk => {
            resp += chunk.toString('binary');
            if (step === 0 && /^\* OK/m.test(resp)) {
                step = 1;
                socket.write('A1 LOGIN testuser testpass\r\n');
            } else if (step === 1 && /^A1 OK/m.test(resp)) {
                step = 2;
                socket.write('A2 APPEND Target {3}\r\n');
            } else if (step === 2 && /^\+ /m.test(resp)) {
                step = 3;
                // the second literal follows without waiting for its "+"
                socket.write('abc {3}\r\ndef\r\nA3 STATUS Target (MESSAGES)\r\nA4 LOGOUT\r\n');
            }
        });
        socket.on('close', () => {
            assert.match(resp, /^A2 BAD /m);
            assert.match(resp, /^\* STATUS Target \(MESSAGES 0\)/m);
            done();
        });
    });

    it('another session that has the mailbox selected gets EXISTS for every message', (t, done) => {
        openSession(ctx.port, a => {
            a.run('S1 LOGIN testuser testpass', () => {
                a.run('S2 SELECT Target', () => {
                    ctx.run(['A1 LOGIN testuser testpass', 'A2 APPEND Target ' + literal(msg(2)) + ' ' + literal(msg(3)), 'ZZ LOGOUT'], () => {
                        a.run('S3 NOOP', output => {
                            a.close();
                            // one EXISTS per message, the last one has the final count (RFC 3501 section 7.3.1)
                            assert.match(output, /^\* 2 EXISTS\r\n/m);
                            done();
                        });
                    });
                });
            });
        });
    });
});

describe('MULTIAPPEND with LITERAL+', () => {
    const ctx = setupServer(() => ({ plugins: ['MULTIAPPEND', 'LITERALPLUS'], storage: storage() }));

    it('accepts non-synchronizing literals for every message', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 APPEND Target {' + msg(2).length + '+}\r\n' + msg(2) + ' {' + msg(3).length + '+}\r\n' + msg(3),
            'A3 STATUS Target (MESSAGES)',
            'ZZ LOGOUT'
        ];
        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('+ ') < 0, resp);
            // no UIDPLUS, so no APPENDUID
            assert.match(resp, /^A2 OK APPEND/m);
            assert.match(resp, /^\* STATUS Target \(MESSAGES 2\)/m);
            done();
        });
    });
});

describe('APPEND without MULTIAPPEND', () => {
    const ctx = setupServer(() => ({ plugins: ['UIDPLUS'], storage: storage() }));

    it('takes a single message (RFC 4466 section 3)', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 APPEND Target ' + literal(msg(2)) + ' ' + literal(msg(3)), 'A3 STATUS Target (MESSAGES)', 'ZZ LOGOUT'];
        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.doesNotMatch(resp, /\bMULTIAPPEND\b/);
            assert.match(resp, /^A2 BAD /m);
            assert.match(resp, /^\* STATUS Target \(MESSAGES 0\)/m);
            done();
        });
    });

    it('accepts a zero-length message', (t, done) => {
        ctx.run(['A1 LOGIN testuser testpass', 'A2 APPEND Target {0}\r\n', 'ZZ LOGOUT'], resp => {
            assert.match(resp.toString(), /^A2 OK \[APPENDUID 1 1\] /m);
            done();
        });
    });
});
