'use strict';

// SAVEDATE, RFC 8514 (https://www.rfc-editor.org/rfc/rfc8514.txt)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const imapkit = require('../lib/server');
const { setupServer } = require('./helpers');

const LOGIN = 'L1 LOGIN testuser testpass';

function storage() {
    return {
        INBOX: {
            messages: [
                { raw: 'Subject: one\r\n\r\n1', internaldate: '01-Jan-2020 10:00:00 +0000', SAVEDATE: '05-mar-2021 12:00:00 +0000' },
                { raw: 'Subject: two\r\n\r\n2', internaldate: '01-Jan-2020 10:00:00 +0000', SAVEDATE: new Date(Date.UTC(2022, 5, 15, 12)) },
                { raw: 'Subject: three\r\n\r\n3', internaldate: '02-Feb-2019 10:00:00 +0000' }
            ]
        },
        '': {
            folders: {
                Archive: {},
                Legacy: {
                    // storage without save dates
                    SAVEDATE: false,
                    messages: [{ raw: 'Subject: legacy\r\n\r\n4', internaldate: '10-Oct-2018 10:00:00 +0000', SAVEDATE: '05-Mar-2021 12:00:00 +0000' }]
                }
            }
        }
    };
}

// date part of a FETCH SAVEDATE value
function savedDay(resp, seq) {
    const match = resp.match(new RegExp('^\\* ' + seq + ' FETCH \\(.*SAVEDATE "([ 0-9]{2}-[A-Za-z]{3}-\\d{4}) \\d{2}:\\d{2}:\\d{2} [-+]\\d{4}"', 'm'));
    assert.ok(match, resp);
    return match[1];
}

function today() {
    return new Date();
}

describe('SAVEDATE', () => {
    const ctx = setupServer(() => ({ plugins: ['SAVEDATE', 'MOVE', 'UIDPLUS'], storage: storage() }));

    // RFC 8514 section 4.1
    it('advertises SAVEDATE', (t, done) => {
        ctx.run([LOGIN, 'A1 CAPABILITY', 'ZZ LOGOUT'], resp => {
            assert.match(resp.toString(), /^\* CAPABILITY .*\bSAVEDATE\b/m);
            done();
        });
    });

    // RFC 8514 section 4.2
    it('FETCH returns the save date', (t, done) => {
        ctx.run([LOGIN, 'L2 SELECT INBOX', 'A1 FETCH 1:3 (SAVEDATE INTERNALDATE)', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^\* 1 FETCH \(SAVEDATE "05-Mar-2021 12:00:00 \+0000" INTERNALDATE "01-Jan-2020 10:00:00 \+0000"\)/m);
            assert.match(resp, /^\* 2 FETCH \(SAVEDATE "\d{2}-Jun-2022 \d{2}:\d{2}:00 [-+]\d{4}" INTERNALDATE/m);
            // a message from storage without a save date was saved when the server loaded it
            const now = today();
            assert.strictEqual(savedDay(resp, 3).split('-')[2], String(now.getFullYear()));
            done();
        });
    });

    // RFC 8514 section 4.2: NIL when the mailbox storage does not support save dates
    it('FETCH returns NIL for a mailbox without save dates', (t, done) => {
        ctx.run([LOGIN, 'L2 SELECT Legacy', 'A1 FETCH 1 SAVEDATE', 'A2 APPEND Legacy {5}\r\nhello', 'A3 FETCH 2 SAVEDATE', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^\* 1 FETCH \(SAVEDATE NIL\)/m);
            assert.match(resp, /^\* 2 FETCH \(SAVEDATE NIL\)/m);
            done();
        });
    });

    // RFC 8514 section 3: APPEND, COPY and MOVE set the save date to the current time, never copied from the source
    it('APPEND, COPY and MOVE set a new save date', (t, done) => {
        ctx.run(
            [
                LOGIN,
                'A1 APPEND Archive "01-Jan-2000 00:00:00 +0000" {5}\r\nhello',
                'L2 SELECT INBOX',
                'A2 COPY 1 Archive',
                'A3 MOVE 2 Archive',
                'A4 FETCH 1 SAVEDATE',
                'A5 SELECT Archive',
                'A6 FETCH 1:* (SAVEDATE INTERNALDATE)',
                'ZZ LOGOUT'
            ],
            resp => {
                resp = resp.toString();
                // the source keeps its save date
                assert.match(resp, /^\* 1 FETCH \(SAVEDATE "05-Mar-2021 12:00:00 \+0000"\)\r\nA4 OK/m);
                const year = String(today().getFullYear());
                for (const seq of [1, 2, 3]) {
                    assert.strictEqual(savedDay(resp.substr(resp.indexOf('A5 OK')), seq).split('-')[2], year);
                }
                assert.match(resp, /^\* 1 FETCH \(SAVEDATE "[^"]+" INTERNALDATE "01-Jan-2000 00:00:00 \+0000"\)/m);
                done();
            }
        );
    });

    // RFC 8514 section 4.3: dates disregard time and timezone
    it('SEARCH by save date', (t, done) => {
        ctx.run(
            [
                LOGIN,
                'L2 SELECT INBOX',
                'A1 SEARCH SAVEDON 5-Mar-2021',
                'A2 SEARCH SAVEDBEFORE 1-Jan-2022',
                'A3 SEARCH SAVEDSINCE 1-Jan-2022',
                'A4 SEARCH SAVEDATESUPPORTED',
                'A5 UID SEARCH NOT SAVEDSINCE 06-Mar-2021',
                'ZZ LOGOUT'
            ],
            resp => {
                resp = resp.toString();
                assert.match(resp, /^\* SEARCH 1\r\nA1 OK/m);
                assert.match(resp, /^\* SEARCH 1\r\nA2 OK/m);
                assert.match(resp, /^\* SEARCH 2 3\r\nA3 OK/m);
                assert.match(resp, /^\* SEARCH 1 2 3\r\nA4 OK/m);
                assert.match(resp, /^\* SEARCH 1\r\nA5 OK/m);
                done();
            }
        );
    });

    // RFC 8514 section 4.3: without save dates the internal date is used, SAVEDATESUPPORTED matches nothing
    it('SEARCH falls back to the internal date', (t, done) => {
        ctx.run(
            [LOGIN, 'L2 SELECT Legacy', 'A1 SEARCH SAVEDON 10-Oct-2018', 'A2 SEARCH SAVEDON 5-Mar-2021', 'A3 SEARCH SAVEDATESUPPORTED', 'ZZ LOGOUT'],
            resp => {
                resp = resp.toString();
                assert.match(resp, /^\* SEARCH 1\r\nA1 OK/m);
                assert.match(resp, /^\* SEARCH\r\nA2 OK/m);
                assert.match(resp, /^\* SEARCH\r\nA3 OK/m);
                done();
            }
        );
    });

    // RFC 8514 section 5: search-key =/ "SAVEDBEFORE" SP date ...
    it('SEARCH refuses invalid dates', (t, done) => {
        ctx.run(
            [
                LOGIN,
                'L2 SELECT INBOX',
                'A1 SEARCH SAVEDON 32-Jan-2020',
                'A2 SEARCH SAVEDSINCE',
                'A3 SEARCH SAVEDBEFORE "01-Jan-2020 10:00:00 +0000"',
                'ZZ LOGOUT'
            ],
            resp => {
                resp = resp.toString();
                assert.match(resp, /^A1 BAD /m);
                assert.match(resp, /^A2 BAD /m);
                assert.match(resp, /^A3 BAD /m);
                done();
            }
        );
    });

    it('refuses invalid save dates in storage', () => {
        assert.throws(() => imapkit({ plugins: ['SAVEDATE'], storage: { INBOX: { messages: [{ raw: 'x', SAVEDATE: 'yesterday' }] } } }), /Invalid SAVEDATE/);
    });
});

describe('SAVEDATE without the plugin', () => {
    const ctx = setupServer(() => ({ storage: storage() }));

    it('refuses the new items', (t, done) => {
        ctx.run([LOGIN, 'L2 SELECT INBOX', 'A1 FETCH 1 SAVEDATE', 'A2 SEARCH SAVEDATESUPPORTED', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^A1 BAD /m);
            assert.match(resp, /^A2 BAD /m);
            done();
        });
    });
});
