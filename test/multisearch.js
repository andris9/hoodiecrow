'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');

const message = n => 'From: sender@example.com\r\nSubject: message ' + n + '\r\n\r\nBody ' + n + '\r\n';

function storage() {
    return {
        INBOX: {
            messages: [
                { raw: message(1), uid: 1, flags: ['\\Seen'] },
                { raw: message(2), uid: 2 },
                { raw: message(3), uid: 3, flags: ['\\Flagged'] }
            ],
            uidvalidity: 7
        },
        '': {
            folders: {
                Archive: {
                    uidvalidity: 8,
                    messages: [{ raw: message(4), uid: 5, flags: ['\\Seen'] }],
                    folders: {
                        2025: {
                            uidvalidity: 9,
                            messages: [{ raw: message(5), uid: 9 }],
                            folders: {
                                Deep: { uidvalidity: 10, messages: [{ raw: message(6), uid: 4 }] }
                            }
                        }
                    }
                },
                Drafts: { uidvalidity: 11, subscribed: false, messages: [{ raw: message(7), uid: 1, flags: ['\\Draft'] }] },
                Container: { flags: ['\\Noselect'], folders: { Child: { uidvalidity: 12, messages: [{ raw: message(8), uid: 3 }] } } },
                Empty: { uidvalidity: 13 }
            }
        },
        'Other Users': {
            type: 'user',
            separator: '/',
            folders: {
                Shared: { uidvalidity: 14, messages: [{ raw: message(9), uid: 1 }] }
            }
        }
    };
}

const LOGIN = 'L1 LOGIN testuser testpass';
const SELECT = 'L2 SELECT INBOX';

// the mailboxes of the ESEARCH responses of a command, in order
const mailboxesOf = (resp, tag) =>
    [...resp.matchAll(new RegExp('^\\* ESEARCH \\(TAG "' + tag + '" MAILBOX "?([^" ]+|[^"]+)"? UIDVALIDITY \\d+\\)', 'gm'))].map(m => m[1]);

describe('MULTISEARCH', () => {
    describe('with MULTISEARCH loaded', () => {
        const ctx = setupServer(() => ({
            plugins: ['MULTISEARCH'],
            storage: storage()
        }));

        it('advertises MULTISEARCH and ESEARCH', (t, done) => {
            ctx.run(['A1 CAPABILITY', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^\* CAPABILITY .*ESEARCH .*MULTISEARCH(\r| )/m);
                done();
            });
        });

        // RFC 7377 section 2.1: UIDs, the MAILBOX, TAG and UIDVALIDITY correlators, ALL without result options
        it('searches mailboxes in the authenticated state', (t, done) => {
            ctx.run(
                [
                    LOGIN,
                    'A1 ESEARCH IN (mailboxes ("Archive" INBOX)) ALL',
                    'A2 ESEARCH IN (mailboxes (Drafts "Archive/2025")) RETURN (COUNT MIN) ALL',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString();
                    assert.match(
                        resp,
                        /^\* ESEARCH \(TAG "A1" MAILBOX Archive UIDVALIDITY 8\) UID ALL 5\r\n\* ESEARCH \(TAG "A1" MAILBOX INBOX UIDVALIDITY 7\) UID ALL 1:3\r\nA1 OK /m
                    );
                    assert.match(
                        resp,
                        /^\* ESEARCH \(TAG "A2" MAILBOX Drafts UIDVALIDITY 11\) UID MIN 1 COUNT 1\r\n\* ESEARCH \(TAG "A2" MAILBOX Archive\/2025 UIDVALIDITY 9\) UID MIN 9 COUNT 1\r\nA2 OK /m
                    );
                    done();
                }
            );
        });

        // RFC 7377 section 2.1: no ESEARCH response for a mailbox without matches, even with COUNT
        it('leaves out mailboxes without matches', (t, done) => {
            ctx.run([LOGIN, 'A1 ESEARCH IN (personal) RETURN (COUNT) DRAFT', 'A2 ESEARCH IN (personal) DELETED', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.deepStrictEqual(mailboxesOf(resp, 'A1'), ['Drafts']);
                assert.match(resp, /^\* ESEARCH \(TAG "A1" MAILBOX Drafts UIDVALIDITY 11\) UID COUNT 1\r\nA1 OK /m);
                assert.match(resp, /A1 OK [^\r]*\r\nA2 OK /);
                done();
            });
        });

        // RFC 5465 section 6 and RFC 7377 section 2.2
        it('resolves the mailbox specifiers', (t, done) => {
            ctx.run(
                [
                    LOGIN,
                    'A1 ESEARCH IN (personal) ALL',
                    'A2 ESEARCH IN (subtree Archive) ALL',
                    'A3 ESEARCH IN (subtree-one Archive) ALL',
                    'A4 ESEARCH IN (inboxes) ALL',
                    'A5 ESEARCH IN (subscribed) ALL',
                    'A6 ESEARCH IN (subtree Container) ALL',
                    'A7 ESEARCH IN (mailboxes (Nonexistent Container "Other Users/Shared")) ALL',
                    'A8 ESEARCH IN (mailboxes INBOX inboxes personal) ALL',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString();
                    assert.deepStrictEqual(mailboxesOf(resp, 'A1'), ['INBOX', 'Archive', 'Archive/2025', 'Archive/2025/Deep', 'Drafts', 'Container/Child']);
                    assert.deepStrictEqual(mailboxesOf(resp, 'A2'), ['Archive', 'Archive/2025', 'Archive/2025/Deep']);
                    assert.deepStrictEqual(mailboxesOf(resp, 'A3'), ['Archive', 'Archive/2025']);
                    assert.deepStrictEqual(mailboxesOf(resp, 'A4'), ['INBOX']);
                    assert.deepStrictEqual(mailboxesOf(resp, 'A5'), [
                        'INBOX',
                        'Archive',
                        'Archive/2025',
                        'Archive/2025/Deep',
                        'Container/Child',
                        'Other Users/Shared'
                    ]);
                    // a \Noselect mailbox is not searched, but what is below it is
                    assert.deepStrictEqual(mailboxesOf(resp, 'A6'), ['Container/Child']);
                    // mailboxes that do not exist are ignored, "mailboxes" does no wildcard expansion
                    assert.deepStrictEqual(mailboxesOf(resp, 'A7'), ['Other Users/Shared']);
                    // every mailbox is searched once
                    assert.deepStrictEqual(mailboxesOf(resp, 'A8'), ['INBOX', 'Archive', 'Archive/2025', 'Archive/2025/Deep', 'Drafts', 'Container/Child']);
                    for (let i = 1; i <= 8; i++) {
                        assert.match(resp, new RegExp('^A' + i + ' OK ', 'm'));
                    }
                    done();
                }
            );
        });

        // RFC 7377 section 2.2: without source options, the selected mailbox is searched
        it('searches the selected mailbox', (t, done) => {
            ctx.run(
                [
                    LOGIN,
                    'A1 ESEARCH UNSEEN',
                    'A2 ESEARCH IN (selected) UNSEEN',
                    SELECT,
                    'A3 ESEARCH UNSEEN',
                    'A4 ESEARCH IN (selected subtree-one Archive) RETURN (MAX) ALL',
                    'A5 ESEARCH 2:3',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString();
                    assert.match(resp, /^A1 BAD /m);
                    assert.match(resp, /^A2 BAD /m);
                    assert.match(resp, /^\* ESEARCH \(TAG "A3" MAILBOX INBOX UIDVALIDITY 7\) UID ALL 2:3\r\nA3 OK /m);
                    assert.deepStrictEqual(mailboxesOf(resp, 'A4'), ['INBOX', 'Archive', 'Archive/2025']);
                    assert.match(resp, /^\* ESEARCH \(TAG "A4" MAILBOX Archive\/2025 UIDVALIDITY 9\) UID MAX 9\r\n/m);
                    assert.match(resp, /^\* ESEARCH \(TAG "A5" MAILBOX INBOX UIDVALIDITY 7\) UID ALL 2:3\r\nA5 OK /m);
                    done();
                }
            );
        });

        // RFC 7377 section 2: message numbers of a mailbox that is not selected, beyond the end is no error
        it('takes sequence numbers per mailbox', (t, done) => {
            ctx.run([LOGIN, 'A1 ESEARCH IN (mailboxes (INBOX Archive)) 2:100', 'A2 ESEARCH IN (mailboxes (INBOX Archive)) UID 2:*', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.deepStrictEqual(mailboxesOf(resp, 'A1'), ['INBOX']);
                assert.match(resp, /^\* ESEARCH \(TAG "A1" MAILBOX INBOX UIDVALIDITY 7\) UID ALL 2:3\r\nA1 OK /m);
                assert.match(resp, /^\* ESEARCH \(TAG "A2" MAILBOX Archive UIDVALIDITY 8\) UID ALL 5\r\nA2 OK /m);
                done();
            });
        });

        // RFC 7377 section 4 and RFC 5465 section 8
        it('rejects invalid arguments', (t, done) => {
            ctx.run(
                [
                    LOGIN,
                    SELECT,
                    'A1 ESEARCH IN (selected-delayed) ALL',
                    'A2 ESEARCH IN () ALL',
                    'A3 ESEARCH IN personal ALL',
                    'A4 ESEARCH IN (personal (scope)) ALL',
                    'A5 ESEARCH IN (mailboxes) ALL',
                    'A6 ESEARCH IN (mailboxes ()) ALL',
                    'A7 ESEARCH IN (foo) ALL',
                    'A8 ESEARCH IN (personal)',
                    'A9 ESEARCH IN (mailboxes "Grün") ALL',
                    'A10 ESEARCH IN (personal) RETURN (FOO) ALL',
                    'A11 ESEARCH RETURN (MIN) IN (personal) ALL',
                    'A12 UID ESEARCH ALL',
                    'A13 ESEARCH IN (mailboxes Archive INBOX) ALL',
                    'A14 ESEARCH IN (personal) RETURN (SAVE) ALL',
                    'A15 ESEARCH IN (personal) RETURN (UPDATE) ALL',
                    'A16 ESEARCH IN (personal) CHARSET FOO ALL',
                    'A17 ESEARCH IN (personal) FOO',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString();
                    for (let i = 1; i <= 15; i++) {
                        assert.match(resp, new RegExp('^A' + i + ' BAD ', 'm'), 'A' + i);
                    }
                    assert.match(resp, /^A17 BAD /m);
                    assert.match(resp, /^A16 NO \[BADCHARSET \(US-ASCII UTF-8\)\] /m);
                    assert.doesNotMatch(resp, /^\* ESEARCH/m);
                    done();
                }
            );
        });
    });

    describe('with MULTISEARCH, SEARCHRES, CONTEXT=SEARCH, PARTIAL and CONDSTORE loaded', () => {
        const ctx = setupServer(() => ({
            plugins: ['MULTISEARCH', 'SEARCHRES', 'CONTEXT=SEARCH', 'PARTIAL', 'CONDSTORE'],
            storage: storage()
        }));

        // RFC 7377 section 2.2: SAVE only when the selected mailbox is the only one searched
        it('saves the result for the selected mailbox only', (t, done) => {
            ctx.run(
                [
                    LOGIN,
                    'A1 ESEARCH IN (mailboxes INBOX) RETURN (SAVE) ALL',
                    SELECT,
                    'A2 ESEARCH IN (selected mailboxes Drafts) RETURN (SAVE) ALL',
                    'A3 ESEARCH IN (selected) RETURN (SAVE) UNSEEN',
                    'A4 FETCH $ UID',
                    'A5 ESEARCH RETURN (SAVE MIN) ALL',
                    'A6 FETCH $ UID',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString();
                    assert.match(resp, /^A1 BAD /m);
                    assert.match(resp, /^A2 BAD /m);
                    // SAVE alone suppresses the ESEARCH response (RFC 5182 section 1)
                    assert.match(resp, /A2 BAD [^\r]*\r\nA3 OK /);
                    assert.match(resp, /^\* 2 FETCH \(UID 2\)\r\n\* 3 FETCH \(UID 3\)\r\nA4 OK /m);
                    assert.match(resp, /^\* ESEARCH \(TAG "A5" MAILBOX INBOX UIDVALIDITY 7\) UID MIN 1\r\nA5 OK /m);
                    assert.match(resp, /^\* 1 FETCH \(UID 1\)\r\nA6 OK /m);
                    done();
                }
            );
        });

        // RFC 7377 section 2.2: PARTIAL applies to each mailbox
        it('applies PARTIAL to each mailbox', (t, done) => {
            ctx.run([LOGIN, 'A1 ESEARCH IN (mailboxes (INBOX Archive)) RETURN (PARTIAL -1:-2) ALL', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(
                    resp,
                    /^\* ESEARCH \(TAG "A1" MAILBOX INBOX UIDVALIDITY 7\) UID PARTIAL \(-1:-2 2:3\)\r\n\* ESEARCH \(TAG "A1" MAILBOX Archive UIDVALIDITY 8\) UID PARTIAL \(-1:-2 5\)\r\nA1 OK /m
                );
                done();
            });
        });

        // RFC 7377 section 2.2: UPDATE applies to the selected mailbox only, and needs one
        it('updates the result of the selected mailbox', (t, done) => {
            ctx.run(
                [
                    LOGIN,
                    'A1 ESEARCH IN (personal) RETURN (UPDATE) ALL',
                    SELECT,
                    'A2 ESEARCH IN (selected mailboxes Drafts) RETURN (UPDATE COUNT) UNSEEN',
                    'A3 ESEARCH IN (mailboxes Drafts) RETURN (UPDATE CONTEXT) UNSEEN',
                    'A4 STORE 1 -FLAGS (\\Seen)',
                    'A5 CANCELUPDATE "A3"',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString();
                    assert.match(resp, /^A1 BAD /m);
                    assert.match(resp, /^\* ESEARCH \(TAG "A2" MAILBOX INBOX UIDVALIDITY 7\) UID COUNT 2\r\n/m);
                    assert.match(resp, /^\* ESEARCH \(TAG "A2" MAILBOX Drafts UIDVALIDITY 11\) UID COUNT 1\r\nA2 OK /m);
                    assert.match(resp, /^\* 1 FETCH \(FLAGS \(\)\)\r\n\* ESEARCH \(TAG "A2" MAILBOX INBOX UIDVALIDITY 7\) UID ADDTO \(0 1\)\r\nA4 OK /m);
                    // the selected mailbox was not searched, so there is nothing to update
                    assert.match(resp, /^A5 NO /m);
                    done();
                }
            );
        });

        // RFC 7162 section 3.1.10: MODSEQ of the mailbox the response is about
        it('reports MODSEQ per mailbox', (t, done) => {
            ctx.run([LOGIN, 'A1 ESEARCH IN (mailboxes (INBOX Drafts)) MODSEQ 1', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.match(resp, /^\* ESEARCH \(TAG "A1" MAILBOX INBOX UIDVALIDITY 7\) UID ALL 1:3 MODSEQ \d+\r\n/m);
                assert.match(resp, /^\* ESEARCH \(TAG "A1" MAILBOX Drafts UIDVALIDITY 11\) UID ALL 1 MODSEQ \d+\r\nA1 OK /m);
                done();
            });
        });
    });

    // RFC 9755 section 3: after ENABLE UTF8=ACCEPT mailbox names are UTF-8, also in the source options and the MAILBOX correlator
    describe('with UTF8=ACCEPT loaded', () => {
        const utf8 = str => Buffer.from(str, 'utf-8').toString('binary');
        const ctx = setupServer(() => ({
            plugins: ['MULTISEARCH', 'UTF8=ACCEPT'],
            storage: { INBOX: {}, '': { separator: '/', folders: { 'Gr&APw-n': { messages: [{ raw: message(1), uid: 1 }] } } } }
        }));

        it('takes and sends mailbox names in the form the session uses', (t, done) => {
            ctx.run(
                [
                    LOGIN,
                    'A1 ESEARCH IN (mailboxes "Gr&APw-n") ALL',
                    'E1 ENABLE UTF8=ACCEPT',
                    utf8('A2 ESEARCH IN (mailboxes "Grün") ALL'),
                    'A3 ESEARCH IN (personal) ALL',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString('binary');
                    assert.match(resp, /^\* ESEARCH \(TAG "A1" MAILBOX Gr&APw-n UIDVALIDITY 1\) UID ALL 1\r\nA1 OK /m);
                    assert.ok(resp.includes(utf8('* ESEARCH (TAG "A2" MAILBOX "Grün" UIDVALIDITY 1) UID ALL 1\r\nA2 OK ')), resp);
                    assert.ok(resp.includes(utf8('* ESEARCH (TAG "A3" MAILBOX "Grün" UIDVALIDITY 1) UID ALL 1\r\nA3 OK ')), resp);
                    done();
                }
            );
        });
    });

    describe('without MULTISEARCH', () => {
        const ctx = setupServer(() => ({
            plugins: ['ESEARCH'],
            storage: storage()
        }));

        it('rejects the ESEARCH command', (t, done) => {
            ctx.run([LOGIN, SELECT, 'A1 ESEARCH ALL', 'ZZ LOGOUT'], resp => {
                assert.match(resp.toString(), /^A1 BAD /m);
                done();
            });
        });
    });
});
