'use strict';

// MULTIAPPEND, CATENATE, REPLACE and APPENDLIMIT together with QUOTA (RFC 9208), OBJECTID (RFC 8474),
// SAVEDATE (RFC 8514) and the URL access checks that an access control plugin can use

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');

const LOGIN = 'A1 LOGIN testuser testpass';
// 40 octets each
const MESSAGE = 'Subject: quota test\r\n\r\nHello, world!!!\r\n';
const literal = str => '{' + str.length + '}\r\n' + str;
const sized = n => 'x'.repeat(n);

// 3 messages, 120 octets in the quota root
function storage() {
    return {
        INBOX: {
            messages: [
                { raw: MESSAGE, uid: 1 },
                { raw: MESSAGE, uid: 2 }
            ]
        },
        '': {
            folders: {
                Archive: { messages: [{ raw: MESSAGE, uid: 1 }] },
                Small: { appendLimit: 10 }
            }
        }
    };
}

const PLUGINS = ['QUOTA', 'MULTIAPPEND', 'CATENATE', 'REPLACE', 'UIDPLUS', 'APPENDLIMIT'];

describe('QUOTA with the APPEND extensions', () => {
    describe('MESSAGE limit', () => {
        const ctx = setupServer(() => ({ plugins: PLUGINS, quota: { MESSAGE: 4 }, storage: storage() }));

        it('counts every message of a MULTIAPPEND and appends none when over quota (RFC 3502 section 6.3.11)', (t, done) => {
            ctx.run(
                [
                    LOGIN,
                    'A2 APPEND Archive ' + literal(MESSAGE) + ' ' + literal(MESSAGE),
                    'A3 STATUS Archive (MESSAGES)',
                    'A4 APPEND Archive ' + literal(MESSAGE),
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString();
                    assert.match(resp, /^A2 NO \[OVERQUOTA\] /m);
                    assert.match(resp, /^\* STATUS Archive \(MESSAGES 1\)/m);
                    assert.match(resp, /^A4 OK /m);
                    done();
                }
            );
        });

        it('REPLACE counts only the net usage (RFC 8508 section 3.4)', (t, done) => {
            const cmds = [
                LOGIN,
                'A2 APPEND Archive ' + literal(MESSAGE),
                'A3 SELECT INBOX',
                'A4 APPEND INBOX ' + literal(MESSAGE),
                'A5 REPLACE 1 INBOX ' + literal(MESSAGE),
                'A6 REPLACE 1 Archive ' + literal(MESSAGE),
                'ZZ LOGOUT'
            ];
            ctx.run(cmds, resp => {
                resp = resp.toString();
                // the quota root is full with 4 messages
                assert.match(resp, /^A2 OK /m);
                assert.match(resp, /^A4 NO \[OVERQUOTA\] /m);
                assert.match(resp, /^A5 OK /m);
                // replacing into another mailbox of the same quota root does not change the usage either
                assert.match(resp, /^A6 OK /m);
                done();
            });
        });
    });

    describe('STORAGE limit', () => {
        // 1024 octets, 120 are used
        const ctx = setupServer(() => ({ plugins: PLUGINS, quota: { STORAGE: 1 }, storage: storage() }));

        it('counts the catenated message, not the literals', (t, done) => {
            const urls = Array.from({ length: 23 }, () => 'URL "/INBOX/;UID=1"').join(' ');
            const cmds = [LOGIN, 'A2 APPEND Archive CATENATE (' + urls + ')', 'A3 APPEND Archive CATENATE (' + urls + ' URL "/INBOX/;UID=1")', 'ZZ LOGOUT'];
            ctx.run(cmds, resp => {
                resp = resp.toString();
                // 120 + 920 octets is over the limit, 120 + 960 too, so both fail
                assert.match(resp, /^A2 NO \[OVERQUOTA\] /m);
                assert.match(resp, /^A3 NO \[OVERQUOTA\] /m);
                done();
            });
        });

        it('lets REPLACE use the space of the replaced message (RFC 8508 section 3.4)', (t, done) => {
            const cmds = [LOGIN, 'A2 SELECT INBOX', 'A3 APPEND INBOX ' + literal(sized(944)), 'A4 REPLACE 1 INBOX ' + literal(sized(944)), 'ZZ LOGOUT'];
            ctx.run(cmds, resp => {
                resp = resp.toString();
                // 120 + 944 = 1064 octets is too much for APPEND, 120 - 40 + 944 = 1024 fits for REPLACE
                assert.match(resp, /^A3 NO \[OVERQUOTA\] /m);
                assert.match(resp, /^A4 OK /m);
                done();
            });
        });
    });

    describe('soft quota', () => {
        const ctx = setupServer(() => ({ plugins: PLUGINS, quota: { MESSAGE: 3, soft: true }, storage: storage() }));

        it('warns once for a MULTIAPPEND and appends every message (RFC 9208 section 4.3.1)', (t, done) => {
            ctx.run([LOGIN, 'A2 APPEND Archive ' + literal(MESSAGE) + ' ' + literal(MESSAGE), 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.strictEqual(resp.match(/^\* NO \[OVERQUOTA\] /gm).length, 1, resp);
                assert.match(resp, /^A2 OK \[APPENDUID \d+ 2:3\] /m);
                done();
            });
        });
    });
});

describe('APPENDLIMIT with QUOTA', () => {
    const ctx = setupServer(() => ({ plugins: PLUGINS, quota: { MESSAGE: 100 }, storage: storage() }));

    it('limits uploads but not COPY (RFC 7889 section 1)', (t, done) => {
        ctx.run([LOGIN, 'A2 SELECT INBOX', 'A3 COPY 1 Small', 'A4 APPEND Small ' + literal(sized(11)), 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^A3 OK /m);
            assert.match(resp, /^A4 NO \[TOOBIG\] /m);
            done();
        });
    });

    it('reports STATUS items of both plugins', (t, done) => {
        ctx.run([LOGIN, 'A2 STATUS Small (APPENDLIMIT DELETED-STORAGE MESSAGES)', 'ZZ LOGOUT'], resp => {
            assert.match(resp.toString(), /^\* STATUS Small \(APPENDLIMIT 10 DELETED-STORAGE 0 MESSAGES 0\)/m);
            done();
        });
    });
});

describe('OBJECTID and SAVEDATE with the APPEND extensions', () => {
    const ctx = setupServer(() => ({ plugins: ['OBJECTID', 'SAVEDATE', 'MULTIAPPEND', 'CATENATE', 'REPLACE', 'UIDPLUS'], storage: storage() }));

    const ids = resp => [...resp.matchAll(/^\* \d+ FETCH \(.*EMAILID \(([^)]+)\).*$/gm)].map(match => match[1]);

    it('gives every MULTIAPPEND and CATENATE message its own EMAILID and a SAVEDATE', (t, done) => {
        const cmds = [
            LOGIN,
            'A2 APPEND Archive ' + literal(MESSAGE) + ' CATENATE (URL "/INBOX/;UID=1")',
            'A3 SELECT Archive',
            'A4 FETCH 1:* (EMAILID SAVEDATE)',
            'ZZ LOGOUT'
        ];
        ctx.run(cmds, resp => {
            resp = resp.toString();
            const emailIds = ids(resp);
            assert.strictEqual(emailIds.length, 3, resp);
            assert.strictEqual(new Set(emailIds).size, 3, resp);
            assert.strictEqual(resp.match(/SAVEDATE "/g).length, 3, resp);
            done();
        });
    });

    // RFC 8474 section 4.6 (as cited by RFC 8508 section 4.6): the replacing message gets a new EMAILID
    it('gives the REPLACE message a new EMAILID', (t, done) => {
        ctx.run(
            [
                LOGIN,
                'A2 SELECT INBOX',
                'A3 UID FETCH 1 EMAILID',
                'A4 UID REPLACE 1 INBOX CATENATE (URL "/INBOX/;UID=1")',
                'A5 UID FETCH 3 (EMAILID SAVEDATE)',
                'ZZ LOGOUT'
            ],
            resp => {
                resp = resp.toString();
                assert.match(resp, /^A4 OK /m);
                const emailIds = ids(resp);
                assert.strictEqual(emailIds.length, 2, resp);
                assert.notStrictEqual(emailIds[0], emailIds[1], resp);
                assert.match(resp, /^\* \d+ FETCH \(.*SAVEDATE "/m);
                done();
            }
        );
    });
});

describe('URL access checks', () => {
    // what an access control plugin does when the user may not read a mailbox
    const noArchive = server => {
        server.urlAccessChecks.push((connection, mailbox) => (mailbox.path === 'Archive' ? { text: 'No read access to Archive' } : false));
    };
    const ctx = setupServer(() => ({ plugins: ['CATENATE', noArchive], storage: storage() }));

    it('refuse a CATENATE URL with BADURL (RFC 4469 section 4.1)', (t, done) => {
        ctx.run([LOGIN, 'A2 APPEND INBOX CATENATE (URL "/INBOX/;UID=1")', 'A3 APPEND INBOX CATENATE (URL "/Archive/;UID=1")', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^A2 OK /m);
            assert.match(resp, /^A3 NO \[BADURL \/Archive\/;UID=1\] No read access to Archive\r\n/m);
            done();
        });
    });
});
