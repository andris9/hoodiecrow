'use strict';

// NOTIFY extension, RFC 5465 (https://www.rfc-editor.org/rfc/rfc5465.txt). Most tests use two sessions:
// session "a" asks for notifications, session "b" changes the mailboxes.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer, assertTagged } = require('./helpers');
const { openSession } = require('./helpers/session');

const message = n => 'From: sender@example.com\r\nSubject: message ' + n + '\r\n\r\nBody ' + n + '\r\n';
const NEW_MESSAGE = 'From: new@example.com\r\nSubject: new one\r\n\r\nHello\r\n';
const append = (tag, mailbox, flags) => tag + ' APPEND ' + mailbox + (flags ? ' (' + flags + ')' : '') + ' {' + NEW_MESSAGE.length + '}\r\n' + NEW_MESSAGE;

function storage() {
    return {
        INBOX: {
            messages: [1, 2, 3].map(n => ({ raw: message(n), uid: n, flags: n === 1 ? ['\\Seen'] : [] }))
        },
        '': {
            separator: '/',
            folders: {
                Lists: {
                    folders: {
                        Lemonade: { messages: [{ raw: message(10), uid: 1 }] },
                        Im2000: {}
                    }
                },
                Misc: { messages: [{ raw: message(20), uid: 7, flags: ['\\Seen'] }] },
                Unsubscribed: { subscribed: false }
            }
        }
    };
}

const open = ctx =>
    new Promise(resolve =>
        openSession(ctx.server.address().port, session => {
            session.run('L1 LOGIN testuser testpass', () => resolve(session));
        })
    );
const run = (session, command) => new Promise(resolve => session.run(command, resolve));
const expect = (session, pattern) => new Promise(resolve => session.expect(pattern, resolve));
const runAll = (ctx, commands, callback) => ctx.run(commands, resp => callback(resp.toString('binary')));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// lets the server finish what a command caused, then checks that a session got nothing between commands
async function assertQuiet(session) {
    await wait(30);
    assert.strictEqual(session.buffered(), '', 'unexpected output: ' + session.buffered());
}

describe('NOTIFY', () => {
    describe('command syntax', () => {
        const ctx = setupServer(() => ({ plugins: ['NOTIFY'], storage: storage() }));

        it('advertises the NOTIFY capability (RFC 5465 section 3)', (t, done) => {
            runAll(ctx, ['A1 CAPABILITY'], resp => {
                assert.match(resp, /^\* CAPABILITY .*\bNOTIFY\b/m);
                done();
            });
        });

        it('is valid in the authenticated and selected states only (RFC 5465 section 8: command-auth)', (t, done) => {
            runAll(ctx, ['A1 NOTIFY NONE'], resp => {
                assert.match(resp, /^A1 BAD/m);
                done();
            });
        });

        const badCases = [
            ['no subcommand', 'NOTIFY'],
            ['an unknown subcommand', 'NOTIFY GET (personal (MailboxName))'],
            ['NOTIFY SET without event groups (section 8: event-groups)', 'NOTIFY SET'],
            ['NOTIFY SET STATUS without event groups', 'NOTIFY SET STATUS'],
            ['NOTIFY NONE with arguments (section 8: notify-none)', 'NOTIFY NONE (personal NONE)'],
            ['an event group that is not a list', 'NOTIFY SET personal (MailboxName)'],
            ['an unknown mailbox filter', 'NOTIFY SET (everything (MailboxName))'],
            ['a filter without events', 'NOTIFY SET (personal)'],
            ['an empty event list (section 8: events)', 'NOTIFY SET (personal ())'],
            ['an event that is not an atom', 'NOTIFY SET (personal ("MailboxName"))'],
            [
                'SELECTED and SELECTED-DELAYED together (section 6.1)',
                'NOTIFY SET (selected (MessageNew MessageExpunge)) (selected-delayed (MessageNew MessageExpunge))'
            ],
            ['SELECTED twice (section 6.1)', 'NOTIFY SET (selected (MessageNew MessageExpunge)) (selected NONE)'],
            ['MessageNew without MessageExpunge (section 5)', 'NOTIFY SET (personal (MessageNew))'],
            ['MessageExpunge without MessageNew (section 5)', 'NOTIFY SET (selected (MessageExpunge))'],
            ['FlagChange without MessageNew and MessageExpunge (section 5)', 'NOTIFY SET (personal (FlagChange))'],
            ['AnnotationChange without MessageNew and MessageExpunge (section 5)', 'NOTIFY SET (personal (AnnotationChange))'],
            ['a mailbox event with SELECTED (section 6.1)', 'NOTIFY SET (selected (MailboxName))'],
            ['fetch attributes outside SELECTED (section 8)', 'NOTIFY SET (personal (MessageNew (UID) MessageExpunge))'],
            ['an empty fetch attribute list', 'NOTIFY SET (selected (MessageNew () MessageExpunge))'],
            ['an unknown fetch attribute', 'NOTIFY SET (selected (MessageNew (UID FOO) MessageExpunge))'],
            ['a FETCH macro, which is not a fetch-att', 'NOTIFY SET (selected (MessageNew (ALL) MessageExpunge))'],
            ['an invalid BODY section', 'NOTIFY SET (selected (MessageNew (BODY.PEEK[FOO]) MessageExpunge))'],
            ['a list after an event other than MessageNew', 'NOTIFY SET (selected (MessageNew MessageExpunge (UID)))'],
            ['SUBTREE without a mailbox name', 'NOTIFY SET (subtree (MailboxName))'],
            ['MAILBOXES with an empty list (section 8: many-mailboxes)', 'NOTIFY SET (mailboxes () (MailboxName))'],
            ['a mailbox name that is not valid modified UTF-7', 'NOTIFY SET (mailboxes "Bad&name" (MailboxName))'],
            ['PERSONAL with a mailbox name', 'NOTIFY SET (personal INBOX (MailboxName))']
        ];
        badCases.forEach(([name, command]) => {
            it('refuses ' + name + ' with BAD', (t, done) => {
                runAll(ctx, ['L1 LOGIN testuser testpass', 'A1 ' + command], resp => {
                    assert.match(resp, /^A1 BAD /m);
                    done();
                });
            });
        });

        it('refuses unsupported events with NO [BADEVENT] listing every supported event (section 3.1)', (t, done) => {
            runAll(
                ctx,
                [
                    'L1 LOGIN testuser testpass',
                    'A1 NOTIFY SET (selected (MessageNew MessageExpunge AnnotationChange))',
                    'A2 NOTIFY SET (personal (MailboxName FutureEvent))',
                    'A3 NOTIFY SET (personal (MailboxMetadataChange))',
                    'A4 NOTIFY SET (personal (ServerMetadataChange))'
                ],
                resp => {
                    ['A1', 'A2', 'A3', 'A4'].forEach(tag => {
                        assert.match(
                            resp,
                            new RegExp('^' + tag + ' NO \\[BADEVENT \\(MessageNew MessageExpunge FlagChange MailboxName SubscriptionChange\\)\\] ', 'm')
                        );
                    });
                    done();
                }
            );
        });

        it('accepts event names and filters in any case, NONE events and repeated groups (section 8)', (t, done) => {
            runAll(
                ctx,
                [
                    'L1 LOGIN testuser testpass',
                    'A1 NOTIFY SET (SELECTED-delayed (messagenew (uid body.peek[header.fields (subject)]<0.10>) MESSAGEEXPUNGE flagchange)) (personal NONE)',
                    'A2 NOTIFY SET (personal (messagenew messageexpunge)) (inboxes (messagenew messageexpunge MailboxName))',
                    'A3 NOTIFY SET (mailboxes NONE (SubscriptionChange)) (subtree (Lists "Misc") (MailboxName))',
                    'A4 NOTIFY SET (subscribed (MessageNew MessageExpunge MessageNew))',
                    'A5 NOTIFY NONE'
                ],
                resp => {
                    assertTagged(resp, { A1: 'OK', A2: 'OK', A3: 'OK', A4: 'OK', A5: 'OK' });
                    done();
                }
            );
        });

        it('ignores mailboxes that do not exist (section 3.1)', (t, done) => {
            runAll(ctx, ['L1 LOGIN testuser testpass', 'A1 NOTIFY SET STATUS (mailboxes (Nope Misc) (MessageNew MessageExpunge))'], resp => {
                assert.match(resp, /^\* STATUS Misc \(MESSAGES 1 UIDNEXT 8 UIDVALIDITY 1\)$/m);
                assert.doesNotMatch(resp, /Nope/);
                assert.match(resp, /^A1 OK/m);
                done();
            });
        });
    });

    describe('STATUS indicator', () => {
        const ctx = setupServer(() => ({ plugins: ['NOTIFY', 'CONDSTORE'], storage: storage() }));

        it('sends STATUS with MESSAGES, UIDNEXT and UIDVALIDITY for MessageNew (section 3.1)', (t, done) => {
            runAll(ctx, ['L1 LOGIN testuser testpass', 'A1 NOTIFY SET STATUS (subtree Lists (MessageNew MessageExpunge))'], resp => {
                const status = resp.match(/^\* STATUS .*$/gm);
                assert.deepStrictEqual(status, [
                    '* STATUS Lists (MESSAGES 0 UIDNEXT 1 UIDVALIDITY 1)',
                    '* STATUS Lists/Im2000 (MESSAGES 0 UIDNEXT 1 UIDVALIDITY 1)',
                    '* STATUS Lists/Lemonade (MESSAGES 1 UIDNEXT 2 UIDVALIDITY 1)'
                ]);
                done();
            });
        });

        it('adds UNSEEN and, with CONDSTORE, HIGHESTMODSEQ for FlagChange (section 3.1)', (t, done) => {
            runAll(ctx, ['L1 LOGIN testuser testpass', 'A1 NOTIFY SET STATUS (mailboxes Misc (MessageNew MessageExpunge FlagChange))'], resp => {
                assert.match(resp, /^\* STATUS Misc \(MESSAGES 1 UIDNEXT 8 UIDVALIDITY 1 UNSEEN 0 HIGHESTMODSEQ \d+\)$/m);
                done();
            });
        });

        it('sends no STATUS for the selected mailbox, for mailbox events only or without the indicator', (t, done) => {
            runAll(
                ctx,
                [
                    'L1 LOGIN testuser testpass',
                    'S1 SELECT INBOX',
                    'A1 NOTIFY SET STATUS (selected (MessageNew MessageExpunge)) (mailboxes (INBOX Misc) (MessageNew MessageExpunge))',
                    'A2 NOTIFY SET STATUS (personal (MailboxName SubscriptionChange))',
                    'A3 NOTIFY SET (personal (MessageNew MessageExpunge))'
                ],
                resp => {
                    assert.deepStrictEqual(resp.match(/^\* STATUS .*$/gm), ['* STATUS Misc (MESSAGES 1 UIDNEXT 8 UIDVALIDITY 1)']);
                    assertTagged(resp, { A1: 'OK', A2: 'OK', A3: 'OK' });
                    done();
                }
            );
        });

        it('NOTIFY SET implies NOOP for the selected mailbox (section 3.1)', async () => {
            const a = await open(ctx);
            const b = await open(ctx);
            await run(a, 'S1 SELECT INBOX');
            await run(b, append('B1', 'INBOX'));
            const resp = await run(a, 'A1 NOTIFY SET (selected (MessageNew MessageExpunge))');
            assert.match(resp, /^\* 4 EXISTS\r\nA1 OK/m);
        });
    });

    describe('selected mailbox', () => {
        const ctx = setupServer(() => ({ plugins: ['NOTIFY', 'UIDPLUS', 'IDLE'], storage: storage() }));

        it('sends EXISTS and the requested FETCH right away for a new message (section 5.2)', async () => {
            const a = await open(ctx);
            const b = await open(ctx);
            await run(a, 'S1 SELECT INBOX');
            await run(a, 'A1 NOTIFY SET (selected (MessageNew (UID FLAGS BODY.PEEK[HEADER.FIELDS (SUBJECT)]) MessageExpunge))');
            await run(b, append('B1', 'INBOX', '\\Flagged'));
            const resp = await expect(a, /^\* 4 FETCH/);
            assert.match(
                resp,
                /^\* 4 EXISTS\r\n\* 4 FETCH \(UID 4 FLAGS \(\\Flagged \\Recent\) BODY\[HEADER\.FIELDS \(SUBJECT\)\] \{20\}\r\nSubject: new one\r\n\r\n\)$/m
            );
            // the fetch attributes never set \Seen
            const flags = await run(a, 'A2 UID FETCH 4 FLAGS');
            assert.match(flags, /^\* 4 FETCH \(FLAGS \(\\Flagged \\Recent\) UID 4\)$/m);
        });

        it('sends no FETCH for a message the session added itself (section 5.2)', async () => {
            const a = await open(ctx);
            await run(a, 'S1 SELECT INBOX');
            await run(a, 'A1 NOTIFY SET (selected (MessageNew (UID) MessageExpunge))');
            const resp = await run(a, append('A2', 'INBOX'));
            assert.match(resp, /^\* 4 EXISTS$/m);
            assert.doesNotMatch(resp, /FETCH/);
        });

        it('sends EXPUNGE right away with SELECTED (section 5.3)', async () => {
            const a = await open(ctx);
            const b = await open(ctx);
            await run(a, 'S1 SELECT INBOX');
            await run(a, 'A1 NOTIFY SET (selected (MessageNew MessageExpunge))');
            await run(b, 'S1 SELECT INBOX');
            await run(b, 'B1 STORE 2 +FLAGS (\\Deleted)');
            await run(b, 'B2 UID EXPUNGE 2');
            const resp = await expect(a, /^\* 2 EXISTS/);
            assert.match(resp, /^\* 2 EXPUNGE\r\n\* 2 EXISTS$/m);
        });

        it('sends flag changes only with FlagChange, with UID and FLAGS (section 5.1)', async () => {
            const a = await open(ctx);
            const b = await open(ctx);
            await run(a, 'S1 SELECT INBOX');
            await run(b, 'S1 SELECT INBOX');
            await run(a, 'A1 NOTIFY SET (selected (MessageNew MessageExpunge))');
            await run(b, 'B1 STORE 2 +FLAGS (\\Flagged)');
            await assertQuiet(a);
            let resp = await run(a, 'A2 NOOP');
            assert.doesNotMatch(resp, /FETCH/);

            await run(a, 'A3 NOTIFY SET (selected (MessageNew MessageExpunge FlagChange))');
            await run(b, 'B2 STORE 3 +FLAGS (\\Answered)');
            resp = await expect(a, /^\* 3 FETCH/);
            assert.match(resp, /^\* 3 FETCH \(UID 3 FLAGS \(\\Answered\)\)$/m);
        });

        it('sends no message events for the selected mailbox without SELECTED (section 3.1)', async () => {
            const a = await open(ctx);
            const b = await open(ctx);
            await run(a, 'S1 SELECT INBOX');
            await run(a, 'A1 NOTIFY SET (personal (MessageNew MessageExpunge FlagChange MailboxName))');
            await run(b, 'S1 SELECT INBOX');
            await run(b, append('B1', 'INBOX'));
            await run(b, 'B2 STORE 1 -FLAGS (\\Seen)');
            await run(b, 'B3 STORE 2 +FLAGS (\\Deleted)');
            await run(b, 'B4 UID EXPUNGE 2');
            await assertQuiet(a);
            let resp = await run(a, 'A2 NOOP');
            assert.doesNotMatch(resp, /EXISTS|EXPUNGE|FETCH|STATUS/);
            // the responses to the own commands of the session are still sent
            resp = await run(a, append('A3', 'INBOX'));
            assert.match(resp, /^\* 4 EXISTS$/m);
            resp = await run(a, 'A4 UID FETCH 1:* (UID)');
            assert.deepStrictEqual(resp.match(/UID \d+/g), ['UID 1', 'UID 3', 'UID 4', 'UID 5']);
        });

        it('NOTIFY NONE turns off the notifications of the selected mailbox (section 3.1)', async () => {
            const a = await open(ctx);
            const b = await open(ctx);
            await run(a, 'S1 SELECT INBOX');
            await run(a, 'A1 NOTIFY NONE');
            await run(b, append('B1', 'INBOX'));
            await assertQuiet(a);
            const resp = await run(a, 'A2 NOOP');
            assert.doesNotMatch(resp, /EXISTS/);
        });

        it('delays expunges with SELECTED-DELAYED until a command allows them (section 6.1.2)', async () => {
            const a = await open(ctx);
            const b = await open(ctx);
            await run(a, 'S1 SELECT INBOX');
            await run(a, 'A1 NOTIFY SET (selected-delayed (MessageNew (UID) MessageExpunge FlagChange))');
            await run(b, 'S1 SELECT INBOX');

            // nothing holds these back
            await run(b, 'B1 STORE 2 +FLAGS (\\Flagged)');
            let resp = await expect(a, /^\* 2 FETCH/);
            assert.match(resp, /^\* 2 FETCH \(UID 2 FLAGS \(\\Flagged\)\)$/m);

            await run(b, 'B2 STORE 3 +FLAGS.SILENT (\\Deleted)');
            await expect(a, /^\* 3 FETCH/);
            await run(b, 'B3 UID EXPUNGE 3');
            await run(b, append('B4', 'INBOX'));
            await assertQuiet(a);
            // FETCH must not cause EXPUNGE responses (RFC 3501 section 7.4.1)
            resp = await run(a, 'A2 FETCH 3 (UID)');
            assert.match(resp, /^\* 3 FETCH \(UID 3\)$/m);
            // the pending expunge is only announced with the EXPUNGEISSUED response code (RFC 5530 section 3)
            assert.doesNotMatch(resp, /^\* \d+ EXPUNGE/m);
            assert.match(resp, /^A2 OK \[EXPUNGEISSUED\] /m);
            await assertQuiet(a);
            resp = await run(a, 'A3 NOOP');
            assert.match(resp, /^\* 3 EXPUNGE\r\n\* 2 EXISTS\r\n\* 3 EXISTS\r\n\* 3 FETCH \(UID 4\)\r\nA3 OK/m);
        });

        it('holds notifications during FETCH and sends them after it with SELECTED (RFC 3501 section 7.4.1)', async () => {
            const a = await open(ctx);
            const b = await open(ctx);
            await run(a, 'S1 SELECT INBOX');
            await run(a, 'A1 NOTIFY SET (selected (MessageNew MessageExpunge))');
            await run(b, 'S1 SELECT INBOX');
            await run(b, 'B1 STORE 3 +FLAGS (\\Deleted)');
            // both commands are in one write, the expunge happens while the FETCH of "a" waits in the queue
            a.raw('A2 FETCH 1:3 (UID)\r\n');
            await run(b, 'B2 EXPUNGE');
            const resp = await expect(a, /^\* 2 EXISTS/);
            assert.match(resp, /^A2 OK[^\r]*\r\n\* 3 EXPUNGE\r\n\* 2 EXISTS$/m);
        });

        it('IDLE sends exactly the events NOTIFY asked for (section 4)', async () => {
            const a = await open(ctx);
            const b = await open(ctx);
            await run(a, 'S1 SELECT INBOX');
            await run(a, 'A1 NOTIFY SET (selected (MessageNew MessageExpunge)) (mailboxes Misc (MessageNew MessageExpunge))');
            await run(b, 'S1 SELECT INBOX');
            a.raw('A2 IDLE\r\n');
            await expect(a, /^\+ /);
            await run(b, 'B1 STORE 1 +FLAGS (\\Flagged)');
            await run(b, append('B2', 'Misc'));
            const resp = await expect(a, /^\* STATUS Misc/);
            assert.match(resp, /^\* STATUS Misc \(MESSAGES 2 UIDNEXT 9\)$/m);
            assert.doesNotMatch(resp, /FETCH/);
            a.raw('DONE\r\n');
            const done = await expect(a, /^A2 /);
            assert.match(done, /^A2 OK/m);
            assert.doesNotMatch(done, /FETCH/);
        });
    });

    describe('other mailboxes', () => {
        const ctx = setupServer(() => ({ plugins: ['NOTIFY', 'UIDPLUS', 'MOVE', 'CONDSTORE', 'ENABLE'], storage: storage() }));

        it('sends STATUS (MESSAGES UIDNEXT) for new messages, without a command (section 5.2)', async () => {
            const a = await open(ctx);
            const b = await open(ctx);
            await run(a, 'A1 NOTIFY SET (subtree Lists (MessageNew MessageExpunge))');
            await run(b, append('B1', 'Lists/Lemonade'));
            const resp = await expect(a, /^\* STATUS/);
            assert.strictEqual(resp, '* STATUS Lists/Lemonade (MESSAGES 2 UIDNEXT 3)\r\n');
            // a mailbox outside the subtree
            await run(b, append('B2', 'Misc'));
            await assertQuiet(a);
        });

        it('sends STATUS for expunged messages, one per expunge (section 5.3)', async () => {
            const a = await open(ctx);
            const b = await open(ctx);
            await run(a, 'A1 NOTIFY SET (personal (MessageNew MessageExpunge))');
            await run(b, 'S1 SELECT INBOX');
            await run(b, 'B1 STORE 1:2 +FLAGS (\\Deleted)');
            await run(b, 'B2 EXPUNGE');
            const resp = await expect(a, /^\* STATUS/);
            assert.strictEqual(resp, '* STATUS INBOX (MESSAGES 1 UIDNEXT 4)\r\n');
            await assertQuiet(a);
        });

        it('reports MOVE as MessageNew in the target and MessageExpunge in the source', async () => {
            const a = await open(ctx);
            const b = await open(ctx);
            await run(a, 'A1 NOTIFY SET (personal (MessageNew MessageExpunge))');
            await run(b, 'S1 SELECT INBOX');
            await run(b, 'B1 UID MOVE 3 Misc');
            const resp = await expect(a, /^\* STATUS INBOX/);
            assert.match(resp, /^\* STATUS Misc \(MESSAGES 2 UIDNEXT 9\)\r\n\* STATUS INBOX \(MESSAGES 2 UIDNEXT 4\)$/m);
        });

        it('does not report changes made by the session itself (section 5)', async () => {
            const a = await open(ctx);
            const resp = await run(a, 'A1 NOTIFY SET (personal (MessageNew MessageExpunge FlagChange MailboxName SubscriptionChange))');
            assert.match(resp, /^A1 OK/m);
            await run(a, append('A2', 'Misc'));
            await run(a, 'A3 CREATE Fresh');
            await run(a, 'A4 SUBSCRIBE Unsubscribed');
            await run(a, 'S1 SELECT INBOX');
            await run(a, 'A5 COPY 1 Misc');
            await assertQuiet(a);
            assert.doesNotMatch(await run(a, 'A6 NOOP'), /STATUS|LIST/);
        });

        it('sends UNSEEN for FlagChange when the \\Seen count changes, nothing else without CONDSTORE (section 5.1)', async () => {
            const a = await open(ctx);
            const b = await open(ctx);
            await run(a, 'A1 NOTIFY SET (personal (MessageNew MessageExpunge FlagChange))');
            await run(b, 'S1 SELECT INBOX');
            await run(b, 'B1 STORE 2 +FLAGS (\\Seen)');
            let resp = await expect(a, /^\* STATUS/);
            assert.strictEqual(resp, '* STATUS INBOX (UNSEEN 1)\r\n');
            await run(b, 'B2 STORE 2 +FLAGS (\\Flagged)');
            await assertQuiet(a);
            // with CONDSTORE enabled, every change is reported with UIDVALIDITY and HIGHESTMODSEQ
            await run(a, 'A2 ENABLE CONDSTORE');
            await run(b, 'B3 STORE 3 +FLAGS (\\Flagged)');
            resp = await expect(a, /^\* STATUS/);
            assert.match(resp, /^\* STATUS INBOX \(UIDVALIDITY 1 HIGHESTMODSEQ \d+\)$/m);
            // MessageNew with CONDSTORE adds HIGHESTMODSEQ (section 5.2)
            await run(b, append('B4', 'Misc'));
            resp = await expect(a, /^\* STATUS Misc/);
            assert.match(resp, /^\* STATUS Misc \(MESSAGES 2 UIDNEXT 9 UNSEEN 1 HIGHESTMODSEQ \d+\)$/m);
        });

        it('SELECTED overrides the other groups for the selected mailbox (section 6)', async () => {
            const a = await open(ctx);
            const b = await open(ctx);
            await run(a, 'S1 SELECT INBOX');
            await run(a, 'A1 NOTIFY SET (selected (MessageNew MessageExpunge)) (personal (MessageNew MessageExpunge FlagChange))');
            await run(b, append('B1', 'INBOX'));
            const resp = await expect(a, /^\* 4 EXISTS/);
            assert.doesNotMatch(resp, /STATUS/);
            await assertQuiet(a);
        });

        it('watches the subscribed mailboxes and reevaluates the list (section 6.4)', async () => {
            const a = await open(ctx);
            const b = await open(ctx);
            await run(a, 'A1 NOTIFY SET (subscribed (MessageNew MessageExpunge))');
            await run(b, append('B1', 'Unsubscribed'));
            await assertQuiet(a);
            await run(b, 'B2 SUBSCRIBE Unsubscribed');
            await run(b, append('B3', 'Unsubscribed'));
            const resp = await expect(a, /^\* STATUS/);
            assert.strictEqual(resp, '* STATUS Unsubscribed (MESSAGES 2 UIDNEXT 3)\r\n');
        });
    });

    describe('mailbox events', () => {
        const ctx = setupServer(() => ({ plugins: ['NOTIFY', 'CONDSTORE'], storage: storage() }));

        it('sends LIST for a created mailbox and its parent (section 5.4)', async () => {
            const a = await open(ctx);
            const b = await open(ctx);
            await run(a, 'A1 NOTIFY SET (personal (MailboxName))');
            await run(b, 'B1 CREATE Lists/New');
            const resp = await expect(a, /^\* LIST .* Lists$/);
            assert.strictEqual(resp, '* LIST (\\HasNoChildren) "/" Lists/New\r\n* LIST (\\Subscribed \\HasChildren) "/" Lists\r\n');
        });

        it('sends LIST with \\NonExistent for a deleted mailbox (section 5.4)', async () => {
            const a = await open(ctx);
            const b = await open(ctx);
            await run(a, 'A1 NOTIFY SET (personal (MailboxName))');
            await run(b, 'B1 DELETE Misc');
            const resp = await expect(a, /^\* LIST/);
            assert.strictEqual(resp, '* LIST (\\NonExistent \\HasNoChildren) "/" Misc\r\n');
            // a mailbox with children stays as \Noselect
            await run(b, 'B2 DELETE Lists');
            assert.strictEqual(await expect(a, /^\* LIST/), '* LIST (\\Noselect \\Subscribed \\HasChildren) "/" Lists\r\n');
        });

        it('sends one LIST with OLDNAME for a renamed mailbox (section 5.4)', async () => {
            const a = await open(ctx);
            const b = await open(ctx);
            await run(a, 'A1 NOTIFY SET (mailboxes Lists (MailboxName))');
            await run(b, 'B1 RENAME Lists Groups');
            const resp = await expect(a, /^\* LIST/);
            // the subscription stays with the old name (RFC 9051 section 6.3.6), so Groups is not \Subscribed
            assert.strictEqual(resp, '* LIST (\\HasChildren) "/" Groups ("OLDNAME" ("Lists"))\r\n');
            await assertQuiet(a);
        });

        it('reports a new UIDVALIDITY of a watched name with FlagChange (section 5.1)', async () => {
            const a = await open(ctx);
            const b = await open(ctx);
            await run(a, 'A1 NOTIFY SET (mailboxes Misc (MessageNew MessageExpunge FlagChange))');
            await run(b, 'B1 DELETE Misc');
            await run(b, 'B2 CREATE Misc');
            const resp = await expect(a, /^\* STATUS/);
            assert.match(resp, /^\* STATUS Misc \(MESSAGES 0 UIDNEXT 1 UIDVALIDITY 2 UNSEEN 0\)$/m);
        });

        it('sends LIST with accurate attributes for subscription changes (section 5.5)', async () => {
            const a = await open(ctx);
            const b = await open(ctx);
            await run(a, 'A1 NOTIFY SET (personal (SubscriptionChange))');
            await run(b, 'B1 SUBSCRIBE Unsubscribed');
            assert.strictEqual(await expect(a, /^\* LIST/), '* LIST (\\Subscribed \\HasNoChildren) "/" Unsubscribed\r\n');
            await run(b, 'B2 UNSUBSCRIBE Lists');
            assert.strictEqual(await expect(a, /^\* LIST/), '* LIST (\\HasChildren) "/" Lists\r\n');
            // no change, no event
            await run(b, 'B3 UNSUBSCRIBE Lists');
            await assertQuiet(a);
        });

        it('sends mailbox events for the selected mailbox too (section 3.1)', async () => {
            const a = await open(ctx);
            const b = await open(ctx);
            await run(a, 'S1 SELECT Misc');
            await run(a, 'A1 NOTIFY SET (mailboxes Misc (SubscriptionChange))');
            await run(b, 'B1 UNSUBSCRIBE Misc');
            assert.strictEqual(await expect(a, /^\* LIST/), '* LIST (\\HasNoChildren) "/" Misc\r\n');
        });

        it('server.notifyOverflow() sends NOTIFICATIONOVERFLOW and turns NOTIFY off (section 5.8)', async () => {
            const a = await open(ctx);
            const b = await open(ctx);
            await run(a, 'A1 NOTIFY SET (personal (MailboxName))');
            ctx.server.notifyOverflow();
            assert.match(await expect(a, /^\* OK/), /^\* OK \[NOTIFICATIONOVERFLOW\] /m);
            await run(b, 'B1 CREATE Other');
            await assertQuiet(a);
        });
    });
});

describe('NOTIFY with other extensions', () => {
    describe('QRESYNC, UTF8=ACCEPT, UNAUTHENTICATE and CONTEXT=SEARCH', () => {
        const ctx = setupServer(() => ({
            plugins: ['NOTIFY', 'QRESYNC', 'ENABLE', 'UTF8=ACCEPT', 'UNAUTHENTICATE', 'CONTEXT=SEARCH', 'UIDPLUS'],
            storage: storage()
        }));

        it('sends VANISHED instead of EXPUNGE after ENABLE QRESYNC (section 5.3)', async () => {
            const a = await open(ctx);
            const b = await open(ctx);
            await run(a, 'E1 ENABLE QRESYNC');
            await run(a, 'S1 SELECT INBOX');
            await run(a, 'A1 NOTIFY SET (selected (MessageNew MessageExpunge)) (mailboxes Misc (MessageNew MessageExpunge))');
            await run(b, 'S1 SELECT INBOX');
            await run(b, 'B1 STORE 2:3 +FLAGS (\\Deleted)');
            await run(b, 'B2 EXPUNGE');
            const resp = await expect(a, /^\* VANISHED/);
            assert.match(resp, /^\* VANISHED 2:3$/m);
            assert.doesNotMatch(resp, /EXPUNGE/);
            // HIGHESTMODSEQ is included in STATUS for other mailboxes with QRESYNC (section 5.3)
            await run(b, 'S2 SELECT Misc');
            await run(b, 'B3 STORE 1 +FLAGS (\\Deleted)');
            await run(b, 'B4 EXPUNGE');
            assert.match(await expect(a, /^\* STATUS/), /^\* STATUS Misc \(MESSAGES 0 UIDNEXT 8 HIGHESTMODSEQ \d+\)$/m);
        });

        it('sends mailbox names in UTF-8 after ENABLE UTF8=ACCEPT', async () => {
            const a = await open(ctx);
            const b = await open(ctx);
            await run(a, 'E1 ENABLE UTF8=ACCEPT');
            await run(a, 'A1 NOTIFY SET (personal (MailboxName MessageNew MessageExpunge))');
            await run(b, 'B1 CREATE "Gr&APw-n"');
            assert.strictEqual(await expect(a, /^\* LIST/), '* LIST (\\HasNoChildren) "/" "Gr\xc3\xbcn"\r\n');
            await run(b, 'B2 RENAME "Gr&APw-n" "Bl&AOQ-u"');
            assert.strictEqual(await expect(a, /^\* LIST/), '* LIST (\\HasNoChildren) "/" "Bl\xc3\xa4u" ("OLDNAME" ("Gr\xc3\xbcn"))\r\n');
            await run(b, append('B3', '"Bl&AOQ-u"'));
            assert.strictEqual(await expect(a, /^\* STATUS/), '* STATUS "Bl\xc3\xa4u" (MESSAGES 1 UIDNEXT 2)\r\n');
        });

        it('UNAUTHENTICATE forgets the NOTIFY settings (RFC 8437 section 4.1)', async () => {
            const a = await open(ctx);
            const b = await open(ctx);
            await run(a, 'A1 NOTIFY SET (personal (MailboxName))');
            await run(a, 'A2 UNAUTHENTICATE');
            await run(a, 'L2 LOGIN testuser testpass');
            await run(b, 'B1 CREATE Other');
            await assertQuiet(a);
        });

        it('keeps CONTEXT=SEARCH updates after the NOTIFY events (section 5.2, RFC 5267 section 4.3.2)', async () => {
            const a = await open(ctx);
            const b = await open(ctx);
            await run(a, 'S1 SELECT INBOX');
            await run(a, 'A1 NOTIFY SET (selected (MessageNew (UID) MessageExpunge))');
            await run(a, 'A2 SEARCH RETURN (UPDATE) FROM new');
            await run(b, append('B1', 'INBOX'));
            const resp = await expect(a, /^\* ESEARCH/);
            assert.match(resp, /^\* 4 EXISTS\r\n\* 4 FETCH \(UID 4\)\r\n\* ESEARCH \(TAG "A2"\) ADDTO \(0 4\)$/m);
        });
    });

    describe('ACL', () => {
        const ctx = setupServer(() => ({
            plugins: ['NOTIFY', 'ACL'],
            users: { testuser: { password: 'testpass' }, bob: { password: 'bobpass' } },
            storage: {
                INBOX: {},
                '': {
                    separator: '/',
                    folders: {
                        Shared: { acl: { bob: 'lr' }, messages: [{ raw: message(1), uid: 1 }] },
                        Lookup: { acl: { bob: 'l' }, messages: [{ raw: message(2), uid: 1 }] },
                        Secret: { messages: [{ raw: message(3), uid: 1 }] }
                    }
                }
            }
        }));

        const openBob = () =>
            new Promise(resolve =>
                openSession(ctx.server.address().port, session => {
                    session.run('L1 LOGIN bob bobpass', () => resolve(session));
                })
            );

        it('reports \\NoAccess and leaves out mailboxes without "l" (section 3.1)', async () => {
            const bob = await openBob();
            const resp = await run(bob, 'A1 NOTIFY SET STATUS (personal (MessageNew MessageExpunge MailboxName))');
            assert.match(resp, /^\* STATUS Shared \(MESSAGES 1 UIDNEXT 2 UIDVALIDITY 1\)$/m);
            assert.match(resp, /^\* LIST \(\\Subscribed \\NoAccess \\HasNoChildren\) "\/" Lookup$/m);
            assert.doesNotMatch(resp, /Secret/);
        });

        it('sends no events for mailboxes without "l" and "r" (section 5)', async () => {
            const bob = await openBob();
            const owner = await open(ctx);
            await run(bob, 'A1 NOTIFY SET (personal (MessageNew MessageExpunge MailboxName))');
            await run(owner, append('B1', 'Secret'));
            await run(owner, append('B2', 'Lookup'));
            await run(owner, append('B3', 'Shared'));
            assert.strictEqual(await expect(bob, /^\* STATUS/), '* STATUS Shared (MESSAGES 2 UIDNEXT 3)\r\n');
        });

        it('reports granting and revoking "l" as MailboxName events (section 5.4)', async () => {
            const bob = await openBob();
            const owner = await open(ctx);
            await run(bob, 'A1 NOTIFY SET (personal (MessageNew MessageExpunge MailboxName))');
            await run(owner, 'B1 SETACL Secret bob lr');
            assert.strictEqual(await expect(bob, /^\* LIST/), '* LIST (\\Subscribed \\HasNoChildren) "/" Secret\r\n');
            await run(owner, 'B2 SETACL Lookup bob lr');
            assert.strictEqual(await expect(bob, /^\* LIST/), '* LIST (\\Subscribed \\HasNoChildren) "/" Lookup\r\n');
            await run(owner, 'B3 DELETEACL Secret bob');
            assert.strictEqual(await expect(bob, /^\* LIST/), '* LIST (\\NonExistent \\HasNoChildren) "/" Secret\r\n');
        });
    });

    describe('METADATA', () => {
        const ctx = setupServer(() => ({ plugins: ['NOTIFY', 'METADATA', 'ENABLE'], storage: storage() }));

        it('lists the metadata events as supported (sections 5.6 and 5.7)', (t, done) => {
            runAll(ctx, ['L1 LOGIN testuser testpass', 'A1 NOTIFY SET (personal (MessageNew MessageExpunge AnnotationChange))'], resp => {
                assert.match(
                    resp,
                    /^A1 NO \[BADEVENT \(MessageNew MessageExpunge FlagChange MailboxName SubscriptionChange MailboxMetadataChange ServerMetadataChange\)\]/m
                );
                done();
            });
        });

        it('sends METADATA responses without ENABLE METADATA (sections 5.6 and 5.7)', async () => {
            const a = await open(ctx);
            const b = await open(ctx);
            await run(a, 'A1 NOTIFY SET (mailboxes Misc (MailboxMetadataChange)) (personal (ServerMetadataChange))');
            await run(b, 'B1 SETMETADATA Misc (/private/comment "hello")');
            assert.strictEqual(await expect(a, /^\* METADATA/), '* METADATA Misc /private/comment\r\n');
            await run(b, 'B2 SETMETADATA INBOX (/private/comment "hello")');
            await run(b, 'B3 SETMETADATA "" (/private/comment "hello")');
            assert.strictEqual(await expect(a, /^\* METADATA/), '* METADATA "" /private/comment\r\n');
        });

        it('does not send a METADATA response twice with ENABLE METADATA', async () => {
            const a = await open(ctx);
            const b = await open(ctx);
            await run(a, 'E1 ENABLE METADATA');
            await run(a, 'A1 NOTIFY SET (mailboxes Misc (MailboxMetadataChange))');
            await run(b, 'B1 SETMETADATA Misc (/private/comment "hello")');
            await expect(a, /^\* METADATA/);
            const resp = await run(a, 'A2 NOOP');
            assert.doesNotMatch(resp, /METADATA/);
        });
    });
});
