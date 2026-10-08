// Multi-session semantics: what one session sees of the changes another session makes to the same mailbox.
// Modelled on WildDuck's imap-notifications tests. Assertions are line anchored and cite RFC 3501 (and
// RFC 2177 for IDLE, RFC 2180 for multi-accessed mailbox practice).

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import net from 'node:net';
import { setupServer } from './helpers/index.js';
import { useSessions } from './helpers/session.js';

const message = (n: number) => 'From: sender@example.com\r\nSubject: message ' + n + '\r\n\r\nBody ' + n + '\r\n';

function storage() {
    return {
        INBOX: {
            messages: [1, 2, 3, 4].map(n => ({ raw: message(n), uid: n, flags: n === 1 ? ['\\Seen'] : [] }))
        },
        '': {
            folders: {
                Foo: {
                    messages: [{ raw: message(10), uid: 1 }]
                },
                Fresh: {
                    messages: [
                        { raw: message(20), uid: 1, flags: ['\\Recent'] },
                        { raw: message(21), uid: 2, flags: ['\\Recent', '\\Seen'] },
                        { raw: message(22), uid: 3 }
                    ]
                }
            }
        }
    };
}

// the response lines of a transcript, without the trailing tagged response
const lines = (output: string) => output.split('\r\n').filter(line => line.length);

// untagged responses that change the message count, in order, eg. ['2 EXPUNGE', '3 EXISTS']
const countResponses = (output: string) =>
    lines(output)
        .map(line => line.match(/^\* (\d+ (?:EXISTS|EXPUNGE))$/))
        .filter((match): match is RegExpMatchArray => match !== null)
        .map(match => match[1]);

/**
 * Applies EXISTS and EXPUNGE responses to a list of UIDs the way a client has to (RFC 3501 7.3.1, 7.4.1),
 * and checks that no EXISTS response reduces the message count (RFC 3501 5.2)
 *
 * @param {Array} uids UIDs the client knows, in sequence order
 * @param {String} output Server output
 * @return {Array} updated UID list, new messages are added as "?"
 */
function applyCountResponses(uids: (number | string)[], output: string) {
    uids = uids.slice();
    countResponses(output).forEach(response => {
        const [num, type] = response.split(' ');
        const n = Number(num);
        if (type === 'EXPUNGE') {
            assert.ok(n >= 1 && n <= uids.length, 'EXPUNGE ' + n + ' outside of 1:' + uids.length);
            uids.splice(n - 1, 1);
        } else {
            assert.ok(n >= uids.length, 'EXISTS ' + n + ' would reduce the message count from ' + uids.length + ' (RFC 3501 5.2)');
            while (uids.length < n) {
                uids.push('?');
            }
        }
    });
    return uids;
}

// UIDs from the untagged FETCH responses of a transcript, in sequence order
const fetchedUids = (output: string) =>
    lines(output)
        .map(line => line.match(/^\* (\d+) FETCH \(.*UID (\d+)/))
        .filter((match): match is RegExpMatchArray => match !== null)
        .map(match => [Number(match[1]), Number(match[2])]);

// a raw connection of the IDLE tests
interface RawClient {
    output: string;
    send(line: string): void;
    waitFor(str: string, timeout?: number): Promise<string>;
    close(): void;
}

describe('Multiple sessions', () => {
    const ctx = setupServer(() => ({ plugins: ['IDLE', 'UIDPLUS'], storage: storage() }));

    const open = useSessions(ctx);

    const tagged = (output: string) => lines(output).pop() as string;

    describe('EXPUNGE from another session (RFC 3501 7.4.1)', () => {
        it('is not sent during FETCH, STORE or SEARCH, sequence numbers stay valid, NOOP delivers it', async () => {
            const a = await open('INBOX');
            const b = await open('INBOX');

            await b.cmd('STORE 2:3 +FLAGS.SILENT (\\Deleted)');
            let output = await b.cmd('EXPUNGE');
            assert.deepStrictEqual(applyCountResponses([1, 2, 3, 4], output), [1, 4]);

            // FETCH: no EXPUNGE, and the sequence numbers are still the ones A knows
            output = await a.cmd('FETCH 1:* (UID)');
            assert.deepStrictEqual(countResponses(output), []);
            assert.deepStrictEqual(fetchedUids(output), [
                [1, 1],
                [2, 2],
                [3, 3],
                [4, 4]
            ]);
            assert.match(tagged(output), /OK/);

            output = await a.cmd('FETCH 4 (UID FLAGS)');
            assert.ok(output.indexOf('* 4 FETCH (UID 4 FLAGS ())\r\n') === 0, output);

            // SEARCH: same numbering, no EXPUNGE
            output = await a.cmd('SEARCH ALL');
            assert.deepStrictEqual(countResponses(output), []);
            assert.ok(output.indexOf('* SEARCH 1 2 3 4\r\n') === 0, output);

            output = await a.cmd('SEARCH UNSEEN');
            assert.deepStrictEqual(countResponses(output), []);
            assert.ok(/^\* SEARCH( \d+)*\r\n/.test(output), output);
            assert.ok(/ 4(\s|$)/.test(lines(output)[0]), 'message 4 is still number 4: ' + output);

            // STORE: no EXPUNGE either, message 4 still exists (RFC 2180 section 4.2, see test/multi-access.test.ts)
            output = await a.cmd('STORE 4 +FLAGS (\\Flagged)');
            assert.deepStrictEqual(countResponses(output), []);
            assert.match(tagged(output), /^T\d+ OK \[EXPUNGEISSUED\]/);

            // NOOP delivers the EXPUNGE responses, after that sequence numbers are renumbered
            output = await a.cmd('NOOP');
            assert.deepStrictEqual(applyCountResponses([1, 2, 3, 4], output), [1, 4]);

            output = await a.cmd('FETCH 1:* (UID)');
            assert.deepStrictEqual(fetchedUids(output), [
                [1, 1],
                [2, 4]
            ]);

            // nothing is delivered twice
            output = await a.cmd('NOOP');
            assert.deepStrictEqual(countResponses(output), []);
        });

        it('is delivered with other commands that are not FETCH, STORE or SEARCH', async () => {
            const a = await open('INBOX');
            const b = await open('INBOX');

            await b.cmd('STORE 1 +FLAGS.SILENT (\\Deleted)');
            await b.cmd('EXPUNGE');

            // RFC 3501 7.4.1 forbids EXPUNGE only during FETCH, STORE and SEARCH, CHECK may send it
            const output = await a.cmd('CHECK');
            assert.deepStrictEqual(applyCountResponses([1, 2, 3, 4], output), [2, 3, 4]);
            assert.ok(output.indexOf('* 1 EXPUNGE\r\n') === 0, output);
        });

        it('keeps the session view consistent when messages are expunged twice before NOOP', async () => {
            const a = await open('INBOX');
            const b = await open('INBOX');

            await b.cmd('STORE 4 +FLAGS.SILENT (\\Deleted)');
            await b.cmd('EXPUNGE');
            await b.cmd('STORE 1 +FLAGS.SILENT (\\Deleted)');
            await b.cmd('EXPUNGE');

            let output = await a.cmd('FETCH 1:* (UID)');
            assert.deepStrictEqual(
                fetchedUids(output).map(pair => pair[1]),
                [1, 2, 3, 4]
            );

            output = await a.cmd('NOOP');
            const uids = applyCountResponses([1, 2, 3, 4], output);
            assert.deepStrictEqual(uids, [2, 3]);

            output = await a.cmd('FETCH 1:* (UID)');
            assert.deepStrictEqual(fetchedUids(output), [
                [1, 2],
                [2, 3]
            ]);
        });

        it('is not sent to the session that closes the mailbox, but to the others (RFC 3501 6.4.2)', async () => {
            const a = await open('INBOX');
            const b = await open('INBOX');

            await a.cmd('STORE 2 +FLAGS.SILENT (\\Deleted)');
            let output = await a.cmd('CLOSE');
            // CLOSE removes \Deleted messages without sending EXPUNGE responses
            assert.deepStrictEqual(countResponses(output), []);
            assert.match(tagged(output), /^T\d+ OK/);

            // A is back in the Authenticated state
            output = await a.cmd('FETCH 1 (UID)');
            assert.match(tagged(output), /^T\d+ BAD/);
            output = await a.cmd('NOOP');
            assert.deepStrictEqual(countResponses(output), []);

            output = await b.cmd('NOOP');
            assert.deepStrictEqual(applyCountResponses([1, 2, 3, 4], output), [1, 3, 4]);
        });
    });

    describe('new messages from another session (RFC 3501 5.2, 7.3.1)', () => {
        it('APPEND by another session yields EXISTS on NOOP', async () => {
            const a = await open('INBOX');
            const b = await open();

            let output = await b.cmd('APPEND INBOX (\\Seen) {' + message(5).length + '}\r\n' + message(5));
            assert.match(tagged(output), /^T\d+ OK \[APPENDUID 1 5\]/);

            output = await a.cmd('NOOP');
            assert.deepStrictEqual(countResponses(output), ['5 EXISTS']);

            output = await a.cmd('FETCH 5 (UID FLAGS)');
            assert.ok(/^\* 5 FETCH \(UID 5 FLAGS \(\\Seen( \\Recent)?\)\)\r\n/.test(output), output);
        });

        it('COPY by another session into the selected mailbox yields EXISTS', async () => {
            const a = await open('Foo');
            const b = await open('INBOX');

            let output = await b.cmd('COPY 1:2 Foo');
            assert.match(tagged(output), /^T\d+ OK \[COPYUID \d+ (1:2|1,2) (2:3|2,3)\]/);

            output = await a.cmd('NOOP');
            // one EXISTS per new message or one for both, either way the count only grows (RFC 3501 7.3.1)
            assert.deepStrictEqual(applyCountResponses([1], output), [1, '?', '?']);
            output = await a.cmd('FETCH 2:3 (UID)');
            assert.deepStrictEqual(fetchedUids(output), [
                [2, 2],
                [3, 3]
            ]);
        });

        it('the appending session gets EXISTS for its own selected mailbox (RFC 3501 6.3.11)', async () => {
            const a = await open('INBOX');
            const output = await a.cmd('APPEND INBOX {' + message(5).length + '}\r\n' + message(5));
            // "If the mailbox is currently selected, the normal new message actions SHOULD occur"
            assert.ok(/(^|\r\n)\* 5 EXISTS\r\n/.test(output), output);
        });

        // RFC 3501 5.2: "A server MUST send mailbox size updates automatically if a mailbox size change is observed during
        // the processing of a command". Section 7.4.1 forbids only EXPUNGE during FETCH, STORE and SEARCH, so the EXISTS
        // goes out before the responses of these commands and the new message has a sequence number the client knows
        it('FETCH, STORE and SEARCH send the EXISTS of a new message before their own responses (RFC 3501 5.2, 7.4.1)', async () => {
            const a = await open('INBOX');
            const b = await open();
            await b.cmd('APPEND INBOX {' + message(5).length + '}\r\n' + message(5));

            let output = await a.cmd('FETCH 5 (UID)');
            assert.match(output, /^\* 5 EXISTS\r\n(?:\* \d+ RECENT\r\n)?\* 5 FETCH \(UID 5\)\r\nT\d+ OK /);

            await b.cmd('APPEND INBOX {' + message(6).length + '}\r\n' + message(6));
            output = await a.cmd('STORE 6 +FLAGS (\\Flagged)');
            assert.match(output, /^\* 6 EXISTS\r\n(?:\* \d+ RECENT\r\n)?\* 6 FETCH \(FLAGS \(\\Flagged( \\Recent)?\)\)\r\nT\d+ OK /);

            await b.cmd('APPEND INBOX {' + message(7).length + '}\r\n' + message(7));
            output = await a.cmd('SEARCH ALL');
            assert.match(output, /^\* 7 EXISTS\r\n(?:\* \d+ RECENT\r\n)?\* SEARCH 1 2 3 4 5 6 7\r\nT\d+ OK /);

            await b.cmd('APPEND INBOX {' + message(8).length + '}\r\n' + message(8));
            output = await a.cmd('UID FETCH 8 (UID)');
            assert.match(output, /^\* 8 EXISTS\r\n(?:\* \d+ RECENT\r\n)?\* 8 FETCH \(UID 8\)\r\nT\d+ OK /);
        });

        it('a new message that arrives after a pending expunge waits for it, its number is not valid yet (RFC 3501 9)', async () => {
            const a = await open('INBOX');
            const b = await open('INBOX');
            await b.cmd('STORE 1 +FLAGS.SILENT (\\Deleted)');
            await b.cmd('EXPUNGE');
            await b.cmd('APPEND INBOX {' + message(5).length + '}\r\n' + message(5));

            // the EXISTS of the new message can not be sent before the EXPUNGE, which FETCH can not send (RFC 3501 5.2:
            // "it is NOT permitted to send an EXISTS response that would reduce the number of messages")
            let output = await a.cmd('FETCH 1:* (UID)');
            assert.deepStrictEqual(countResponses(output), []);
            assert.deepStrictEqual(
                fetchedUids(output).map(pair => pair[1]),
                [1, 2, 3, 4]
            );
            assert.match(output, /^T\d+ OK \[EXPUNGEISSUED\] /m);
            output = await a.cmd('FETCH 5 (UID)');
            assert.match(output, /^T\d+ BAD /m);

            output = await a.cmd('NOOP');
            assert.deepStrictEqual(applyCountResponses([1, 2, 3, 4], output), [2, 3, 4, '?']);
        });

        it('a new message that arrives before a pending expunge is announced first, the expunge waits (RFC 3501 7.4.1)', async () => {
            const a = await open('INBOX');
            const b = await open('INBOX');
            await b.cmd('APPEND INBOX {' + message(5).length + '}\r\n' + message(5));
            await b.cmd('STORE 1 +FLAGS.SILENT (\\Deleted)');
            await b.cmd('EXPUNGE');

            let output = await a.cmd('FETCH 1:* (UID)');
            assert.deepStrictEqual(countResponses(output), ['5 EXISTS']);
            assert.match(output, /^\* 5 EXISTS\r\n/);
            assert.deepStrictEqual(
                fetchedUids(output).map(pair => pair[1]),
                [1, 2, 3, 4, 5]
            );
            assert.match(output, /^T\d+ OK \[EXPUNGEISSUED\] /m);

            output = await a.cmd('NOOP');
            assert.deepStrictEqual(applyCountResponses([1, 2, 3, 4, 5], output), [2, 3, 4, 5]);
        });

        it('is not sent while no command is in progress (RFC 3501 5.3)', async () => {
            const a = await open('INBOX');
            const b = await open();
            await b.cmd('APPEND INBOX {' + message(5).length + '}\r\n' + message(5));

            // anything unsolicited would show up at the start of the next command output
            await new Promise<void>(resolve => setTimeout(resolve, 50));
            const output = await a.cmd('CAPABILITY');
            // the output of a command starts with its own responses, nothing was sent while A was not running a command
            assert.ok(output.indexOf('* CAPABILITY ') === 0, output);
            // when it arrives, it arrives before the tagged response of a command
            const responses = lines(output);
            assert.ok(responses.indexOf('* 5 EXISTS') >= 0 && responses.indexOf('* 5 EXISTS') < responses.length - 1, output);
        });
    });

    describe('flag changes from another session (RFC 3501 5.2, 7.4.2)', () => {
        it('STORE in one session produces an untagged FETCH in another selected session', async () => {
            const a = await open('INBOX');
            const b = await open('INBOX');

            await b.cmd('STORE 2 +FLAGS (\\Flagged)');
            const output = await a.cmd('NOOP');
            // RFC 3501 5.2: "A server SHOULD send message flag updates automatically"
            // the UID is included, RFC 9051 6.3.13 requires it in unsolicited FETCH responses
            assert.ok(/(^|\r\n)\* 2 FETCH \(UID 2 FLAGS \(\\Flagged\)\)\r\n/.test(output), output);
        });

        it('FETCH that sets \\Seen produces an untagged FETCH in another selected session', async () => {
            const a = await open('INBOX');
            const b = await open('INBOX');

            await b.cmd('FETCH 2:3 BODY[TEXT]');
            const output = await a.cmd('NOOP');
            assert.ok(/(^|\r\n)\* 2 FETCH \(UID 2 FLAGS \(\\Seen\)\)\r\n\* 3 FETCH \(UID 3 FLAGS \(\\Seen\)\)\r\n/.test(output), output);
        });

        it('flag updates use the sequence numbers the session knows around an expunge', async () => {
            const a = await open('INBOX');
            const b = await open('INBOX');

            // 3 is changed before the expunge, 4 after it, A still knows 4 messages for the first one
            await b.cmd('STORE 3 +FLAGS (\\Flagged)');
            await b.cmd('STORE 1 +FLAGS (\\Deleted)');
            await b.cmd('EXPUNGE');
            await b.cmd('STORE 3 +FLAGS (\\Answered)');
            const output = await a.cmd('NOOP');
            const responses = lines(output);
            const flagged = responses.indexOf('* 3 FETCH (UID 3 FLAGS (\\Flagged))');
            const expunge = responses.indexOf('* 1 EXPUNGE');
            const answered = responses.indexOf('* 3 FETCH (UID 4 FLAGS (\\Answered))');
            assert.ok(flagged >= 0 && expunge > flagged && answered > expunge, output);
        });

        it('FETCH reports flag changes of other sessions before its own responses (RFC 3501 5.2, 7.4.1)', async () => {
            const a = await open('INBOX');
            const b = await open('INBOX');

            await b.cmd('STORE 2 +FLAGS (\\Flagged)');
            // RFC 3501 7.4.1 holds back only EXPUNGE during FETCH, STORE and SEARCH, flag updates are sent (5.2: SHOULD)
            const output = await a.cmd('FETCH 1 (UID)');
            assert.match(output, /^\* 2 FETCH \(UID 2 FLAGS \(\\Flagged\)\)\r\n\* 1 FETCH \(UID 1\)\r\nT\d+ OK /);
        });

        it('reports each message once per flush, with its current flags', async () => {
            const a = await open('INBOX');
            const b = await open('INBOX');

            await b.cmd('STORE 2 +FLAGS (\\Flagged)');
            await b.cmd('STORE 2 +FLAGS (\\Answered)');
            await b.cmd('STORE 3 +FLAGS (\\Draft)');
            await b.cmd('STORE 2 -FLAGS (\\Flagged)');
            let output = await a.cmd('NOOP');
            const fetched = lines(output).filter(line => /^\* \d+ FETCH /.test(line));
            assert.deepStrictEqual(fetched, ['* 2 FETCH (UID 2 FLAGS (\\Answered))', '* 3 FETCH (UID 3 FLAGS (\\Draft))'], output);
            // nothing is reported again later
            output = await a.cmd('NOOP');
            assert.ok(!/^\* \d+ FETCH /m.test(output), output);
        });

        it('flag changes queued after a pending expunge wait for it during FETCH (RFC 3501 7.4.1)', async () => {
            const a = await open('INBOX');
            const b = await open('INBOX');

            await b.cmd('STORE 2 +FLAGS (\\Flagged)');
            await b.cmd('STORE 1 +FLAGS.SILENT (\\Deleted)');
            await b.cmd('EXPUNGE');
            await b.cmd('STORE 3 +FLAGS (\\Answered)');
            // the change before the expunge goes out with the sequence number A knows, the one after it waits
            let output = await a.cmd('FETCH 4 (UID)');
            assert.match(output, /^\* 2 FETCH \(UID 2 FLAGS \(\\Flagged\)\)\r\n\* 4 FETCH \(UID 4\)\r\nT\d+ OK \[EXPUNGEISSUED\] /);
            output = await a.cmd('NOOP');
            assert.match(output, /^\* 1 EXPUNGE\r\n\* 3 EXISTS\r\n(?:\* \d+ RECENT\r\n)?\* 3 FETCH \(UID 4 FLAGS \(\\Answered\)\)\r\nT\d+ OK /);
        });

        it('the session that changes flags gets them in the STORE response', async () => {
            const a = await open('INBOX');
            const output = await a.cmd('STORE 2 +FLAGS (\\Flagged)');
            assert.ok(output.indexOf('* 2 FETCH (FLAGS (\\Flagged))\r\n') === 0, output);
        });
    });

    describe('IDLE (RFC 2177 3)', () => {
        let rawClients: RawClient[] = [];
        afterEach(() => {
            rawClients.forEach(client => client.close());
            rawClients = [];
        });

        /**
         * Raw connection for IDLE, where the command is ended by an untagged DONE line
         */
        const rawConnection = () =>
            new Promise<RawClient>(resolve => {
                const socket = net.connect(ctx.port, 'localhost');
                const client: RawClient = {
                    output: '',
                    send: (line: string) => socket.write(line + '\r\n'),
                    // resolves with the output up to and including the string, and removes it from the buffer
                    waitFor: (str: string, timeout?: number) =>
                        new Promise<string>((done, reject) => {
                            const started = Date.now();
                            const check = () => {
                                const pos = client.output.indexOf(str);
                                if (pos >= 0) {
                                    const output = client.output.substr(0, pos + str.length);
                                    client.output = client.output.substr(pos + str.length);
                                    return done(output);
                                }
                                if (Date.now() - started > (timeout || 2000)) {
                                    return reject(new Error('Timeout waiting for ' + JSON.stringify(str) + ', got ' + JSON.stringify(client.output)));
                                }
                                setTimeout(check, 5);
                            };
                            check();
                        }),
                    close: () => socket.end()
                };
                rawClients.push(client);
                socket.on('data', chunk => {
                    client.output += chunk.toString('binary');
                });
                client.waitFor('* OK').then(() => resolve(client));
            });

        const startIdle = async (mailbox: string) => {
            const watcher = await rawConnection();
            watcher.send('W1 LOGIN testuser testpass');
            await watcher.waitFor('W1 OK');
            watcher.send('W2 SELECT ' + mailbox);
            await watcher.waitFor('W2 OK');
            watcher.send('W3 IDLE');
            await watcher.waitFor('+ ');
            return watcher;
        };

        it('delivers EXISTS and EXPUNGE while idling, without waiting for DONE', async () => {
            const watcher = await startIdle('INBOX');
            const b = await open('INBOX');

            await b.cmd('APPEND INBOX {' + message(5).length + '}\r\n' + message(5));
            let output = await watcher.waitFor('* 5 EXISTS\r\n');
            assert.deepStrictEqual(countResponses(output), ['5 EXISTS']);

            await b.cmd('STORE 1 +FLAGS.SILENT (\\Deleted)');
            await b.cmd('EXPUNGE');
            output = await watcher.waitFor('* 1 EXPUNGE\r\n');
            assert.deepStrictEqual(countResponses(output), ['1 EXPUNGE']);

            watcher.send('DONE');
            output = await watcher.waitFor('W3 OK');
            // whatever follows the EXPUNGE must not reduce the count (RFC 3501 5.2)
            assert.deepStrictEqual(applyCountResponses([1, 2, 3, 4, 5], '* 1 EXPUNGE\r\n' + output), [2, 3, 4, 5]);

            watcher.send('W4 FETCH 1:* (UID)');
            output = await watcher.waitFor('W4 OK');
            assert.deepStrictEqual(fetchedUids(output), [
                [1, 2],
                [2, 3],
                [3, 4],
                [4, 5]
            ]);
        });

        it('delivers RECENT after the EXISTS of a new message while idling (RFC 3501 7.3.2)', async () => {
            const watcher = await startIdle('INBOX');
            const c = await open();
            await c.cmd('APPEND INBOX {' + message(5).length + '}\r\n' + message(5));
            const output = await watcher.waitFor('RECENT\r\n');
            assert.match(output, /^\* 5 EXISTS\r\n\* 1 RECENT\r\n$/m);
        });

        it('delivers flag changes while idling', async () => {
            const watcher = await startIdle('INBOX');
            const b = await open('INBOX');
            await b.cmd('STORE 3 +FLAGS (\\Answered)');
            const output = await watcher.waitFor('))\r\n', 300);
            assert.ok(/(^|\r\n)\* 3 FETCH \(UID 3 FLAGS \(\\Answered\)\)\r\n$/.test(output), output);
        });

        it('sends nothing for changes to other mailboxes', async () => {
            const watcher = await startIdle('INBOX');
            const b = await open();
            await b.cmd('APPEND Foo {' + message(5).length + '}\r\n' + message(5));
            await new Promise<void>(resolve => setTimeout(resolve, 30));
            watcher.send('DONE');
            const output = await watcher.waitFor('W3 OK');
            assert.deepStrictEqual(countResponses(output), []);
        });
    });

    describe('\\Recent (RFC 3501 2.3.2)', () => {
        it('is given to only one session', async () => {
            const a = await open('Fresh');
            const b = await open();

            let output = await b.cmd('SELECT Fresh');
            // the first session to select the mailbox takes the \Recent flags
            assert.ok(/(^|\r\n)\* 0 RECENT\r\n/.test(output), output);

            output = await a.cmd('FETCH 1:* (FLAGS)');
            assert.ok(output.indexOf('* 1 FETCH (FLAGS (\\Recent))\r\n') >= 0, output);
            assert.ok(output.indexOf('* 2 FETCH (FLAGS (\\Seen \\Recent))\r\n') >= 0, output);
            assert.ok(output.indexOf('* 3 FETCH (FLAGS ())\r\n') >= 0, output);

            output = await b.cmd('FETCH 1:* (FLAGS)');
            assert.ok(output.indexOf('\\Recent') < 0, output);

            output = await a.cmd('SEARCH RECENT');
            assert.ok(output.indexOf('* SEARCH 1 2\r\n') === 0, output);
            output = await b.cmd('SEARCH RECENT');
            assert.ok(output.indexOf('* SEARCH\r\n') === 0, output);

            // RFC 3501 6.3.10: STATUS does not take \Recent away
            const c = await open();
            output = await c.cmd('STATUS Fresh (RECENT)');
            assert.ok(output.indexOf('* STATUS Fresh (RECENT 2)\r\n') === 0, output);
        });

        it('is reported to the first session that selects after an EXAMINE (RFC 3501 6.3.2)', async () => {
            const a = await open();
            let output = await a.cmd('EXAMINE Fresh');
            // EXAMINE shows \Recent but does not take it away
            assert.ok(/(^|\r\n)\* 2 RECENT\r\n/.test(output), output);

            const b = await open();
            output = await b.cmd('SELECT Fresh');
            assert.ok(/(^|\r\n)\* 2 RECENT\r\n/.test(output), output);

            output = await a.cmd('SELECT Fresh');
            assert.ok(/(^|\r\n)\* 0 RECENT\r\n/.test(output), output);
        });

        it('marks a new message as recent in exactly one session (RFC 3501 2.3.2)', async () => {
            const a = await open('INBOX');
            const b = await open('INBOX');
            const c = await open();

            await c.cmd('APPEND INBOX {' + message(5).length + '}\r\n' + message(5));

            const recentIn = async (session: Awaited<ReturnType<typeof open>>) => {
                await session.cmd('NOOP');
                const output = await session.cmd('FETCH 5 (FLAGS)');
                return output.indexOf('\\Recent') >= 0;
            };
            const seen = [await recentIn(a), await recentIn(b)];
            assert.strictEqual(seen.filter(Boolean).length, 1, JSON.stringify(seen));
        });

        // RFC 3501 7.3.2: the RECENT response "occurs as a result of a SELECT or EXAMINE command, and if the size of the
        // mailbox changes (e.g., new messages)", and "The update from the RECENT response MUST be recorded by the client"
        it('a RECENT response with the new count follows the EXISTS of new messages (RFC 3501 7.3.2)', async () => {
            const a = await open('INBOX');
            const b = await open('Fresh', true);
            const c = await open();

            await c.cmd('APPEND INBOX {' + message(5).length + '}\r\n' + message(5));
            await c.cmd('APPEND INBOX {' + message(6).length + '}\r\n' + message(6));
            // A is the only session with INBOX selected, both new messages are recent in A
            let output = await a.cmd('NOOP');
            assert.match(output, /^\* 5 EXISTS\r\n\* 6 EXISTS\r\n\* 2 RECENT\r\nT\d+ OK /);
            output = await a.cmd('SEARCH RECENT');
            assert.match(output, /^\* SEARCH 5 6\r\n/);

            // the session that appends to its selected mailbox gets them as well (RFC 3501 6.3.11)
            output = await a.cmd('APPEND INBOX {' + message(7).length + '}\r\n' + message(7));
            assert.match(output, /^\* 7 EXISTS\r\n\* 3 RECENT\r\nT\d+ OK \[APPENDUID /);

            // B examined Fresh and sees its 2 recent messages, a new message there stays recent for the next session
            // that selects the mailbox read-write (RFC 3501 6.3.2), so the count of B stays the same
            await c.cmd('APPEND Fresh {' + message(8).length + '}\r\n' + message(8));
            output = await b.cmd('FETCH 4 (UID)');
            assert.match(output, /^\* 4 EXISTS\r\n\* 2 RECENT\r\n\* 4 FETCH \(UID 4\)\r\n/);
        });

        it('expunges by another session are reported without RECENT, new messages after them with it (RFC 3501 7.3.2)', async () => {
            const a = await open('Fresh');
            const b = await open('Fresh');
            await b.cmd('STORE 1 +FLAGS.SILENT (\\Deleted)');
            await b.cmd('EXPUNGE');
            // the EXPUNGE response reports the new size (RFC 3501 7.4.1), the EXISTS after it is not needed
            let output = await a.cmd('NOOP');
            assert.match(output, /^\* 1 EXPUNGE\r\n\* 2 EXISTS\r\nT\d+ OK /);

            await b.cmd('STORE 1 +FLAGS.SILENT (\\Deleted)');
            await b.cmd('EXPUNGE');
            await b.cmd('APPEND Fresh {' + message(5).length + '}\r\n' + message(5));
            // both messages that were recent in A are gone, the new message is recent in A
            output = await a.cmd('NOOP');
            assert.match(output, /^\* 1 EXPUNGE\r\n\* 1 EXISTS\r\n\* 2 EXISTS\r\n\* 1 RECENT\r\nT\d+ OK /);
        });
    });
});
