'use strict';

// CATENATE, RFC 4469 (https://www.rfc-editor.org/rfc/rfc4469.txt), with IMAP URLs from RFC 5092
// and ;PARTIAL= from URL-PARTIAL, RFC 5550 section 5.7.1

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');

const PLAIN = 'Subject: plain\r\n\r\nHello world!\r\n';
const MIXED =
    'Subject: mixed\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n' +
    '--b\r\nContent-Type: text/plain\r\n\r\nFirst part\r\n' +
    '--b\r\nContent-Type: message/rfc822\r\n\r\nSubject: inner\r\nX-Inner: yes\r\n\r\nInner body\r\n' +
    '--b--\r\n';

function storage() {
    return {
        INBOX: {
            uidvalidity: 7,
            messages: [
                { raw: PLAIN, uid: 1 },
                { raw: MIXED, uid: 2, flags: ['$Keep'] }
            ]
        },
        '': {
            folders: {
                Drafts: {},
                // "Päevik" in modified UTF-7
                'P&AOQ-evik': {
                    messages: [{ raw: 'Subject: diary\r\n\r\nDear diary\r\n', uid: 5 }]
                },
                'A b': {
                    messages: [{ raw: 'Subject: space\r\n\r\nx\r\n', uid: 1 }]
                }
            }
        }
    };
}

const LOGIN = 'A1 LOGIN testuser testpass';

// Appends with CATENATE and fetches the result from Drafts
const catenate = (ctx, parts, callback) => {
    ctx.run([LOGIN, 'A2 APPEND Drafts CATENATE (' + parts + ')', 'A3 SELECT Drafts', 'A4 FETCH 1 BODY.PEEK[]', 'ZZ LOGOUT'], resp => {
        resp = resp.toString('binary');
        const match = resp.match(/^\* 1 FETCH \(BODY\[\] \{(\d+)\}\r\n/m);
        const body = match ? resp.substr(match.index + match[0].length, Number(match[1])) : null;
        callback(resp, body);
    });
};

describe('CATENATE', () => {
    const ctx = setupServer(() => ({ plugins: ['CATENATE', 'UIDPLUS', 'MULTIAPPEND'], storage: storage() }));

    it('advertises CATENATE and URL-PARTIAL', (t, done) => {
        ctx.run(['A1 CAPABILITY', 'ZZ LOGOUT'], resp => {
            assert.match(resp.toString(), /^\* CAPABILITY .*\bCATENATE\b.*\bURL-PARTIAL\b/m);
            done();
        });
    });

    it('catenates literals and whole messages (RFC 4469 section 3)', (t, done) => {
        catenate(ctx, 'TEXT {14}\r\nX-Added: yes\r\n URL "/INBOX/;UID=1"', (resp, body) => {
            assert.match(resp, /^A2 OK \[APPENDUID 1 1\] /m);
            assert.strictEqual(body, 'X-Added: yes\r\n' + PLAIN);
            done();
        });
    });

    it('catenates message parts like BODY[<section>] returns them', (t, done) => {
        const parts = [
            'URL "/INBOX;UIDVALIDITY=7/;UID=2/;SECTION=HEADER"',
            'URL "/INBOX/;UID=2/;SECTION=1.MIME"',
            'URL "/INBOX/;UID=2/;SECTION=1"',
            'TEXT {2}\r\n\r\n',
            'URL "/INBOX/;UID=2/;SECTION=2.HEADER.FIELDS%20(X-Inner)"',
            'URL "/INBOX/;uid=2/;section=2.text"'
        ];
        catenate(ctx, parts.join(' '), (resp, body) => {
            assert.match(resp, /^A2 OK /m);
            assert.strictEqual(
                body,
                'Subject: mixed\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n' +
                    'Content-Type: text/plain\r\n\r\n' +
                    'First part' +
                    '\r\n' +
                    'X-Inner: yes\r\n\r\n' +
                    // the CRLF before a boundary belongs to the boundary
                    'Inner body'
            );
            done();
        });
    });

    it('supports ;PARTIAL= (RFC 5092 section 6, RFC 5550 section 5.7.1)', (t, done) => {
        catenate(ctx, 'URL "/INBOX/;UID=1/;SECTION=TEXT/;PARTIAL=6.5" URL "/INBOX/;UID=1/;PARTIAL=9" URL "/INBOX/;UID=1/;PARTIAL=999"', (resp, body) => {
            assert.match(resp, /^A2 OK /m);
            assert.strictEqual(body, 'world' + 'plain\r\n\r\nHello world!\r\n');
            done();
        });
    });

    it('does not set \\Seen on the source message (RFC 4469 section 3)', (t, done) => {
        ctx.run([LOGIN, 'A2 SELECT INBOX', 'A3 APPEND Drafts CATENATE (URL "/INBOX/;UID=2/;SECTION=1")', 'A4 FETCH 2 FLAGS', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^A3 OK /m);
            assert.match(resp, /^\* 2 FETCH \(FLAGS \(\$Keep\)\)/m);
            done();
        });
    });

    it('decodes percent-encoded UTF-8 mailbox names and removes dot segments (RFC 5092 sections 7 and 8)', (t, done) => {
        catenate(ctx, 'URL "/P%C3%A4evik/;UID=5/;SECTION=TEXT" URL "/A%20b/./;UID=1/;SECTION=1/../;SECTION=TEXT"', (resp, body) => {
            assert.match(resp, /^A2 OK /m);
            assert.strictEqual(body, 'Dear diary\r\nx\r\n');
            done();
        });
    });

    it('accepts the URL as an atom or a literal', (t, done) => {
        catenate(ctx, 'URL /INBOX/;UID=1/;SECTION=TEXT URL {26}\r\n/INBOX/;UID=1/;PARTIAL=0.7', (resp, body) => {
            assert.match(resp, /^A2 OK /m);
            assert.strictEqual(body, 'Hello world!\r\nSubject');
            done();
        });
    });

    it('works with MULTIAPPEND, APPENDUID lists both messages', (t, done) => {
        ctx.run(
            [
                LOGIN,
                'A2 APPEND Drafts (\\Draft) CATENATE (URL "/INBOX/;UID=1") (\\Seen) {3}\r\nabc',
                'A3 SELECT Drafts',
                'A4 FETCH 1:* (FLAGS RFC822.SIZE)',
                'ZZ LOGOUT'
            ],
            resp => {
                resp = resp.toString();
                assert.match(resp, /^A2 OK \[APPENDUID 1 1:2\] /m);
                assert.match(resp, /^\* 1 FETCH \(FLAGS \(\\Draft \\Recent\) RFC822\.SIZE 32\)/m);
                assert.match(resp, /^\* 2 FETCH \(FLAGS \(\\Seen \\Recent\) RFC822\.SIZE 3\)/m);
                done();
            }
        );
    });

    // RFC 4469 section 4.1 and RFC 5092
    const BAD_URLS = [
        ['a message that does not exist', '/INBOX/;UID=99'],
        ['a mailbox that does not exist', '/Nope/;UID=1'],
        ['a stale UIDVALIDITY (RFC 5092 section 5)', '/INBOX;UIDVALIDITY=8/;UID=1'],
        ['a part that does not exist', '/INBOX/;UID=1/;SECTION=3'],
        ['HEADER of a part that is not a message', '/INBOX/;UID=2/;SECTION=1.HEADER'],
        ['an invalid section', '/INBOX/;UID=1/;SECTION=FOO'],
        ['a section with an unencoded space', '/INBOX/;UID=2/;SECTION=HEADER.FIELDS (Subject)'],
        ['an empty section', '/INBOX/;UID=1/;SECTION='],
        ['a section with 8-bit octets', '/INBOX/;UID=1/;SECTION=%FF'],
        ['a section that closes the section-spec early', '/INBOX/;UID=1/;SECTION=1%5D%20FLAGS'],
        ['a quoted section', '/INBOX/;UID=1/;SECTION=%22TEXT%22'],
        ['HEADER.FIELDS without field names', '/INBOX/;UID=2/;SECTION=HEADER.FIELDS'],
        ['a relative-path reference (RFC 5092 section 7.2)', ';UID=1'],
        ['an absolute URL (RFC 4469 section 3)', 'imap://testuser@localhost/INBOX/;UID=1'],
        ['a network-path reference', '//localhost/INBOX/;UID=1'],
        ['a URL without the "/" before ;UID=', '/INBOX;UID=1'],
        ['a mailbox URL', '/INBOX'],
        ['a search URL', '/INBOX?ALL'],
        ['a URLAUTH URL', '/INBOX/;UID=1/;URLAUTH=anonymous:internal:0123456789abcdef0123456789abcdef'],
        ['an invalid UID', '/INBOX/;UID=0'],
        ['an invalid partial range', '/INBOX/;UID=1/;PARTIAL=1.0'],
        // RFC 5092 section 11: partial-range = number ["." nz-number], 32-bit numbers (RFC 3501 section 9)
        ['a partial offset above 2^32-1', '/INBOX/;UID=1/;PARTIAL=4294967296'],
        ['a partial length above 2^32-1', '/INBOX/;UID=1/;PARTIAL=0.9999999999'],
        ['a UIDVALIDITY above 2^32-1', '/INBOX;UIDVALIDITY=4294967296/;UID=1'],
        ['an invalid percent encoding', '/INBOX%2/;UID=1'],
        ['a mailbox name that is not UTF-8', '/P%E4evik/;UID=5']
    ];

    for (const [description, url] of BAD_URLS) {
        it('returns BADURL for ' + description, (t, done) => {
            ctx.run([LOGIN, 'A2 APPEND Drafts CATENATE (TEXT {3}\r\nabc URL "' + url + '")', 'A3 STATUS Drafts (MESSAGES)', 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                assert.ok(resp.indexOf('A2 NO [BADURL ' + url + '] ') >= 0, resp);
                assert.match(resp, /^\* STATUS Drafts \(MESSAGES 0\)/m);
                done();
            });
        });
    }

    it('returns the first URL that failed (RFC 4469 section 4.1)', (t, done) => {
        ctx.run([LOGIN, 'A2 APPEND Drafts CATENATE (URL "/INBOX/;UID=1" URL "/INBOX/;UID=98" URL "/INBOX/;UID=99")', 'ZZ LOGOUT'], resp => {
            assert.match(resp.toString(), /^A2 NO \[BADURL \/INBOX\/;UID=98\] /m);
            done();
        });
    });

    it('percent-encodes octets of an invalid URL that can not be sent in BADURL', (t, done) => {
        ctx.run([LOGIN, 'A2 APPEND Drafts CATENATE (URL {12}\r\n/IN]BOX\xff;x=1)', 'ZZ LOGOUT'], resp => {
            assert.match(resp.toString('binary'), /^A2 NO \[BADURL \/IN%5DBOX%FF;x=1\] /m);
            done();
        });
    });

    it('refuses an empty URL with NO', (t, done) => {
        ctx.run([LOGIN, 'A2 APPEND Drafts CATENATE (URL "")', 'ZZ LOGOUT'], resp => {
            assert.match(resp.toString(), /^A2 NO (?!\[)/m);
            done();
        });
    });

    it('appends nothing with MULTIAPPEND when a URL of a later message fails (RFC 3502 section 6.3.11)', (t, done) => {
        ctx.run([LOGIN, 'A2 APPEND Drafts {3}\r\nabc CATENATE (URL "/INBOX/;UID=99")', 'A3 STATUS Drafts (MESSAGES)', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^A2 NO \[BADURL /m);
            assert.match(resp, /^\* STATUS Drafts \(MESSAGES 0\)/m);
            done();
        });
    });

    it('refuses a missing target mailbox with TRYCREATE before the URLs', (t, done) => {
        ctx.run([LOGIN, 'A2 APPEND Missing CATENATE (URL "/INBOX/;UID=99")', 'ZZ LOGOUT'], resp => {
            assert.match(resp.toString(), /^A2 NO \[TRYCREATE\] /m);
            done();
        });
    });

    // RFC 4469 section 5: append-data =/ "CATENATE" SP "(" cat-part *(SP cat-part) ")"
    const BAD_SYNTAX = [
        ['an empty list', 'CATENATE ()'],
        ['a quoted TEXT part', 'CATENATE (TEXT "abc")'],
        ['an unknown part', 'CATENATE (FOO "abc")'],
        ['a part without a value', 'CATENATE (URL)'],
        ['a URL list', 'CATENATE (URL ("/INBOX/;UID=1"))'],
        ['no list', 'CATENATE "/INBOX/;UID=1"'],
        ['nothing after CATENATE', 'CATENATE']
    ];

    for (const [description, data] of BAD_SYNTAX) {
        it('refuses ' + description + ' with BAD', (t, done) => {
            ctx.run([LOGIN, 'A2 APPEND Drafts ' + data, 'ZZ LOGOUT'], resp => {
                assert.match(resp.toString(), /^A2 BAD /m);
                done();
            });
        });
    }
});

describe('CATENATE size limit', () => {
    const ctx = setupServer(() => ({ plugins: ['CATENATE'], storage: storage(), maxLiteralSize: 60 }));

    it('returns TOOBIG when the message would exceed the literal size limit (RFC 4469 section 4.2)', (t, done) => {
        ctx.run([LOGIN, 'A2 APPEND Drafts CATENATE (URL "/INBOX/;UID=1" URL "/INBOX/;UID=1")', 'A3 STATUS Drafts (MESSAGES)', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^A2 NO \[TOOBIG\] /m);
            assert.match(resp, /^\* STATUS Drafts \(MESSAGES 0\)/m);
            done();
        });
    });
});

describe('APPEND without CATENATE', () => {
    const ctx = setupServer(() => ({ storage: storage() }));

    it('refuses the CATENATE form', (t, done) => {
        ctx.run([LOGIN, 'A2 CAPABILITY', 'A3 APPEND Drafts CATENATE (URL "/INBOX/;UID=1")', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.doesNotMatch(resp, /^\* CAPABILITY .*(CATENATE|URL-PARTIAL)/m);
            assert.match(resp, /^A3 BAD /m);
            done();
        });
    });
});
