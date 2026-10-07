// APPENDLIMIT, RFC 7889 (https://www.rfc-editor.org/rfc/rfc7889.txt)

import { describe, it } from 'node:test';
import assert from 'node:assert';
import imapkit from '../src/server.js';
import { setupServer } from './helpers/index.js';
import type { StorageNamespace } from '../src/types.js';

const LOGIN = 'A1 LOGIN testuser testpass';
const literal = (str: string) => '{' + str.length + '}\r\n' + str;
const sized = (n: number) => 'x'.repeat(n);

function storage(limits?: Record<string, number | null>): Record<string, StorageNamespace> {
    limits = limits || {};
    const mailbox = (name: string) => (Object.hasOwn(limits, name) ? { appendLimit: limits![name] } : {});
    return {
        INBOX: Object.assign({ messages: [{ raw: 'Subject: hello\r\n\r\nWorld\r\n', uid: 1 }] }, mailbox('INBOX')),
        '': {
            folders: {
                Small: mailbox('Small'),
                Large: mailbox('Large'),
                Closed: mailbox('Closed')
            }
        }
    };
}

describe('APPENDLIMIT for all mailboxes', () => {
    const ctx = setupServer(() => ({
        plugins: ['APPENDLIMIT', 'UIDPLUS', 'MULTIAPPEND', 'CATENATE', 'REPLACE', 'LITERALPLUS'],
        appendLimit: 20,
        storage: storage()
    }));

    it('is advertised as APPENDLIMIT=<n> (RFC 7889 section 2)', (t, done) => {
        ctx.run(['A1 CAPABILITY', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^\* CAPABILITY .*\bAPPENDLIMIT=20\b/m);
            assert.doesNotMatch(resp, /APPENDLIMIT(?!=)/);
            done();
        });
    });

    it('is reported by STATUS (RFC 7889 section 3.1)', (t, done) => {
        ctx.run([LOGIN, 'A2 STATUS INBOX (MESSAGES APPENDLIMIT)', 'ZZ LOGOUT'], resp => {
            assert.match(resp.toString(), /^\* STATUS INBOX \(MESSAGES 1 APPENDLIMIT 20\)\r\n/m);
            done();
        });
    });

    it('accepts a message at the limit', (t, done) => {
        ctx.run([LOGIN, 'A2 APPEND Small ' + literal(sized(20)), 'ZZ LOGOUT'], resp => {
            assert.match(resp.toString(), /^A2 OK /m);
            done();
        });
    });

    it('refuses a larger literal with TOOBIG before it is sent (RFC 7889 section 4)', (t, done) => {
        ctx.run([LOGIN, 'A2 APPEND Small ' + literal(sized(21)), 'A3 STATUS Small (MESSAGES)', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^A2 NO \[TOOBIG\] /m);
            assert.doesNotMatch(resp, /^\+ /m);
            assert.match(resp, /^\* STATUS Small \(MESSAGES 0\)/m);
            done();
        });
    });

    it('reads a non-synchronizing literal and refuses it with TOOBIG (RFC 7888 section 4)', (t, done) => {
        ctx.run([LOGIN, 'A2 APPEND Small {21+}\r\n' + sized(21), 'A3 NOOP', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^A2 NO \[TOOBIG\] /m);
            assert.match(resp, /^A3 OK /m);
            done();
        });
    });

    it('refuses a later MULTIAPPEND message early and appends nothing', (t, done) => {
        ctx.run([LOGIN, 'A2 APPEND Small ' + literal(sized(5)) + ' (\\Seen) ' + literal(sized(21)), 'A3 STATUS Small (MESSAGES)', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.strictEqual(resp.match(/^\+ /gm).length, 1, resp);
            assert.match(resp, /^A2 NO \[TOOBIG\] /m);
            assert.match(resp, /^\* STATUS Small \(MESSAGES 0\)/m);
            done();
        });
    });

    it('applies to a CATENATE message (RFC 7889 section 4)', (t, done) => {
        const cmds = [
            LOGIN,
            'A2 APPEND Small CATENATE (URL "/INBOX/;UID=1" TEXT {1}\r\nx)',
            'A3 APPEND Small CATENATE (URL "/INBOX/;UID=1" TEXT ' + literal(sized(21)) + ')',
            'A4 APPEND Small CATENATE (URL ' + literal('/INBOX/;UID=1/;PARTIAL=0.5') + ')',
            'ZZ LOGOUT'
        ];
        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.match(resp, /^A2 NO \[TOOBIG\] /m);
            // the TEXT literal alone is too large, so it is refused before it is sent
            assert.match(resp, /^A3 NO \[TOOBIG\] /m);
            // the literal of a URL is not message data
            assert.match(resp, /^A4 OK /m);
            assert.strictEqual(resp.match(/^\+ /gm).length, 2, resp);
            done();
        });
    });

    it('applies to REPLACE and keeps the old message', (t, done) => {
        ctx.run(
            [
                LOGIN,
                'A2 SELECT INBOX',
                'A3 REPLACE 1 INBOX ' + literal(sized(21)),
                'A4 UID REPLACE 1 INBOX {21+}\r\n' + sized(21),
                'A5 FETCH 1 UID',
                'ZZ LOGOUT'
            ],
            resp => {
                resp = resp.toString();
                assert.match(resp, /^A3 NO \[TOOBIG\] /m);
                assert.match(resp, /^A4 NO \[TOOBIG\] /m);
                assert.match(resp, /^\* 1 FETCH \(UID 1\)/m);
                done();
            }
        );
    });

    it('does not apply to a literal mailbox name', (t, done) => {
        ctx.run([LOGIN, 'A2 APPEND ' + literal('Small') + ' ' + literal(sized(3)), 'ZZ LOGOUT'], resp => {
            assert.match(resp.toString(), /^A2 OK /m);
            done();
        });
    });
});

describe('APPENDLIMIT per mailbox', () => {
    const ctx = setupServer(() => ({ plugins: ['APPENDLIMIT'], appendLimit: 100, storage: storage({ Small: 10, Large: null, Closed: 0 }) }));

    it('is advertised without a value (RFC 7889 section 2)', (t, done) => {
        ctx.run(['A1 CAPABILITY', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^\* CAPABILITY .*\bAPPENDLIMIT\b(?!=)/m);
            assert.doesNotMatch(resp, /APPENDLIMIT=/);
            done();
        });
    });

    it('reports each limit with STATUS, NIL for no limit (RFC 7889 sections 3 and 5)', (t, done) => {
        const cmds = [
            LOGIN,
            'A2 STATUS INBOX (APPENDLIMIT)',
            'A3 STATUS Small (APPENDLIMIT)',
            'A4 STATUS Large (APPENDLIMIT)',
            'A5 STATUS Closed (APPENDLIMIT)',
            'A6 CREATE New',
            'A7 STATUS New (APPENDLIMIT)',
            'ZZ LOGOUT'
        ];
        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.match(resp, /^\* STATUS INBOX \(APPENDLIMIT 100\)/m);
            assert.match(resp, /^\* STATUS Small \(APPENDLIMIT 10\)/m);
            assert.match(resp, /^\* STATUS Large \(APPENDLIMIT NIL\)/m);
            assert.match(resp, /^\* STATUS Closed \(APPENDLIMIT 0\)/m);
            assert.match(resp, /^\* STATUS New \(APPENDLIMIT 100\)/m);
            done();
        });
    });

    it('applies the limit of the target mailbox', (t, done) => {
        const cmds = [
            LOGIN,
            'A2 APPEND Small ' + literal(sized(11)),
            'A3 APPEND INBOX ' + literal(sized(11)),
            'A4 APPEND Large ' + literal(sized(200)),
            'ZZ LOGOUT'
        ];
        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.match(resp, /^A2 NO \[TOOBIG\] /m);
            assert.match(resp, /^A3 OK /m);
            assert.match(resp, /^A4 OK /m);
            done();
        });
    });

    it('accepts nothing with a limit of 0 (RFC 7889 section 5)', (t, done) => {
        ctx.run([LOGIN, 'A2 APPEND Closed ' + literal(sized(1)), 'A3 APPEND Closed {0}\r\n', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^A2 NO \[TOOBIG\] /m);
            assert.match(resp, /^A3 NO \[TOOBIG\] /m);
            done();
        });
    });
});

describe('APPENDLIMIT with LIST-STATUS', () => {
    const ctx = setupServer(() => ({ plugins: ['APPENDLIMIT', 'LIST-STATUS'], appendLimit: 100, storage: storage({ Small: 10 }) }));

    it('reports the limits in LIST RETURN (STATUS (APPENDLIMIT)) (RFC 7889 section 3.2)', (t, done) => {
        ctx.run([LOGIN, 'A2 LIST "" "*" RETURN (STATUS (APPENDLIMIT))', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^\* STATUS INBOX \(APPENDLIMIT 100\)/m);
            assert.match(resp, /^\* STATUS Small \(APPENDLIMIT 10\)/m);
            assert.match(resp, /^A2 OK /m);
            done();
        });
    });
});

describe('APPENDLIMIT without a server limit', () => {
    const ctx = setupServer(() => ({ plugins: ['APPENDLIMIT'], storage: storage() }));

    it('is advertised without a value and STATUS returns NIL', (t, done) => {
        ctx.run(['A1 CAPABILITY', LOGIN.replace('A1', 'A2'), 'A3 STATUS INBOX (APPENDLIMIT)', 'A4 APPEND INBOX ' + literal(sized(500)), 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^\* CAPABILITY .*\bAPPENDLIMIT\r\n/m);
            assert.match(resp, /^\* STATUS INBOX \(APPENDLIMIT NIL\)/m);
            assert.match(resp, /^A4 OK /m);
            done();
        });
    });
});

describe('Without APPENDLIMIT', () => {
    const ctx = setupServer(() => ({ storage: storage(), appendLimit: 10 }));

    it('STATUS APPENDLIMIT is unknown and nothing is limited', (t, done) => {
        ctx.run([LOGIN, 'A2 STATUS INBOX (APPENDLIMIT)', 'A3 APPEND INBOX ' + literal(sized(11)), 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^A2 BAD /m);
            assert.match(resp, /^A3 OK /m);
            done();
        });
    });
});

describe('APPENDLIMIT options', () => {
    it('refuses an invalid appendLimit option', () => {
        for (const appendLimit of [-1, 1.5, '100', NaN]) {
            assert.throws(() => imapkit({ plugins: ['APPENDLIMIT'], appendLimit }), /appendLimit/);
        }
    });
});
