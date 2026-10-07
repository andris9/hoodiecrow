'use strict';

// BINARY extension, RFC 3516 (https://www.rfc-editor.org/rfc/rfc3516.txt), and the rules RFC 9051
// section 6.4.5 adds for the BINARY fetch items

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');
const { decodeBase64, decodeQuotedPrintable } = require('../lib/plugins/binary');

// every octet value, base64 encoded in 76 character lines
const ALL_OCTETS = Buffer.from(Array.from({ length: 256 }, (v, i) => i));
const ALL_OCTETS_BASE64 = ALL_OCTETS.toString('base64').replace(/.{76}/g, '$&\r\n');

const ENCODED =
    'From: sender@example.com\r\n' +
    'Subject: Encoded parts\r\n' +
    'MIME-Version: 1.0\r\n' +
    'Content-Type: multipart/mixed; boundary="b1"\r\n' +
    '\r\n' +
    '--b1\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    'Content-Transfer-Encoding: quoted-printable\r\n' +
    '\r\n' +
    'Caf=C3=A9 au lait, a soft =\r\n' +
    'line break.  \r\n' +
    'Tabs=09and =3D signs, a =ZZ that is kept\r\n' +
    '--b1\r\n' +
    'Content-Type: application/octet-stream\r\n' +
    'Content-Transfer-Encoding: base64\r\n' +
    '\r\n' +
    ALL_OCTETS_BASE64 +
    '\r\n' +
    '--b1\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    'Content-Transfer-Encoding: 8bit\r\n' +
    '\r\n' +
    'Caf\xc3\xa9\r\n' +
    '--b1\r\n' +
    'Content-Type: text/plain\r\n' +
    'Content-Transfer-Encoding: x-unknown\r\n' +
    '\r\n' +
    'encoded somehow\r\n' +
    '--b1\r\n' +
    'Content-Type: text/plain\r\n' +
    'Content-Transfer-Encoding: BASE64\r\n' +
    '\r\n' +
    Buffer.from('line 1\nline 2\n').toString('base64') +
    '\r\n' +
    '--b1--\r\n';

const NESTED =
    'Subject: Nested\r\n' +
    'Content-Type: multipart/mixed; boundary="outer"\r\n' +
    '\r\n' +
    '--outer\r\n' +
    'Content-Type: multipart/alternative; boundary="inner"\r\n' +
    '\r\n' +
    '--inner\r\n' +
    'Content-Type: text/plain\r\n' +
    '\r\n' +
    'alternative\r\n' +
    '--inner--\r\n' +
    '--outer\r\n' +
    'Content-Type: message/rfc822\r\n' +
    '\r\n' +
    'Subject: Attached\r\n' +
    'Content-Transfer-Encoding: base64\r\n' +
    '\r\n' +
    Buffer.from('attached body').toString('base64') +
    '\r\n' +
    '--outer--\r\n';

const BINARY_PART = '\x00\x01\x02\r\n\xff\x00\nend';

const BINARY_MESSAGE =
    'Subject: Binary part\r\n' +
    'Content-Type: multipart/mixed; boundary="b1"\r\n' +
    '\r\n' +
    '--b1\r\n' +
    'Content-Type: text/plain\r\n' +
    '\r\n' +
    'See the attachment.\r\n' +
    '--b1\r\n' +
    'Content-Type: application/octet-stream\r\n' +
    'Content-Transfer-Encoding: binary\r\n' +
    '\r\n' +
    BINARY_PART +
    '\r\n' +
    '--b1--\r\n';

const LOGIN = 'L1 LOGIN testuser testpass';
const SELECT = 'L2 SELECT INBOX';

function storage() {
    return {
        INBOX: {
            messages: [{ raw: ENCODED }, { raw: 'Subject: plain\r\n\r\nHello\r\n' }, { raw: NESTED }]
        },
        '': {}
    };
}

/**
 * Returns the value of a FETCH item from a transcript: the data of a literal or literal8, or a number
 */
function fetchValue(resp, item) {
    const escaped = item.replace(/[.[\]<>]/g, '\\$&');
    const literal = resp.match(new RegExp('[ (]' + escaped + ' (~?)\\{(\\d+)\\}\\r\\n'));
    if (literal) {
        const start = literal.index + literal[0].length;
        return { literal8: !!literal[1], value: resp.substr(start, Number(literal[2])) };
    }
    const number = resp.match(new RegExp('[ (]' + escaped + ' (\\d+)'));
    return number ? Number(number[1]) : undefined;
}

/**
 * Builds an APPEND command with a literal8, as a binary string
 */
function append8(tag, message, plus) {
    return tag + ' APPEND INBOX ~{' + message.length + (plus ? '+' : '') + '}\r\n' + message;
}

describe('BINARY', () => {
    describe('capability', () => {
        const ctx = setupServer(() => ({ plugins: ['BINARY'], storage: storage() }));

        it('is advertised (RFC 3516 section 4.1)', (t, done) => {
            ctx.run(['A1 CAPABILITY', 'ZZ LOGOUT'], resp => {
                assert.match(resp.toString(), /^\* CAPABILITY IMAP4rev1 .*\bBINARY\b/m);
                done();
            });
        });
    });

    describe('FETCH', () => {
        const ctx = setupServer(() => ({ plugins: ['BINARY'], storage: storage() }));

        it('decodes quoted-printable (RFC 2045 section 6.7)', (t, done) => {
            ctx.run([LOGIN, SELECT, 'A1 FETCH 1 (BINARY.PEEK[1] BINARY.SIZE[1])', 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                const expected = 'Caf\xc3\xa9 au lait, a soft line break.\r\nTabs\tand = signs, a =ZZ that is kept';
                assert.deepStrictEqual(fetchValue(resp, 'BINARY[1]'), { literal8: false, value: expected });
                assert.strictEqual(fetchValue(resp, 'BINARY.SIZE[1]'), expected.length);
                assert.match(resp, /^A1 OK/m);
                done();
            });
        });

        it('decodes base64 and sends data with NUL as a literal8 (RFC 3516 section 4.3)', (t, done) => {
            ctx.run([LOGIN, SELECT, 'A1 FETCH 1 (BINARY.PEEK[2] BINARY.SIZE[2])', 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                assert.deepStrictEqual(fetchValue(resp, 'BINARY[2]'), { literal8: true, value: ALL_OCTETS.toString('binary') });
                assert.strictEqual(fetchValue(resp, 'BINARY.SIZE[2]'), 256);
                done();
            });
        });

        it('applies a partial range to the decoded data, literal8 only when the slice has NUL (RFC 3516 section 4.2)', (t, done) => {
            ctx.run(
                [LOGIN, SELECT, 'A1 FETCH 1 BINARY.PEEK[2]<250.10>', 'A2 FETCH 1 BINARY.PEEK[2]<0.3>', 'A3 FETCH 1 BINARY.PEEK[2]<300.3>', 'ZZ LOGOUT'],
                resp => {
                    resp = resp.toString('binary');
                    assert.match(resp, /^\* 1 FETCH \(BINARY\[2\]<250> \{6\}\r\n\xfa\xfb\xfc\xfd\xfe\xff\)\r\nA1 OK/m);
                    assert.ok(resp.includes('* 1 FETCH (BINARY[2]<0> ~{3}\r\n\x00\x01\x02)\r\nA2 OK'), resp);
                    assert.match(resp, /^\* 1 FETCH \(BINARY\[2\]<300> \{0\}\r\n\)\r\nA3 OK/m);
                    done();
                }
            );
        });

        it('returns identity encoded parts as they are, 8-bit data in a literal', (t, done) => {
            ctx.run([LOGIN, SELECT, 'A1 FETCH 1 (BINARY.PEEK[3] BINARY.SIZE[3])', 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                assert.deepStrictEqual(fetchValue(resp, 'BINARY[3]'), { literal8: false, value: 'Caf\xc3\xa9' });
                assert.strictEqual(fetchValue(resp, 'BINARY.SIZE[3]'), 5);
                done();
            });
        });

        it('sends decoded text with CRLF line breaks (RFC 3516 section 6)', (t, done) => {
            ctx.run([LOGIN, SELECT, 'A1 FETCH 1 (BINARY.PEEK[5] BINARY.SIZE[5])', 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                assert.deepStrictEqual(fetchValue(resp, 'BINARY[5]'), { literal8: false, value: 'line 1\r\nline 2\r\n' });
                assert.strictEqual(fetchValue(resp, 'BINARY.SIZE[5]'), 16);
                done();
            });
        });

        it('answers NO [UNKNOWN-CTE] for an unknown encoding, without partial output (RFC 3516 section 4.3)', (t, done) => {
            ctx.run(
                [
                    LOGIN,
                    SELECT,
                    'A1 FETCH 1 (BINARY[1] BINARY[4])',
                    'A2 FETCH 1 BINARY.SIZE[4]',
                    'A3 FETCH 1:2 BINARY.PEEK[4]',
                    'A4 FETCH 1 FLAGS',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString('binary');
                    assert.match(resp, /^A1 NO \[UNKNOWN-CTE\] /m);
                    assert.match(resp, /^A2 NO \[UNKNOWN-CTE\] /m);
                    assert.match(resp, /^A3 NO \[UNKNOWN-CTE\] /m);
                    assert.doesNotMatch(resp, /FETCH \(BINARY/);
                    // the failed FETCH did not set \Seen
                    assert.match(resp, /^\* 1 FETCH \(FLAGS \(\)\)\r\nA4 OK/m);
                    done();
                }
            );
        });

        it('treats a non-MIME message as one text part', (t, done) => {
            ctx.run([LOGIN, SELECT, 'A1 FETCH 2 (BINARY.PEEK[1] BINARY.SIZE[1])', 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                assert.match(resp, /^\* 2 FETCH \(BINARY\[1\] \{7\}\r\nHello\r\n BINARY\.SIZE\[1\] 7\)/m);
                done();
            });
        });

        it('decodes a part of an attached message', (t, done) => {
            ctx.run([LOGIN, SELECT, 'A1 FETCH 3 (BINARY.PEEK[1.1] BINARY.PEEK[2.1] BINARY.SIZE[2.1])', 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                assert.deepStrictEqual(fetchValue(resp, 'BINARY[1.1]'), { literal8: false, value: 'alternative' });
                assert.deepStrictEqual(fetchValue(resp, 'BINARY[2.1]'), { literal8: false, value: 'attached body' });
                assert.strictEqual(fetchValue(resp, 'BINARY.SIZE[2.1]'), 13);
                done();
            });
        });

        it('returns an empty string for a part that does not exist, like BODY[]', (t, done) => {
            ctx.run([LOGIN, SELECT, 'A1 FETCH 2 (BINARY.PEEK[3] BINARY.SIZE[3] BINARY.PEEK[1.1])', 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                assert.match(resp, /^\* 2 FETCH \(BINARY\[3\] \{0\}\r\n BINARY\.SIZE\[3\] 0 BINARY\[1\.1\] \{0\}\r\n\)/m);
                done();
            });
        });

        it('sets \\Seen with BINARY, not with BINARY.PEEK or BINARY.SIZE', (t, done) => {
            ctx.run(
                [LOGIN, SELECT, 'A1 FETCH 1 (BINARY.PEEK[1] BINARY.SIZE[1])', 'A2 FETCH 1 FLAGS', 'A3 FETCH 1 BINARY[1]', 'A4 FETCH 1 FLAGS', 'ZZ LOGOUT'],
                resp => {
                    resp = resp.toString('binary');
                    assert.match(resp, /^\* 1 FETCH \(FLAGS \(\)\)\r\nA2 OK/m);
                    // the implicit \Seen comes with a FLAGS item in the response (RFC 3501 section 6.4.5)
                    assert.match(resp, /^\* 1 FETCH \(BINARY\[1\] \{\d+\}\r\n[^\r]*\r\n[^\r]* FLAGS \(\\Seen\)\)\r\nA3 OK/m);
                    assert.match(resp, /^\* 1 FETCH \(FLAGS \(\\Seen\)\)\r\nA4 OK/m);
                    done();
                }
            );
        });

        it('does not set \\Seen in a mailbox opened with EXAMINE', (t, done) => {
            ctx.run([LOGIN, 'A1 EXAMINE INBOX', 'A2 FETCH 2 BINARY[1]', 'A3 FETCH 2 FLAGS', 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                assert.match(resp, /^\* 2 FETCH \(BINARY\[1\] \{7\}\r\nHello\r\n\)\r\nA2 OK/m);
                assert.match(resp, /^\* 2 FETCH \(FLAGS \(\)\)\r\nA3 OK/m);
                done();
            });
        });

        it('works with UID FETCH', (t, done) => {
            ctx.run([LOGIN, SELECT, 'A1 UID FETCH 2 BINARY.SIZE[1]', 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                assert.match(resp, /^\* 2 FETCH \(BINARY\.SIZE\[1\] 7 UID 2\)\r\nA1 OK/m);
                done();
            });
        });

        // RFC 3516 section 7: section-binary = "[" [section-part] "]", partial is not allowed after BINARY.SIZE.
        // RFC 9051 section 6.4.5: BINARY is only for leaf body parts
        const invalid = [
            ['BINARY without a section', 'FETCH 1 BINARY'],
            ['BINARY.PEEK without a section', 'FETCH 1 BINARY.PEEK'],
            ['BINARY.SIZE without a section', 'FETCH 1 BINARY.SIZE'],
            ['BINARY[] of the whole message', 'FETCH 2 BINARY.PEEK[]'],
            ['BINARY.SIZE[] of the whole message', 'FETCH 2 BINARY.SIZE[]'],
            ['BINARY[HEADER]', 'FETCH 1 BINARY.PEEK[HEADER]'],
            ['BINARY[TEXT]', 'FETCH 1 BINARY.PEEK[TEXT]'],
            ['BINARY[1.MIME]', 'FETCH 1 BINARY.PEEK[1.MIME]'],
            ['BINARY[HEADER.FIELDS (Subject)]', 'FETCH 1 BINARY.PEEK[HEADER.FIELDS (Subject)]'],
            ['part number 0', 'FETCH 1 BINARY.PEEK[0]'],
            ['part number with a leading zero', 'FETCH 1 BINARY.PEEK[01]'],
            ['BINARY.SIZE with a partial range', 'FETCH 1 BINARY.SIZE[1]<0.5>'],
            ['partial range with zero length', 'FETCH 1 BINARY.PEEK[1]<0.0>'],
            ['partial range without a length', 'FETCH 1 BINARY.PEEK[1]<5>'],
            ['a multipart part', 'FETCH 3 BINARY.PEEK[1]'],
            ['a message/rfc822 part', 'FETCH 3 BINARY.PEEK[2]'],
            ['BINARY.SIZE of a multipart part', 'FETCH 3 BINARY.SIZE[1]']
        ];

        invalid.forEach(([description, command]) => {
            it('refuses ' + description + ' with BAD', (t, done) => {
                ctx.run([LOGIN, SELECT, 'A1 ' + command, 'A2 FETCH 1:3 FLAGS', 'ZZ LOGOUT'], resp => {
                    resp = resp.toString('binary');
                    assert.match(resp, /^A1 BAD /m);
                    assert.doesNotMatch(resp, /^\* \d+ FETCH \(BINARY/m);
                    assert.match(resp, /^\* 1 FETCH \(FLAGS \(\)\)\r\n\* 2 FETCH \(FLAGS \(\)\)\r\n\* 3 FETCH \(FLAGS \(\)\)\r\nA2 OK/m);
                    done();
                });
            });
        });
    });

    describe('APPEND', () => {
        const ctx = setupServer(() => ({ plugins: ['BINARY', 'UIDPLUS'], storage: storage() }));

        it('stores a binary part base64 encoded and returns its octets with BINARY (RFC 3516 sections 4.4 and 6)', (t, done) => {
            ctx.run(
                [
                    LOGIN,
                    append8('A1', BINARY_MESSAGE),
                    SELECT,
                    'A2 FETCH 4 (BODYSTRUCTURE BODY.PEEK[2] BINARY.PEEK[2] BINARY.SIZE[2] BODY.PEEK[2.MIME])',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString('binary');
                    assert.match(resp, /^\+ /m);
                    assert.match(resp, /^A1 OK \[APPENDUID \d+ 4\] /m);
                    assert.match(
                        resp,
                        /BODYSTRUCTURE \(\("TEXT" "PLAIN" NIL NIL NIL "7BIT" 19 0 NIL NIL NIL\)\("APPLICATION" "OCTET-STREAM" NIL NIL NIL "BASE64" 16 NIL NIL NIL\)/
                    );
                    assert.deepStrictEqual(fetchValue(resp, 'BODY[2]'), { literal8: false, value: Buffer.from(BINARY_PART, 'binary').toString('base64') });
                    assert.deepStrictEqual(fetchValue(resp, 'BINARY[2]'), { literal8: true, value: BINARY_PART });
                    assert.strictEqual(fetchValue(resp, 'BINARY.SIZE[2]'), BINARY_PART.length);
                    assert.deepStrictEqual(fetchValue(resp, 'BODY[2.MIME]'), {
                        literal8: false,
                        value: 'Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\n'
                    });
                    done();
                }
            );
        });

        it('stores a message without binary content as it is', (t, done) => {
            const message = 'Subject: text\r\nContent-Transfer-Encoding: 8bit\r\n\r\nCaf\xc3\xa9\r\n';
            ctx.run([LOGIN, append8('A1', message), SELECT, 'A2 FETCH 4 BODY.PEEK[]', 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                assert.match(resp, /^A1 OK /m);
                assert.deepStrictEqual(fetchValue(resp, 'BODY[]'), { literal8: false, value: message });
                done();
            });
        });

        it('encodes NUL octets of a 7bit part and of binary parts in an attached message', (t, done) => {
            const message =
                'Subject: outer\r\n' +
                'Content-Type: multipart/mixed; boundary="b"\r\n' +
                '\r\n' +
                '--b\r\n' +
                'Content-Type: text/plain\r\n' +
                '\r\n' +
                'a\x00b\r\n' +
                '--b\r\n' +
                'Content-Type: message/rfc822\r\n' +
                'Content-Transfer-Encoding: binary\r\n' +
                '\r\n' +
                'Subject: inner\r\n' +
                'Content-Type: application/octet-stream\r\n' +
                'Content-Transfer-Encoding: binary\r\n' +
                '\r\n' +
                '\x00\x00\x00\r\n' +
                '--b--\r\n';
            ctx.run([LOGIN, append8('A1', message), SELECT, 'A2 FETCH 4 (BINARY.PEEK[1] BINARY.PEEK[2.1] BODY.PEEK[])', 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                assert.match(resp, /^A1 OK /m);
                assert.deepStrictEqual(fetchValue(resp, 'BINARY[1]'), { literal8: true, value: 'a\x00b' });
                assert.deepStrictEqual(fetchValue(resp, 'BINARY[2.1]'), { literal8: true, value: '\x00\x00\x00' });
                // the attached message keeps its identity encoding (RFC 2046 section 5.2.1)
                assert.match(
                    fetchValue(resp, 'BODY[]').value,
                    /^Content-Type: message\/rfc822\r\nContent-Transfer-Encoding: binary\r\n\r\nSubject: inner\r\n/m
                );
                done();
            });
        });

        it('refuses NUL octets it can not store with NO [UNKNOWN-CTE] (RFC 3516 section 4.4)', (t, done) => {
            const header = 'Subject: a\x00b\r\n\r\nbody';
            const quoted = 'Subject: qp\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\na\x00b';
            ctx.run([LOGIN, append8('A1', header), append8('A2', quoted), 'A3 STATUS INBOX (MESSAGES)', 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                assert.match(resp, /^A1 NO \[UNKNOWN-CTE\] /m);
                assert.match(resp, /^A2 NO \[UNKNOWN-CTE\] /m);
                assert.match(resp, /^\* STATUS INBOX \(MESSAGES 3\)/m);
                done();
            });
        });

        it('refuses NUL octets in a literal, they need a literal8 (RFC 3501 section 9 CHAR8)', (t, done) => {
            ctx.run([LOGIN, 'A1 APPEND INBOX {9}\r\nSubject: \x00', 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                assert.match(resp, /^A1 BAD /m);
                done();
            });
        });

        it('refuses literal8 outside of the APPEND message without a continuation request', (t, done) => {
            ctx.run([LOGIN, 'A1 SELECT ~{5}\r\nINBOX', 'A2 LOGIN ~{8}\r\ntestuser testpass', 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                assert.match(resp, /^A1 BAD /m);
                assert.match(resp, /^A2 BAD /m);
                assert.doesNotMatch(resp, /^\+ /m);
                done();
            });
        });

        it('refuses a literal8 mailbox name', (t, done) => {
            ctx.run([LOGIN, 'A1 APPEND ~{5}\r\nINBOX {3}\r\nabc', 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                assert.match(resp, /^A1 BAD /m);
                done();
            });
        });

        it('refuses a non-synchronizing literal8 without LITERAL+ (RFC 4466 section 2.7)', (t, done) => {
            ctx.run([LOGIN, append8('A1', 'Subject: a\r\n\r\nb', true), 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                assert.match(resp, /^A1 BAD /m);
                done();
            });
        });
    });

    describe('APPEND with LITERAL+', () => {
        const ctx = setupServer(() => ({ plugins: ['BINARY', 'LITERAL+'], storage: storage() }));

        it('accepts a non-synchronizing literal8 (RFC 4466 section 2.7)', (t, done) => {
            ctx.run([LOGIN, append8('A1', BINARY_MESSAGE, true), SELECT, 'A2 FETCH 4 BINARY.PEEK[2]', 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                assert.doesNotMatch(resp, /^\+ /m);
                assert.match(resp, /^A1 OK /m);
                assert.deepStrictEqual(fetchValue(resp, 'BINARY[2]'), { literal8: true, value: BINARY_PART });
                done();
            });
        });
    });

    describe('with CONDSTORE', () => {
        const ctx = setupServer(() => ({ plugins: ['BINARY', 'CONDSTORE'], storage: storage() }));

        it('bumps MODSEQ when BINARY sets \\Seen, not when the FETCH fails', (t, done) => {
            ctx.run(
                [
                    LOGIN,
                    'A1 SELECT INBOX (CONDSTORE)',
                    'A2 FETCH 1 (BINARY[1] BINARY[4])',
                    'A3 FETCH 1 MODSEQ',
                    'A4 FETCH 1 BINARY[1]',
                    'A5 FETCH 1 MODSEQ',
                    'ZZ LOGOUT'
                ],
                resp => {
                    resp = resp.toString('binary');
                    const highest = Number(resp.match(/HIGHESTMODSEQ (\d+)/)[1]);
                    assert.match(resp, /^A2 NO \[UNKNOWN-CTE\]/m);
                    const modseqs = [...resp.matchAll(/^\* 1 FETCH \(MODSEQ \((\d+)\)\)/gm)].map(match => Number(match[1]));
                    assert.ok(modseqs[0] <= highest, resp);
                    assert.ok(modseqs[1] > highest, resp);
                    done();
                }
            );
        });
    });

    describe('decoders', () => {
        it('ignores characters outside the base64 alphabet (RFC 2045 section 6.8)', () => {
            assert.strictEqual(decodeBase64('aGVs\r\nbG8=\r\nIGlnbm9yZWQ='), 'hello');
            assert.strictEqual(decodeBase64('aGVs!!bG8'), 'hello');
            assert.strictEqual(decodeBase64('aGVsbG8gd'), 'hello ');
        });

        it('removes trailing white space and soft line breaks (RFC 2045 section 6.7)', () => {
            // lower case hex is accepted, an "=" without two hex digits is kept
            assert.strictEqual(decodeQuotedPrintable('a=\t\r\nb \r\nc=3d=3D=4'), 'ab\r\nc===4');
            assert.strictEqual(decodeQuotedPrintable('soft=\r\nbreak'), 'softbreak');
            assert.strictEqual(decodeQuotedPrintable('=E2=82=AC'), '\xe2\x82\xac');
        });
    });
});
