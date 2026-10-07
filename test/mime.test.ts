import { describe, it } from 'node:test';
import assert from 'node:assert';
import { setupServer } from './helpers/index.js';
import mimeParser, { normalizeLineBreaks, render } from '../src/mimeparser.js';
import bodystructure from '../src/bodystructure.js';
import envelope from '../src/envelope.js';
import addressparser from '../src/addressparser.js';

const structure = (raw: string) => bodystructure(mimeParser(raw), { upperCaseKeys: true, skipContentLocation: true });

const multipartWithRfc822 =
    'From: a@example.com\r\n' +
    'Subject: three\r\n' +
    'Content-Type: multipart/mixed; boundary="b1"\r\n' +
    '\r\n' +
    'pre\r\n' +
    '--b1\r\n' +
    'Content-Type: text/plain\r\n' +
    '\r\n' +
    'Part one\r\n' +
    'line2\r\n' +
    '--b1\r\n' +
    'Content-Type: message/rfc822\r\n' +
    '\r\n' +
    'From: inner@example.com\r\n' +
    'Subject: inner\r\n' +
    'Content-Type: multipart/alternative; boundary="b2"\r\n' +
    '\r\n' +
    '--b2\r\n' +
    'Content-Type: text/plain\r\n' +
    '\r\n' +
    'inner plain\r\n' +
    '--b2\r\n' +
    'Content-Type: text/html\r\n' +
    '\r\n' +
    '<b>x</b>\r\n' +
    '--b2--\r\n' +
    '\r\n' +
    '--b1--\r\n' +
    'epilogue\r\n';

const twelveParts =
    'Content-Type: multipart/mixed; boundary="x"\r\n\r\n' +
    Array.from({ length: 12 }, (v, i) => '--x\r\nContent-Type: text/plain\r\n\r\npart ' + (i + 1) + '\r\n').join('') +
    '--x--\r\n';

describe('MIME parser', () => {
    it('renders every message back to its CRLF source', () => {
        [
            multipartWithRfc822,
            twelveParts,
            'Subject: x\r\n\r\nno trailing line break',
            'Subject: x\nContent-Type: multipart/mixed; boundary="l"\n\n--l\nContent-Type: text/plain\n\nlf one\nlf two\n--l--\n',
            'Subject: pad\r\nContent-Type: multipart/mixed; boundary="p"\r\n\r\n--p  \r\nContent-Type: text/plain\r\n\r\nA\r\n--p\t\r\n\r\nB\r\n--p--  \r\n',
            'Subject: noblank\r\nContent-Type: multipart/mixed; boundary="n"\r\n\r\n--n\r\nContent-Type: text/plain\r\n--n\r\n\r\nX\r\n--n--\r\n',
            'Subject: unterminated\r\nContent-Type: multipart/mixed; boundary="u"\r\n\r\n--u\r\n\r\nX\r\n',
            'Subject: header only'
        ].forEach(raw => {
            assert.strictEqual(render(mimeParser(raw)), normalizeLineBreaks(raw));
        });
    });

    it('counts lines and sizes like Dovecot', () => {
        assert.deepStrictEqual(structure('Subject: x\r\n\r\nHello\r\nWorld').slice(5, 8), ['7BIT', 12, 1]);
        assert.deepStrictEqual(structure('Subject: x\r\n\r\nHello\r\nWorld\r\n').slice(5, 8), ['7BIT', 14, 2]);
        // the line break before a delimiter belongs to the delimiter, LF is counted as CRLF
        const lf = structure('Subject: x\nContent-Type: multipart/mixed; boundary="l"\n\n--l\nContent-Type: text/plain\n\nlf one\nlf two\n--l--\n');
        assert.deepStrictEqual(lf[0].slice(5, 8), ['7BIT', 14, 1]);
    });

    it('describes message/rfc822 parts with envelope, structure and line count', () => {
        const bs = structure(multipartWithRfc822);
        assert.deepStrictEqual(bs[1].slice(0, 7), ['MESSAGE', 'RFC822', null, null, null, '7BIT', 193]);
        assert.strictEqual(bs[1][7][1], 'inner');
        assert.strictEqual(bs[1][8][2], 'ALTERNATIVE');
        assert.strictEqual(bs[1][9], 13);
    });

    it('describes other message subtypes as basic parts', () => {
        const bs = structure(
            'Content-Type: multipart/report; report-type=delivery-status; boundary="r"\r\n\r\n' +
                '--r\r\nContent-Type: text/plain\r\n\r\nFailed\r\n' +
                '--r\r\nContent-Type: message/delivery-status\r\n\r\nReporting-MTA: dns; example.com\r\n\r\nAction: failed\r\n' +
                '--r\r\nContent-Type: Message/RFC822\r\n\r\nSubject: orig\r\n\r\nbody\r\n' +
                '--r--\r\n'
        );
        assert.deepStrictEqual(bs[1], ['MESSAGE', 'DELIVERY-STATUS', null, null, null, '7BIT', 49, null, null, null]);
        // the subtype is case insensitive
        assert.strictEqual(bs[2][7][1], 'orig');
    });

    it('defaults digest parts to message/rfc822', () => {
        const bs = structure('Content-Type: multipart/digest; boundary="d"\r\n\r\n--d\r\n\r\nSubject: d1\r\n\r\nbody1\r\n--d--\r\n');
        assert.deepStrictEqual(bs[0].slice(0, 2), ['MESSAGE', 'RFC822']);
        assert.strictEqual(bs[0][7][1], 'd1');
    });

    it('handles malformed multiparts', () => {
        // no boundary parameter: described as a basic part
        assert.deepStrictEqual(structure('Content-Type: multipart/mixed\r\n\r\ntext\r\n').slice(0, 2), ['MULTIPART', 'MIXED']);
        // boundary never seen: a placeholder part keeps the structure valid
        assert.deepStrictEqual(structure('Content-Type: multipart/mixed; boundary="z"\r\n\r\ntext\r\n')[0].slice(0, 2), ['TEXT', 'PLAIN']);
        // padding after the boundary
        const padded = structure('Content-Type: multipart/mixed; boundary="p"\r\n\r\n--p  \r\n\r\nA\r\n--p\t\r\n\r\nB\r\n--p--  \r\n');
        assert.strictEqual(padded.length, 2 + 4);
        assert.deepStrictEqual(padded[1].slice(5, 8), ['7BIT', 1, 0]);
        // a part header without a blank line
        const noBlank = structure('Content-Type: multipart/mixed; boundary="n"\r\n\r\n--n\r\nContent-Type: text/html\r\n--n\r\n\r\nX\r\n--n--\r\n');
        assert.deepStrictEqual(noBlank[0].slice(0, 2), ['TEXT', 'HTML']);
        assert.deepStrictEqual(noBlank[1].slice(5, 7), ['7BIT', 1]);
    });

    it('uses the last value of duplicate single value headers', () => {
        const tree = mimeParser(
            'Subject: one\r\nSubject: two\r\nContent-Transfer-Encoding: 7bit\r\nContent-Transfer-Encoding: base64\r\nMessage-ID: <a@x>\r\nMessage-ID: <b@x>\r\n\r\nx'
        );
        const env = envelope(tree.parsedHeader);
        assert.strictEqual(env[1], 'two');
        assert.strictEqual(env[9], '<b@x>');
        assert.strictEqual(bodystructure(tree, { upperCaseKeys: true })[5], 'BASE64');
    });

    it('parses quoted and RFC 2231 parameters', () => {
        const bs = structure(
            'Content-Type: text/plain; name="a;b \\"c\\""; charset=us-ascii\r\n' +
                "Content-Disposition: attachment; filename*0*=utf-8''%C3%B5; filename*1=x.txt; title*=iso-8859-1'en'%F5\r\n" +
                '\r\nbody'
        );
        assert.deepStrictEqual(bs[2], ['NAME', 'a;b "c"', 'CHARSET', 'us-ascii']);
        assert.deepStrictEqual(bs[9], ['ATTACHMENT', ['FILENAME', '\xc3\xb5x.txt', 'TITLE', '\xc3\xb5']]);
    });

    it('does not pollute prototypes with header or parameter names', () => {
        const tree = mimeParser(
            "Content-Type: text/plain; __proto__*0*=utf-8''x; constructor*0*=y; toString=z\r\n" + 'Constructor: x\r\n__proto__: y\r\n\r\nbody'
        );
        assert.strictEqual(({} as Record<number, unknown>)[0], undefined);
        assert.strictEqual(Object.prototype.toString.call({}), '[object Object]');
        assert.strictEqual(tree.parsedHeader['content-type'].params.constructor, 'y');
        assert.strictEqual(tree.parsedHeader['content-type'].params.tostring, 'z');
        assert.strictEqual(tree.parsedHeader.constructor, 'x');
    });

    it('builds ENVELOPE with NIL subject and date when missing', () => {
        assert.deepStrictEqual(envelope(mimeParser('From: a@example.com\r\n\r\nbody').parsedHeader), [
            null,
            null,
            [[null, null, 'a', 'example.com']],
            [[null, null, 'a', 'example.com']],
            [[null, null, 'a', 'example.com']],
            null,
            null,
            null,
            null,
            null
        ]);
    });

    it('does not encode an address without a domain as a group marker', () => {
        const env = envelope(mimeParser('From: localuser\r\nTo: "Name" <user@example.com>, undisclosed-recipients:;\r\n\r\nbody').parsedHeader);
        assert.deepStrictEqual(env[2], [[null, null, 'localuser', 'MISSING_DOMAIN']]);
        assert.deepStrictEqual(env[5], [
            ['Name', null, 'user', 'example.com'],
            [null, null, 'undisclosed-recipients', null],
            [null, null, null, null]
        ]);
    });

    it('parses deeply nested groups in linear time', () => {
        const start = Date.now();
        const result = addressparser('g:'.repeat(50000) + 'a@b;');
        assert.ok(Date.now() - start < 1000);
        assert.strictEqual(result.length, 1);
        assert.strictEqual(result[0].name, 'g');
        assert.strictEqual(result[0].group!.length, 1);
    });
});

describe('FETCH body sections', () => {
    const ctx = setupServer(() => ({
        storage: {
            INBOX: {
                messages: [
                    { raw: multipartWithRfc822 },
                    { raw: twelveParts },
                    { raw: 'Subject: lf\nContent-Type: multipart/mixed; boundary="l"\n\n--l\nContent-Type: text/plain\n\nlf one\nlf two\n--l--\n' },
                    { raw: 'From: a@example.com\r\n\r\nbody' }
                ]
            }
        }
    }));

    it('BODY[TEXT] of a multipart keeps the part headers', (t, done) => {
        ctx.run(['A1 LOGIN testuser testpass', 'A2 EXAMINE INBOX', 'A3 FETCH 1 (BODY[TEXT] BODY[2.TEXT] RFC822.TEXT)', 'ZZ LOGOUT'], resp => {
            resp = resp.toString('binary');
            const text = multipartWithRfc822.substr(multipartWithRfc822.indexOf('\r\n\r\n') + 4);
            assert.ok(resp.indexOf('BODY[TEXT] {' + text.length + '}\r\n' + text) >= 0, resp);
            assert.ok(resp.indexOf('RFC822.TEXT {' + text.length + '}\r\n' + text) >= 0);
            assert.ok(
                resp.indexOf(
                    'BODY[2.TEXT] {98}\r\n--b2\r\nContent-Type: text/plain\r\n\r\ninner plain\r\n--b2\r\nContent-Type: text/html\r\n\r\n<b>x</b>\r\n--b2--'
                ) >= 0
            );
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('BODY[n.HEADER] and BODY[n.MIME] of a message/rfc822 part', (t, done) => {
        ctx.run(['A1 LOGIN testuser testpass', 'A2 EXAMINE INBOX', 'A3 FETCH 1 (BODY[2.HEADER] BODY[2.MIME] BODY[2.2.MIME])', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.ok(
                resp.indexOf(
                    'BODY[2.HEADER] {95}\r\nFrom: inner@example.com\r\nSubject: inner\r\nContent-Type: multipart/alternative; boundary="b2"\r\n\r\n BODY[2.MIME] {32}\r\nContent-Type: message/rfc822\r\n\r\n BODY[2.2.MIME] {27}\r\nContent-Type: text/html\r\n\r\n)'
                ) >= 0,
                resp
            );
            done();
        });
    });

    it('part numbers above 9 and missing parts', (t, done) => {
        ctx.run(
            ['A1 LOGIN testuser testpass', 'A2 EXAMINE INBOX', 'A3 FETCH 2 (BODY[12] BODY[10.MIME])', 'A4 FETCH 2 (BODY[13] BODY[1.5])', 'ZZ LOGOUT'],
            resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('* 2 FETCH (BODY[12] {7}\r\npart 12 BODY[10.MIME] {28}\r\nContent-Type: text/plain\r\n\r\n)') >= 0, resp);
                assert.ok(resp.indexOf('* 2 FETCH (BODY[13] {0}\r\n BODY[1.5] {0}\r\n)') >= 0);
                assert.ok(resp.indexOf('\nA4 OK') >= 0);
                done();
            }
        );
    });

    it('serves LF-only messages with CRLF and matching sizes', (t, done) => {
        ctx.run(['A1 LOGIN testuser testpass', 'A2 EXAMINE INBOX', 'A3 FETCH 3 (RFC822.SIZE BODY[] BODY[1])', 'A4 SEARCH LARGER 99', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            const raw =
                'Subject: lf\r\nContent-Type: multipart/mixed; boundary="l"\r\n\r\n--l\r\nContent-Type: text/plain\r\n\r\nlf one\r\nlf two\r\n--l--\r\n';
            assert.ok(
                resp.indexOf('* 3 FETCH (RFC822.SIZE ' + raw.length + ' BODY[] {' + raw.length + '}\r\n' + raw + ' BODY[1] {14}\r\nlf one\r\nlf two)') >= 0,
                resp
            );
            assert.ok(resp.indexOf('* SEARCH 1 2 3\r\n') >= 0);
            done();
        });
    });

    it('ENVELOPE has NIL subject and date when missing', (t, done) => {
        ctx.run(['A1 LOGIN testuser testpass', 'A2 EXAMINE INBOX', 'A3 FETCH 4 ENVELOPE', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('* 4 FETCH (ENVELOPE (NIL NIL ((NIL NIL "a" "example.com"))') >= 0, resp);
            done();
        });
    });

    it('RFC822.TEXT sets \\Seen, RFC822.HEADER does not', (t, done) => {
        ctx.run(
            ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 FETCH 4 RFC822.HEADER', 'A4 FETCH 4 FLAGS', 'A5 FETCH 4 RFC822.TEXT', 'ZZ LOGOUT'],
            resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('* 4 FETCH (RFC822.HEADER {23}\r\nFrom: a@example.com\r\n\r\n)') >= 0, resp);
                assert.ok(resp.indexOf('* 4 FETCH (FLAGS ())') >= 0);
                assert.ok(resp.indexOf('* 4 FETCH (RFC822.TEXT {4}\r\nbody FLAGS (\\Seen))') >= 0);
                done();
            }
        );
    });

    it('rejects a partial range without a length', (t, done) => {
        ctx.run(['A1 LOGIN testuser testpass', 'A2 EXAMINE INBOX', 'A3 FETCH 4 BODY[]<5>', 'A4 FETCH 4 BODY[]<5.0>', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA3 BAD') >= 0, resp);
            assert.ok(resp.indexOf('\nA4 BAD') >= 0);
            assert.ok(resp.indexOf('FETCH (BODY[]') < 0);
            done();
        });
    });
});

describe('FETCH of a storage message without a source', () => {
    const ctx = setupServer(() => ({
        storage: {
            INBOX: {
                messages: [{ flags: ['\\Seen'] }]
            }
        }
    }));

    it('returns empty contents', (t, done) => {
        ctx.run(['A1 LOGIN testuser testpass', 'A2 EXAMINE INBOX', 'A3 FETCH 1 (RFC822.SIZE BODY[] BODYSTRUCTURE ENVELOPE)', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('* 1 FETCH (RFC822.SIZE 0 BODY[] {0}\r\n BODYSTRUCTURE ("TEXT" "PLAIN" NIL NIL NIL "7BIT" 0 0 NIL NIL NIL)') >= 0, resp);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });
});
