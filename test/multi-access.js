'use strict';

// RFC 2180 (IMAP4 Multi-Accessed Mailbox Practice): what a session sees when another session expunges messages,
// deletes or renames the mailbox it has selected. RFC 2180 lists several acceptable strategies, hoodiecrow follows:
// - FETCH: expunged messages stay readable until the session is told about the EXPUNGE (section 4.1.1), the
//   tagged OK carries EXPUNGEISSUED (RFC 5530 section 3)
// - STORE: expunged messages are not changed, .SILENT ends with OK (4.2.1), otherwise the other messages are
//   stored and the tagged response is NO [EXPUNGEISSUED] (4.2.2, 4.2.3)
// - SEARCH: the session view still holds the expunged messages, the tagged OK carries EXPUNGEISSUED (4.3)
// - COPY and MOVE: refused with NO [EXPUNGEISSUED] after the pending EXPUNGE responses (4.4.1)
// - UID commands: the pending EXPUNGE responses go first (RFC 3501 section 7.4.1), then the UIDs of the expunged
//   messages do not exist and are ignored (RFC 3501 section 6.4.8)
// - DELETE: other sessions that have the mailbox selected get an untagged BYE (3.3)
// - RENAME: the mailbox keeps its messages under the new name, other sessions keep working (3.4)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');
const { useSessions } = require('./helpers/session');

const message = n => 'From: sender@example.com\r\nSubject: message ' + n + '\r\n\r\nBody ' + n + '\r\n';

// The scenario of RFC 2180 section 4.1: 7 messages, 4:7 are marked for deletion
function storage() {
    return {
        INBOX: {
            messages: [1, 2, 3, 4, 5, 6, 7].map(n => ({ raw: message(n), uid: n, flags: n >= 4 ? ['\\Deleted'] : [] }))
        },
        '': {
            folders: {
                Foo: {
                    messages: [{ raw: message(10), uid: 1 }]
                },
                Fred: {}
            }
        }
    };
}

const lines = output => output.split('\r\n').filter(line => line.length);
const tagged = output => lines(output).pop();
const expunges = output => lines(output).filter(line => /^\* \d+ EXPUNGE$/.test(line));
const fetches = output => lines(output).filter(line => /^\* \d+ FETCH /.test(line));

function setup(plugins) {
    const ctx = setupServer(() => ({ plugins: plugins || [], storage: storage() }));
    const open = useSessions(ctx);

    // two sessions on INBOX, the second one expunged messages 4:7, the first one has not been told yet
    const expunged = async () => {
        const a = await open('INBOX');
        const b = await open('INBOX');
        const output = await b.cmd('EXPUNGE');
        assert.strictEqual(expunges(output).length, 4, output);
        return { a, b };
    };

    return { ctx, open, expunged };
}

describe('RFC 2180 multi-accessed mailbox practice', () => {
    describe('expunged messages (section 4)', () => {
        const { open, expunged } = setup(['MOVE', 'UIDPLUS']);

        it('FETCH still returns the expunged messages until the EXPUNGE is reported (4.1.1)', async () => {
            const { a } = await expunged();

            let output = await a.cmd('FETCH 3:5 (UID FLAGS)');
            assert.deepStrictEqual(fetches(output), [
                '* 3 FETCH (UID 3 FLAGS ())',
                '* 4 FETCH (UID 4 FLAGS (\\Deleted))',
                '* 5 FETCH (UID 5 FLAGS (\\Deleted))'
            ]);
            assert.match(tagged(output), /^T\d+ OK \[EXPUNGEISSUED\] /);

            output = await a.cmd('FETCH 7 BODY.PEEK[TEXT]');
            assert.match(output, /^\* 7 FETCH \(BODY\[TEXT\] \{8\}\r\nBody 7\r\n\)\r\n/);
            assert.deepStrictEqual(expunges(output), []);

            // NOOP reports the expunges, after that the messages are gone
            output = await a.cmd('NOOP');
            assert.deepStrictEqual(expunges(output), ['* 4 EXPUNGE', '* 4 EXPUNGE', '* 4 EXPUNGE', '* 4 EXPUNGE']);
            output = await a.cmd('FETCH 1:* (UID)');
            assert.deepStrictEqual(fetches(output), ['* 1 FETCH (UID 1)', '* 2 FETCH (UID 2)', '* 3 FETCH (UID 3)']);
            assert.match(tagged(output), /^T\d+ OK FETCH/);
        });

        it('STORE .SILENT stores the other messages and ends with OK (4.2.1)', async () => {
            const { a, b } = await expunged();

            const output = await a.cmd('STORE 1:7 +FLAGS.SILENT (\\Seen)');
            assert.deepStrictEqual(fetches(output), []);
            assert.match(tagged(output), /^T\d+ OK \[EXPUNGEISSUED\] /);

            assert.deepStrictEqual(fetches(await b.cmd('FETCH 1:* FLAGS')), [
                '* 1 FETCH (FLAGS (\\Seen))',
                '* 2 FETCH (FLAGS (\\Seen))',
                '* 3 FETCH (FLAGS (\\Seen))'
            ]);
        });

        it('STORE of only expunged messages returns only a tagged NO (4.2.2)', async () => {
            const { a } = await expunged();

            const output = await a.cmd('STORE 5:7 +FLAGS (\\Flagged)');
            assert.deepStrictEqual(lines(output), [tagged(output)]);
            assert.match(tagged(output), /^T\d+ NO \[EXPUNGEISSUED\] /);
        });

        it('STORE of a mixture stores the others, returns their FETCH responses and a tagged NO (4.2.3)', async () => {
            const { a, b } = await expunged();

            let output = await a.cmd('STORE 1:7 +FLAGS (\\Answered)');
            assert.deepStrictEqual(fetches(output), ['* 1 FETCH (FLAGS (\\Answered))', '* 2 FETCH (FLAGS (\\Answered))', '* 3 FETCH (FLAGS (\\Answered))']);
            assert.deepStrictEqual(expunges(output), []);
            assert.match(tagged(output), /^T\d+ NO \[EXPUNGEISSUED\] /);

            // the client issues NOOP and learns that messages 4:7 are gone
            output = await a.cmd('NOOP');
            assert.deepStrictEqual(expunges(output), ['* 4 EXPUNGE', '* 4 EXPUNGE', '* 4 EXPUNGE', '* 4 EXPUNGE']);

            // the other session sees the stored flags
            output = await b.cmd('NOOP');
            assert.deepStrictEqual(fetches(output), [
                '* 1 FETCH (UID 1 FLAGS (\\Answered))',
                '* 2 FETCH (UID 2 FLAGS (\\Answered))',
                '* 3 FETCH (UID 3 FLAGS (\\Answered))'
            ]);
        });

        it('STORE of messages that still exist succeeds while an expunge is pending', async () => {
            const { a } = await expunged();

            const output = await a.cmd('STORE 2:3 +FLAGS (\\Flagged)');
            assert.deepStrictEqual(fetches(output), ['* 2 FETCH (FLAGS (\\Flagged))', '* 3 FETCH (FLAGS (\\Flagged))']);
            assert.match(tagged(output), /^T\d+ OK \[EXPUNGEISSUED\] /);
        });

        it('SEARCH uses the message numbers the session knows, without EXPUNGE responses (4.3)', async () => {
            const { a } = await expunged();

            let output = await a.cmd('SEARCH DELETED');
            assert.deepStrictEqual(lines(output).slice(0, -1), ['* SEARCH 4 5 6 7']);
            assert.match(tagged(output), /^T\d+ OK \[EXPUNGEISSUED\] /);

            // the client issues NOOP to find out what was expunged
            output = await a.cmd('NOOP');
            assert.strictEqual(expunges(output).length, 4);
            output = await a.cmd('SEARCH DELETED');
            assert.deepStrictEqual(lines(output), ['* SEARCH', tagged(output)]);
        });

        it('COPY of an expunged message fails, nothing is copied and the EXPUNGE responses are returned (4.4.1)', async () => {
            const { a } = await expunged();

            let output = await a.cmd('COPY 2,4,6 Fred');
            assert.deepStrictEqual(expunges(output), ['* 4 EXPUNGE', '* 4 EXPUNGE', '* 4 EXPUNGE', '* 4 EXPUNGE']);
            assert.match(tagged(output), /^T\d+ NO \[EXPUNGEISSUED\] /);

            // RFC 3501 section 6.4.7: a failed COPY leaves the destination as it was
            output = await a.cmd('STATUS Fred (MESSAGES)');
            assert.match(output, /^\* STATUS Fred \(MESSAGES 0\)\r\n/);

            // now that the client knows, message 2 is still message 2
            output = await a.cmd('COPY 2 Fred');
            assert.match(tagged(output), /^T\d+ OK \[COPYUID \d+ 2 1\] /);
        });

        it('COPY of messages that still exist succeeds and returns the EXPUNGE responses (4.4)', async () => {
            const { a } = await expunged();

            let output = await a.cmd('COPY 1:3 Fred');
            assert.strictEqual(expunges(output).length, 4);
            assert.match(tagged(output), /^T\d+ OK \[COPYUID \d+ 1,2,3 1,2,3\] /);

            output = await a.cmd('STATUS Fred (MESSAGES)');
            assert.match(output, /^\* STATUS Fred \(MESSAGES 3\)\r\n/);
        });

        it('MOVE of an expunged message fails like COPY (4.4.1, RFC 6851 section 3.3)', async () => {
            const { a } = await expunged();

            let output = await a.cmd('MOVE 1,5 Fred');
            assert.deepStrictEqual(expunges(output), ['* 4 EXPUNGE', '* 4 EXPUNGE', '* 4 EXPUNGE', '* 4 EXPUNGE']);
            assert.match(tagged(output), /^T\d+ NO \[EXPUNGEISSUED\] /);

            output = await a.cmd('STATUS Fred (MESSAGES)');
            assert.match(output, /^\* STATUS Fred \(MESSAGES 0\)\r\n/);
            output = await a.cmd('FETCH 1 (UID)');
            assert.deepStrictEqual(fetches(output), ['* 1 FETCH (UID 1)']);
        });

        it('UID FETCH reports the pending expunges first, expunged UIDs are ignored (RFC 3501 6.4.8, 7.4.1)', async () => {
            const { a } = await expunged();

            const output = await a.cmd('UID FETCH 1:* (FLAGS)');
            assert.deepStrictEqual(lines(output).slice(0, 4), ['* 4 EXPUNGE', '* 4 EXPUNGE', '* 4 EXPUNGE', '* 4 EXPUNGE']);
            assert.deepStrictEqual(fetches(output), ['* 1 FETCH (FLAGS () UID 1)', '* 2 FETCH (FLAGS () UID 2)', '* 3 FETCH (FLAGS () UID 3)']);
            assert.match(tagged(output), /^T\d+ OK UID FETCH/);
        });

        it('UID STORE reports the pending expunges first and stores the existing messages', async () => {
            const { a } = await expunged();

            const output = await a.cmd('UID STORE 3:5 +FLAGS (\\Flagged)');
            assert.deepStrictEqual(lines(output).slice(0, 4), ['* 4 EXPUNGE', '* 4 EXPUNGE', '* 4 EXPUNGE', '* 4 EXPUNGE']);
            assert.deepStrictEqual(fetches(output), ['* 3 FETCH (FLAGS (\\Flagged) UID 3)']);
            assert.match(tagged(output), /^T\d+ OK UID STORE/);
        });

        it('UID COPY reports the pending expunges first and copies the existing messages', async () => {
            const { a } = await expunged();

            const output = await a.cmd('UID COPY 2,4 Fred');
            assert.strictEqual(expunges(output).length, 4);
            assert.match(tagged(output), /^T\d+ OK \[COPYUID \d+ 2 1\] /);
        });

        it('UID MOVE reports the pending expunges first and moves the existing messages', async () => {
            const { a } = await expunged();

            const output = await a.cmd('UID MOVE 3,6 Fred');
            assert.deepStrictEqual(expunges(output), ['* 4 EXPUNGE', '* 4 EXPUNGE', '* 4 EXPUNGE', '* 4 EXPUNGE', '* 3 EXPUNGE']);
            assert.match(output, /^\* OK \[COPYUID \d+ 3 1\] /m);
            assert.match(tagged(output), /^T\d+ OK /);
        });

        it('UID SEARCH reports the pending expunges first, unless its criteria use message numbers (RFC 9051 5.5)', async () => {
            const { a } = await expunged();

            let output = await a.cmd('UID SEARCH 1:7');
            // message numbers in the criteria refer to the messages before any EXPUNGE response of the command
            assert.deepStrictEqual(lines(output), ['* SEARCH 1 2 3 4 5 6 7', tagged(output)]);
            assert.match(tagged(output), /^T\d+ OK /);

            output = await a.cmd('UID SEARCH ALL');
            assert.deepStrictEqual(lines(output).slice(0, 5), ['* 4 EXPUNGE', '* 4 EXPUNGE', '* 4 EXPUNGE', '* 4 EXPUNGE', '* 3 EXISTS']);
            assert.ok(lines(output).indexOf('* SEARCH 1 2 3') >= 0, output);
        });

        it('UID SEARCH does not find the expunged messages once it reported them', async () => {
            const { a } = await expunged();

            const output = await a.cmd('UID SEARCH DELETED');
            assert.strictEqual(expunges(output).length, 4);
            assert.deepStrictEqual(lines(output).slice(-2, -1), ['* SEARCH']);
        });

        it('sessions without a pending expunge are not affected', async () => {
            await expunged();
            const c = await open('INBOX');
            const output = await c.cmd('STORE 1:3 +FLAGS (\\Seen)');
            assert.strictEqual(fetches(output).length, 3);
            assert.match(tagged(output), /^T\d+ OK STORE completed/);
        });
    });

    describe('conditional STORE on expunged messages (RFC 7162 section 3.1.3 example 11)', () => {
        const { open } = setup(['CONDSTORE']);

        it('reports MODIFIED in the tagged NO', async () => {
            const a = await open('INBOX');
            const b = await open('INBOX');

            const select = await a.cmd('SELECT INBOX (CONDSTORE)');
            const highest = select.match(/HIGHESTMODSEQ (\d+)/)[1];

            await b.cmd('STORE 2 +FLAGS.SILENT (\\Flagged)');
            await b.cmd('EXPUNGE');

            const output = await a.cmd('STORE 1:7 (UNCHANGEDSINCE ' + highest + ') +FLAGS (\\Seen)');
            assert.deepStrictEqual(
                fetches(output).map(line => line.replace(/MODSEQ \(\d+\)/, 'MODSEQ (n)')),
                ['* 1 FETCH (FLAGS (\\Seen) MODSEQ (n) UID 1)', '* 3 FETCH (FLAGS (\\Seen) MODSEQ (n) UID 3)']
            );
            assert.match(tagged(output), /^T\d+ NO \[MODIFIED 2\] /);
        });
    });

    describe('DELETE of a mailbox selected by another session (section 3.3)', () => {
        const { open } = setup(['IDLE']);
        // resolves with the output that arrived before the server closed the connection
        const closed = session => new Promise(resolve => session.session.whenClosed(resolve));

        it('disconnects the other sessions with an untagged BYE', async () => {
            const a = await open();
            const b = await open('Foo');
            const c = await open('Foo', true);
            const d = await open('INBOX');

            const bClosed = closed(b);
            const cClosed = closed(c);

            const output = await a.cmd('DELETE Foo');
            assert.deepStrictEqual(lines(output), [tagged(output)]);
            assert.match(tagged(output), /^T\d+ OK /);

            // RFC 2683 section 3.1.2: BYE with an explanation, then the server closes the connection
            assert.match(await bClosed, /^\* BYE Selected mailbox was deleted\r\n$/);
            assert.match(await cClosed, /^\* BYE Selected mailbox was deleted\r\n$/);

            // other sessions are not affected
            assert.match(tagged(await d.cmd('NOOP')), /^T\d+ OK /);
            assert.match(tagged(await a.cmd('SELECT Foo')), /^T\d+ NO /);
        });

        it('reaches a session in IDLE', async () => {
            const a = await open();
            const b = await open('Foo');

            const idle = new Promise(resolve => b.session.run('I1 IDLE', resolve, '+'));
            await idle;
            const bClosed = closed(b);

            await a.cmd('DELETE Foo');
            assert.match(await bClosed, /^\* BYE Selected mailbox was deleted\r\n$/);
        });
    });

    describe('RENAME of a mailbox selected by another session (section 3.4)', () => {
        const { open } = setup();

        it('keeps the other session working on the renamed mailbox', async () => {
            const a = await open();
            const b = await open('Foo');

            let output = await a.cmd('RENAME Foo Bar');
            assert.match(tagged(output), /^T\d+ OK /);

            // commands that do not name the mailbox keep working
            output = await b.cmd('FETCH 1 (UID BODY.PEEK[TEXT])');
            assert.match(output, /^\* 1 FETCH \(UID 1 BODY\[TEXT\] \{9\}\r\nBody 10\r\n\)\r\n/);
            output = await b.cmd('STORE 1 +FLAGS (\\Seen)');
            assert.match(tagged(output), /^T\d+ OK /);
            output = await a.cmd('STATUS Bar (MESSAGES UNSEEN)');
            assert.match(output, /^\* STATUS Bar \(MESSAGES 1 UNSEEN 0\)\r\n/);

            // the old name is gone
            output = await b.cmd('APPEND Foo {' + message(11).length + '}\r\n' + message(11));
            assert.match(tagged(output), /^T\d+ NO \[TRYCREATE\] /);

            // a message appended under the new name shows up in the session
            output = await a.cmd('APPEND Bar {' + message(11).length + '}\r\n' + message(11));
            assert.match(tagged(output), /^T\d+ OK /);
            output = await b.cmd('NOOP');
            assert.match(output, /^\* 2 EXISTS\r\n/m);
        });
    });
});
