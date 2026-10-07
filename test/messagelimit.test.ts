// MESSAGELIMIT and SAVELIMIT, RFC 9738 (https://www.rfc-editor.org/rfc/rfc9738.txt)

import { describe, it } from 'node:test';
import assert from 'node:assert';
import imapkit from '../src/server.js';
import { setupServer, assertTagged } from './helpers/index.js';
import type { TestContext } from './helpers/index.js';

const message = (n: number) => 'From: sender@example.com\r\nSubject: message ' + n + '\r\nDate: 1 Jan 2024 10:0' + n + ':00 +0000\r\n\r\nBody ' + n + '\r\n';

// INBOX holds UIDs 1 to 6, Archive is empty
function storage() {
    return {
        INBOX: {
            uidvalidity: 42,
            messages: [1, 2, 3, 4, 5, 6].map(uid => ({ raw: message(uid), uid, flags: uid % 2 ? [] : ['\\Seen'] }))
        },
        '': {
            folders: {
                Archive: { uidvalidity: 7 }
            }
        }
    };
}

const LOGIN = 'A1 LOGIN testuser testpass';
const SELECT = 'A2 SELECT INBOX';

// replays commands, the callback gets the transcript as a binary string
const run = (ctx: TestContext, commands: string[], callback: (resp: string) => void) => ctx.run(commands, resp => callback(resp.toString('binary')));

describe('MESSAGELIMIT', () => {
    const ctx = setupServer(() => ({
        plugins: ['MESSAGELIMIT', 'UIDPLUS', 'MOVE', 'ESEARCH', 'SEARCHRES', 'SORT', 'THREAD=REFERENCES', 'MULTIAPPEND', 'PARTIAL', 'QRESYNC', 'UIDONLY'],
        messageLimit: 3,
        storage: storage()
    }));

    it('is advertised with the limit (RFC 9738 section 3)', (t, done) => {
        run(ctx, ['A0 CAPABILITY'], resp => {
            assert.match(resp, /^\* CAPABILITY .*\bMESSAGELIMIT=3\b/m);
            assert.doesNotMatch(resp, /SAVELIMIT/);
            done();
        });
    });

    // section 3.1: the server processes the messages with the highest UIDs and returns the lowest processed UID
    it('limits FETCH and UID FETCH to the highest UIDs, from the highest down', (t, done) => {
        run(ctx, [LOGIN, SELECT, 'A3 FETCH 1:* (FLAGS)', 'A4 UID FETCH 2:6 (FLAGS)', 'A5 UID FETCH 1:3 FLAGS', 'A6 UID FETCH 1:2,5 FLAGS'], resp => {
            assert.match(
                resp,
                /^\* 6 FETCH \(FLAGS \(\\Seen\)\)\r\n\* 5 FETCH \(FLAGS \(\)\)\r\n\* 4 FETCH \(FLAGS \(\\Seen\)\)\r\nA3 OK \[MESSAGELIMIT 3 4\] /m
            );
            assert.match(
                resp,
                /^\* 6 FETCH \(FLAGS \(\\Seen\) UID 6\)\r\n\* 5 FETCH \(FLAGS \(\) UID 5\)\r\n\* 4 FETCH \(FLAGS \(\\Seen\) UID 4\)\r\nA4 OK \[MESSAGELIMIT 3 4\] /m
            );
            assert.doesNotMatch(resp, /^\* [1-3] FETCH \(FLAGS \(\\Seen\)\)\r\n/m);
            // three messages or fewer are not limited
            assert.match(resp, /^\* 1 FETCH \(FLAGS \(\) UID 1\)\r\n\* 2 FETCH .*\r\n\* 3 FETCH .*\r\nA5 OK UID FETCH/m);
            assert.match(resp, /^A6 OK UID FETCH/m);
            done();
        });
    });

    it('lets the client continue below the lowest processed UID', (t, done) => {
        run(ctx, [LOGIN, SELECT, 'A3 UID FETCH 1:* FLAGS', 'A4 UID FETCH 1:3 FLAGS'], resp => {
            assert.match(resp, /^A3 OK \[MESSAGELIMIT 3 4\] /m);
            assert.match(resp, /^\* 1 FETCH/m);
            assert.match(resp, /^A4 OK UID FETCH/m);
            done();
        });
    });

    it('limits STORE and UID STORE', (t, done) => {
        run(ctx, [LOGIN, SELECT, 'A3 UID STORE 1:* +FLAGS (\\Flagged)', 'A4 STORE 1:* +FLAGS.SILENT (\\Answered)', 'A5 UID FETCH 1:3 FLAGS'], resp => {
            assert.match(
                resp,
                /^\* 6 FETCH \(FLAGS \(\\Seen \\Flagged\) UID 6\)\r\n\* 5 FETCH \(FLAGS \(\\Flagged\) UID 5\)\r\n\* 4 FETCH \(FLAGS \(\\Seen \\Flagged\) UID 4\)\r\nA3 OK \[MESSAGELIMIT 3 4\] /m
            );
            assert.match(resp, /^A4 OK \[MESSAGELIMIT 3 4\] /m);
            assert.match(resp, /^\* 1 FETCH \(FLAGS \(\) UID 1\)\r$/m);
            done();
        });
    });

    // section 3.1: COPY is atomic, nothing is copied
    it('refuses COPY and UID COPY of more messages with NO [MESSAGELIMIT n uid]', (t, done) => {
        run(ctx, [LOGIN, SELECT, 'A3 UID COPY 1:* Archive', 'A4 COPY 2:6 Archive', 'A5 STATUS Archive (MESSAGES)', 'A6 UID COPY 4:6 Archive'], resp => {
            assert.match(resp, /^A3 NO \[MESSAGELIMIT 3 4\] /m);
            assert.match(resp, /^A4 NO \[MESSAGELIMIT 3 4\] /m);
            assert.match(resp, /^\* STATUS Archive \(MESSAGES 0\)\r$/m);
            assert.match(resp, /^A6 OK \[COPYUID 7 4,5,6 1,2,3\] /m);
            done();
        });
    });

    // section 3.1: MOVE is not atomic, the client repeats it until there is no MESSAGELIMIT
    it('moves the messages with the highest UIDs with UID MOVE', (t, done) => {
        run(ctx, [LOGIN, SELECT, 'A3 UID MOVE 1:* Archive', 'A4 UID MOVE 1:* Archive'], resp => {
            assert.match(resp, /^\* OK \[COPYUID 7 4,5,6 1,2,3\] .*\r\n\* 6 EXPUNGE\r\n\* 5 EXPUNGE\r\n\* 4 EXPUNGE\r\nA3 OK \[MESSAGELIMIT 3 4\] /m);
            assert.match(resp, /^\* OK \[COPYUID 7 1,2,3 4,5,6\] .*\r\n(\* 1 EXPUNGE\r\n){3}A4 OK Done/m);
            done();
        });
    });

    // section 3.1: UID EXPUNGE counts the \Deleted messages, EXPUNGE and CLOSE MUST NOT be limited
    it('limits UID EXPUNGE to the highest deleted UIDs, not EXPUNGE', (t, done) => {
        run(
            ctx,
            [
                LOGIN,
                SELECT,
                'A3 UID STORE 1:3 +FLAGS.SILENT (\\Deleted)',
                'A4 UID STORE 5:6 +FLAGS.SILENT (\\Deleted)',
                'A5 UID EXPUNGE 1:*',
                'A6 UID SEARCH DELETED',
                'A7 EXPUNGE',
                'A8 UID SEARCH ALL'
            ],
            resp => {
                // the highest deleted UIDs 6, 5 and 3 are expunged in that order, UIDs 1 and 2 stay
                assert.match(resp, /^\* 6 EXPUNGE\r\n\* 5 EXPUNGE\r\n\* 3 EXPUNGE\r\nA5 OK \[MESSAGELIMIT 3 3\] /m);
                assert.match(resp, /^\* SEARCH 1 2\r\nA6 OK/m);
                // EXPUNGE is not limited
                assert.match(resp, /^\* 1 EXPUNGE\r\n\* 1 EXPUNGE\r\nA7 OK EXPUNGE Completed/m);
                assert.match(resp, /^\* SEARCH 4\r\nA8 OK/m);
                done();
            }
        );
    });

    // section 3.1: the number of searched messages counts, not the number of matches
    it('searches the messages with the highest UIDs', (t, done) => {
        run(
            ctx,
            [
                LOGIN,
                SELECT,
                'A3 UID SEARCH SEEN',
                'A4 SEARCH ALL',
                'A5 UID SEARCH UID 1:3 SEEN',
                'A6 UID SEARCH RETURN (COUNT MIN) NOT DELETED',
                'A7 UID SEARCH 2:6'
            ],
            resp => {
                assert.match(resp, /^\* SEARCH 6 4\r\nA3 OK \[MESSAGELIMIT 3 4\] /m);
                assert.match(resp, /^\* SEARCH 6 5 4\r\nA4 OK \[MESSAGELIMIT 3 4\] /m);
                // UID and sequence set keys narrow down the messages that are searched
                assert.match(resp, /^\* SEARCH 2\r\nA5 OK UID SEARCH/m);
                assert.match(resp, /^\* ESEARCH \(TAG "A6"\) UID MIN 4 COUNT 3\r\nA6 OK \[MESSAGELIMIT 3 4\] /m);
                assert.match(resp, /^\* SEARCH 6 5 4\r\nA7 OK \[MESSAGELIMIT 3 4\] /m);
                done();
            }
        );
    });

    // section 3.2
    it('supports the UIDAFTER and UIDBEFORE search keys', (t, done) => {
        run(
            ctx,
            [
                LOGIN,
                SELECT,
                'A3 UID SEARCH UIDAFTER 4',
                'A4 UID SEARCH UIDBEFORE 4',
                'A5 UID SEARCH UIDBEFORE 1',
                'A6 UID SEARCH UIDAFTER 1 UIDBEFORE 6 UNSEEN',
                'A12 UID SEARCH (UIDAFTER 1 UIDBEFORE 5) UNSEEN',
                'A7 UID SEARCH NOT UIDAFTER 2',
                'A8 UID SEARCH UIDAFTER 0',
                'A9 UID SEARCH UIDBEFORE 4294967296',
                'A10 UID SEARCH UIDAFTER',
                'A11 UID SEARCH UIDAFTER 1:2'
            ],
            resp => {
                assert.match(resp, /^\* SEARCH 5 6\r\nA3 OK UID/m);
                assert.match(resp, /^\* SEARCH 1 2 3\r\nA4 OK UID/m);
                assert.match(resp, /^\* SEARCH\r\nA5 OK UID/m);
                // four messages are searched, UIDs 3 to 5 are processed
                assert.match(resp, /^\* SEARCH 5 3\r\nA6 OK \[MESSAGELIMIT 3 3\] /m);
                assert.match(resp, /^\* SEARCH 3\r\nA12 OK UID/m);
                // NOT does not narrow down the searched messages, so the limit applies
                assert.match(resp, /^\* SEARCH\r\nA7 OK \[MESSAGELIMIT 3 4\] /m);
                assertTagged(resp, { A8: 'BAD', A9: 'BAD', A10: 'BAD', A11: 'BAD' });
                done();
            }
        );
    });

    // section 3.4
    it('saves only the processed results with SEARCHRES', (t, done) => {
        run(ctx, [LOGIN, SELECT, 'A3 UID SEARCH RETURN (SAVE) ALL', 'A4 UID FETCH $ FLAGS'], resp => {
            assert.match(resp, /^A3 OK \[MESSAGELIMIT 3 4\] /m);
            assert.match(resp, /^\* 4 FETCH .*\r\n\* 5 FETCH .*\r\n\* 6 FETCH .*\r\nA4 OK UID FETCH/m);
            done();
        });
    });

    // section 3.3
    it('refuses SORT and THREAD of more messages with NO [MESSAGELIMIT n]', (t, done) => {
        run(
            ctx,
            [
                LOGIN,
                SELECT,
                'A3 UID SORT (DATE) UTF-8 ALL',
                'A4 THREAD REFERENCES UTF-8 ALL',
                'A5 UID SORT (REVERSE DATE) UTF-8 UIDAFTER 3',
                'A6 UID THREAD REFERENCES UTF-8 UID 1:2'
            ],
            resp => {
                assert.match(resp, /^A3 NO \[MESSAGELIMIT 3\] /m);
                assert.match(resp, /^A4 NO \[MESSAGELIMIT 3\] /m);
                assert.match(resp, /^\* SORT 6 5 4\r\nA5 OK/m);
                assert.match(resp, /^\* THREAD \(1\)\(2\)\r\nA6 OK/m);
                done();
            }
        );
    });

    // section 3.1, MULTIAPPEND APPEND is atomic
    it('refuses APPEND of more messages', (t, done) => {
        run(
            ctx,
            [LOGIN, 'A3 APPEND Archive {1}\r\na {1}\r\nb {1}\r\nc {1}\r\nd', 'A4 STATUS Archive (MESSAGES)', 'A5 APPEND Archive {1}\r\na {1}\r\nb {1}\r\nc'],
            resp => {
                assert.match(resp, /^A3 NO \[MESSAGELIMIT 3\] /m);
                assert.match(resp, /^\* STATUS Archive \(MESSAGES 0\)\r$/m);
                assert.match(resp, /^A5 OK \[APPENDUID 7 1:3\] /m);
                done();
            }
        );
    });

    // section 3.1, the PARTIAL example: a PARTIAL range over the limit is refused without doing any work
    it('counts the PARTIAL range of FETCH', (t, done) => {
        run(
            ctx,
            [LOGIN, SELECT, 'A3 UID FETCH 1:* (FLAGS) (PARTIAL -1:-4)', 'A4 UID FETCH 1:* (FLAGS) (PARTIAL 1:3)', 'A5 FETCH 1:* (FLAGS) (PARTIAL -1:-2)'],
            resp => {
                assert.match(resp, /^A3 NO \[MESSAGELIMIT 3\] /m);
                assert.doesNotMatch(resp, /\(FLAGS \(\\Seen\) UID 6\)\r\nA3/);
                assert.match(resp, /^\* 1 FETCH .*\r\n\* 2 FETCH .*\r\n\* 3 FETCH .*\r\nA4 OK UID FETCH/m);
                assert.match(resp, /^\* 5 FETCH .*\r\n\* 6 FETCH .*\r\nA5 OK FETCH/m);
                done();
            }
        );
    });

    // section 3.1: another response code in the tagged OK moves MESSAGELIMIT to an untagged NO
    it('sends MESSAGELIMIT in an untagged NO when the tagged OK has a response code', (t, done) => {
        run(
            ctx,
            [
                LOGIN,
                'A2 ENABLE QRESYNC',
                'A3 SELECT INBOX',
                'A4 UID STORE 1:* +FLAGS.SILENT (\\Deleted)',
                'A5 UID STORE 1:* (UNCHANGEDSINCE 1) +FLAGS (\\Flagged)',
                'A6 UID MOVE 1:* Archive'
            ],
            resp => {
                assert.match(resp, /^A4 OK \[MESSAGELIMIT 3 4\] /m);
                assert.match(resp, /^\* NO \[MESSAGELIMIT 3 4\] .*\r\nA5 OK \[MODIFIED 4,5,6\] /m);
                assert.match(resp, /^\* VANISHED 4:6\r\n\* NO \[MESSAGELIMIT 3 4\] .*\r\nA6 OK \[HIGHESTMODSEQ \d+\] /m);
                done();
            }
        );
    });

    it('works with UIDONLY, which the RFC was written for', (t, done) => {
        run(ctx, [LOGIN, 'A2 ENABLE UIDONLY', 'A3 SELECT INBOX', 'A4 UID FETCH 1:* FLAGS', 'A5 UID FETCH 1:3 FLAGS'], resp => {
            assert.match(
                resp,
                /^\* 6 UIDFETCH \(FLAGS \(\\Seen\)\)\r\n\* 5 UIDFETCH \(FLAGS \(\)\)\r\n\* 4 UIDFETCH \(FLAGS \(\\Seen\)\)\r\nA4 OK \[MESSAGELIMIT 3 4\] /m
            );
            assert.match(resp, /^\* 3 UIDFETCH \(FLAGS \(\)\)\r\nA5 OK UID FETCH/m);
            done();
        });
    });

    it('does not limit EXPUNGE, CLOSE and STATUS UNSEEN', (t, done) => {
        run(
            ctx,
            [
                LOGIN,
                'A2 STATUS INBOX (UNSEEN MESSAGES)',
                'A3 SELECT INBOX',
                'A4 UID STORE 1:3 +FLAGS.SILENT (\\Deleted)',
                'A5 UID STORE 4:6 +FLAGS.SILENT (\\Deleted)',
                'A6 CLOSE',
                'A7 STATUS INBOX (MESSAGES)'
            ],
            resp => {
                assert.match(resp, /^\* STATUS INBOX \(UNSEEN 3 MESSAGES 6\)\r$/m);
                assert.match(resp, /^A6 OK/m);
                assert.match(resp, /^\* STATUS INBOX \(MESSAGES 0\)\r$/m);
                done();
            }
        );
    });
});

describe('MESSAGELIMIT defaults', () => {
    const ctx = setupServer(() => ({ plugins: ['MESSAGELIMIT'], storage: storage() }));

    it('advertises 1000 messages without the messageLimit option (RFC 9738 section 3)', (t, done) => {
        run(ctx, ['A0 CAPABILITY', LOGIN, SELECT, 'A3 FETCH 1:* FLAGS'], resp => {
            assert.match(resp, /^\* CAPABILITY .*\bMESSAGELIMIT=1000\b/m);
            assert.match(resp, /^A3 OK FETCH/m);
            assert.doesNotMatch(resp, /\[MESSAGELIMIT/);
            done();
        });
    });

    it('validates the option and refuses SAVELIMIT together with MESSAGELIMIT', () => {
        assert.throws(() => imapkit({ plugins: ['MESSAGELIMIT'], messageLimit: 0 }), /messageLimit/);
        assert.throws(() => imapkit({ plugins: ['MESSAGELIMIT'], messageLimit: '10' }), /messageLimit/);
        assert.throws(() => imapkit({ plugins: ['MESSAGELIMIT', 'SAVELIMIT'] }), /SAVELIMIT can not be enabled together with MESSAGELIMIT/);
        assert.throws(() => imapkit({ plugins: ['SAVELIMIT', 'MESSAGELIMIT'] }), /MESSAGELIMIT can not be enabled together with SAVELIMIT/);
    });
});

describe('SAVELIMIT', () => {
    const ctx = setupServer(() => ({ plugins: ['SAVELIMIT', 'UIDPLUS', 'MOVE', 'MULTIAPPEND'], messageLimit: 3, storage: storage() }));

    // RFC 9738 section 3: only COPY and APPEND are limited
    it('limits COPY and APPEND only', (t, done) => {
        run(
            ctx,
            [
                'A0 CAPABILITY',
                LOGIN,
                SELECT,
                'A3 UID FETCH 1:* FLAGS',
                'A4 UID COPY 1:* Archive',
                'A5 APPEND Archive {1}\r\na {1}\r\nb {1}\r\nc {1}\r\nd',
                'A6 UID SEARCH UIDAFTER 1',
                'A7 UID MOVE 1:* Archive'
            ],
            resp => {
                assert.match(resp, /^\* CAPABILITY .*\bSAVELIMIT=3\b/m);
                assert.doesNotMatch(resp, /MESSAGELIMIT=/);
                assert.match(resp, /^\* 1 FETCH .*\r\n(\* \d FETCH .*\r\n){5}A3 OK UID FETCH/m);
                assert.match(resp, /^A4 NO \[MESSAGELIMIT 3 4\] /m);
                assert.match(resp, /^A5 NO \[MESSAGELIMIT 3\] /m);
                // UIDAFTER is part of MESSAGELIMIT
                assertTagged(resp, { A6: 'BAD' });
                assert.match(resp, /^A7 OK Done/m);
                done();
            }
        );
    });
});
