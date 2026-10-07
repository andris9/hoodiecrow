// PREVIEW, RFC 8970 (https://www.rfc-editor.org/rfc/rfc8970.txt)

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { setupServer } from './helpers/index.js';

const HEADER = 'From: a@example.com\r\nSubject: test\r\nMIME-Version: 1.0\r\n';

// [description, message source, expected preview as a unicode string]
const MESSAGES = [
    ['plain text with collapsed whitespace', HEADER + '\r\n  Hello   world!\r\n\r\nSecond\tline.  \r\n', 'Hello world! Second line.'],
    [
        'quoted-printable ISO-8859-1',
        HEADER + 'Content-Type: text/plain; charset=ISO-8859-1\r\nContent-Transfer-Encoding: Quoted-Printable\r\n\r\nH=E9llo soft=\r\nbreak =3D sign  \r\n',
        'Héllo softbreak = sign'
    ],
    [
        'base64 UTF-8',
        HEADER +
            'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
            Buffer.from('Tere õhtust!', 'utf8').toString('base64') +
            '\r\n',
        'Tere õhtust!'
    ],
    ['8bit KOI8-R', HEADER + 'Content-Type: text/plain; charset=koi8-r\r\nContent-Transfer-Encoding: 8bit\r\n\r\n\xf0\xd2\xc9\xd7\xc5\xd4\r\n', 'Привет'],
    ['unknown charset decoded as UTF-8', HEADER + 'Content-Type: text/plain; charset=x-unknown\r\n\r\nUnknown \xe9 charset\r\n', 'Unknown � charset'],
    ['control characters removed', HEADER + '\r\nNUL\x00char\x01 and\x0bvt\x7f\r\n', 'NULchar and vt'],
    [
        'HTML without markup, non-rendered elements and quotes',
        HEADER +
            'Content-Type: text/html; charset=utf-8\r\n\r\n<html><head><title>Title</title><style>p{color:red}</style></head><body>' +
            '<script>var x = 1;</script><!-- comment --><p>Para &amp; one&nbsp;two &lt;tag&gt; &#228;&#x263A; &eacute; &unknown;</p>' +
            '<div>wo<b>rd</b></div><blockquote>quoted <blockquote>nested</blockquote> text</blockquote><br>after</body></html>\r\n',
        'Para & one two <tag> ä☺ é &unknown; word after'
    ],
    ['HTML with only quoted text', HEADER + 'Content-Type: text/html\r\n\r\n<blockquote>only quoted</blockquote>\r\n', 'only quoted'],
    ['quoted lines left out', HEADER + '\r\nSomeone wrote:\r\n> quoted line\r\n>> more\r\nReply\r\n', 'Someone wrote: Reply'],
    ['only quoted lines', HEADER + '\r\n> only quoted\r\n> text\r\n', '> only quoted > text'],
    [
        'text/plain preferred in multipart/alternative',
        HEADER +
            'Content-Type: multipart/alternative; boundary=b\r\n\r\n--b\r\nContent-Type: text/html\r\n\r\n<p>HTML</p>\r\n--b\r\nContent-Type: text/plain\r\n\r\nPlain\r\n--b--\r\n',
        'Plain'
    ],
    [
        'text/html when the alternative has no text/plain',
        HEADER +
            'Content-Type: multipart/mixed; boundary=m\r\n\r\n--m\r\nContent-Type: multipart/alternative; boundary=a\r\n\r\n--a\r\nContent-Type: text/html\r\n\r\n<p>HTML only</p>\r\n--a--\r\n' +
            '--m\r\nContent-Type: text/plain\r\n\r\nSecond part\r\n--m--\r\n',
        'HTML only'
    ],
    [
        'attachments are skipped',
        HEADER +
            'Content-Type: multipart/mixed; boundary=m\r\n\r\n--m\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename=a.txt\r\n\r\nAttached\r\n' +
            '--m\r\nContent-Type: application/pdf\r\n\r\nPDF\r\n--m\r\nContent-Type: text/plain\r\n\r\nBody text\r\n--m--\r\n',
        'Body text'
    ],
    [
        'multipart without text parts',
        HEADER + 'Content-Type: multipart/mixed; boundary=m\r\n\r\n--m\r\nContent-Type: application/pdf\r\n\r\nPDF\r\n--m--\r\n',
        ''
    ],
    ['image only', HEADER + 'Content-Type: image/png\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0KGgo=\r\n', ''],
    ['empty body', HEADER + '\r\n', ''],
    ['attached message only', HEADER + 'Content-Type: message/rfc822\r\n\r\nSubject: inner\r\n\r\nInner body\r\n', ''],
    [
        'encrypted message',
        HEADER +
            'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary=e\r\n\r\n--e\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n' +
            '--e\r\nContent-Type: text/plain\r\n\r\nnot a preview\r\n--e--\r\n',
        ''
    ],
    ['unknown transfer encoding', HEADER + 'Content-Transfer-Encoding: x-uuencode\r\n\r\nbegin 644 a\r\n', ''],
    ['other text types', HEADER + 'Content-Type: text/calendar\r\n\r\nBEGIN:VCALENDAR\r\n', ''],
    [
        'signed message',
        HEADER +
            'Content-Type: multipart/signed; boundary=s\r\n\r\n--s\r\nContent-Type: text/plain\r\n\r\nSigned text\r\n--s\r\nContent-Type: application/pgp-signature\r\n\r\nsig\r\n--s--\r\n',
        'Signed text'
    ]
];

// Parses the PREVIEW values of all FETCH responses, keyed by sequence number. Literals are UTF-8 octets
function previews(resp: string): Record<string, string | null> {
    const result: Record<string, string | null> = {};
    const re = /^\* (\d+) FETCH \(.*?PREVIEW (?:"((?:[^"\\]|\\.)*)"|\{(\d+)\}\r\n|(NIL))/gm;
    let match: RegExpExecArray | null;
    while ((match = re.exec(resp))) {
        if (match[3]) {
            const start = match.index + match[0].length;
            result[match[1]] = Buffer.from(resp.substr(start, Number(match[3])), 'binary').toString('utf8');
        } else if (match[4]) {
            result[match[1]] = null;
        } else {
            result[match[1]] = match[2].replace(/\\(.)/g, '$1');
        }
    }
    return result;
}

const login = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX'];

describe('PREVIEW', () => {
    describe('preview generation, RFC 8970 3.3', () => {
        const ctx = setupServer(() => ({
            plugins: ['PREVIEW'],
            storage: {
                INBOX: { messages: MESSAGES.map(([, raw]) => ({ raw })) },
                '': {}
            }
        }));

        it('advertises the PREVIEW capability (RFC 8970 1)', (t, done) => {
            ctx.run(['A1 CAPABILITY', 'ZZ LOGOUT'], resp => {
                assert.ok(/^\* CAPABILITY .*\bPREVIEW\b/m.test(resp.toString()), resp.toString());
                done();
            });
        });

        it('generates previews', (t, done) => {
            ctx.run([...login, 'A3 FETCH 1:* (PREVIEW)', 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                assert.ok(/^A3 OK/m.test(resp), resp);
                const result = previews(resp);
                MESSAGES.forEach(([description, , expected], i) => {
                    assert.strictEqual(result[i + 1], expected, description);
                });
                done();
            });
        });

        it('sends 8-bit previews as literals of UTF-8 octets (RFC 8970 3.3)', (t, done) => {
            ctx.run([...login, 'A3 FETCH 2 PREVIEW', 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                assert.ok(resp.indexOf('* 2 FETCH (PREVIEW {23}\r\nH\xc3\xa9llo softbreak = sign)\r\n') >= 0, resp);
                done();
            });
        });

        it('does not set \\Seen', (t, done) => {
            ctx.run([...login, 'A3 FETCH 1 (PREVIEW)', 'A4 FETCH 1 (FLAGS)', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.ok(/^\* 1 FETCH \(FLAGS \(\)\)/m.test(resp), resp);
                done();
            });
        });

        it('works with UID FETCH and other data items', (t, done) => {
            ctx.run([...login, 'A3 UID FETCH 1 (UID PREVIEW RFC822.SIZE)', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.ok(/^\* 1 FETCH \(UID 1 PREVIEW "Hello world! Second line\." RFC822\.SIZE \d+\)$/m.test(resp), resp);
                done();
            });
        });

        // RFC 8970 has no PREVIEW search key
        it('has no PREVIEW search key', (t, done) => {
            ctx.run([...login, 'A3 SEARCH PREVIEW hello', 'ZZ LOGOUT'], resp => {
                assert.ok(/^A3 BAD/m.test(resp.toString()), resp.toString());
                done();
            });
        });
    });

    describe('preview length, RFC 8970 3.3', () => {
        const long = Array.from({ length: 300 }, (_, i) => String.fromCharCode(0x3042 + (i % 80))).join('');
        const ctx = setupServer(() => ({
            plugins: ['PREVIEW'],
            storage: {
                INBOX: {
                    messages: [
                        { raw: HEADER + 'Content-Type: text/plain; charset=utf-8\r\n\r\n' + long + '\r\n' },
                        { raw: HEADER + '\r\n' + 'word '.repeat(100) + '\r\n' },
                        { raw: HEADER + '\r\nbody\r\n', preview: '  Custom\r\n\tpreview\x00 ' + 'x'.repeat(300) },
                        { raw: HEADER + '\r\nbody\r\n', preview: '' },
                        // only the start of a large part is decoded
                        {
                            raw:
                                HEADER +
                                'Content-Type: text/html\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
                                Buffer.from('<blockquote>' + '<p>Big</p> '.repeat(300000))
                                    .toString('base64')
                                    .replace(/.{76}/g, '$&\r\n')
                        },
                        { raw: HEADER + 'Content-Transfer-Encoding: quoted-printable\r\n\r\nPadded' + ' '.repeat(500000) + 'x\r\n' }
                    ]
                },
                '': {}
            }
        }));

        it('limits generated previews to 200 characters (SHOULD) and the storage value to 256 (MUST NOT exceed)', (t, done) => {
            ctx.run([...login, 'A3 FETCH 1:6 PREVIEW', 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                const result = previews(resp);
                // characters, not octets
                assert.strictEqual(result[1], long.slice(0, 200));
                assert.ok(resp.indexOf('PREVIEW {600}\r\n') >= 0, resp);
                // the cut leaves no trailing space
                assert.strictEqual(result[2], 'word '.repeat(40).trim());
                // whitespace and control characters are normalized in the storage value too
                assert.strictEqual(result[3], ('Custom preview ' + 'x'.repeat(300)).slice(0, 256));
                assert.strictEqual(result[4], '');
                // an unclosed blockquote holds all the text, so it is used after all
                assert.strictEqual(result[5], 'Big '.repeat(50).trim());
                assert.strictEqual(result[6], 'Padded');
                done();
            });
        });
    });

    describe('LAZY modifier, RFC 8970 4.1', () => {
        const ctx = setupServer(() => ({
            plugins: ['PREVIEW'],
            storage: {
                INBOX: {
                    messages: [{ raw: HEADER + '\r\nFirst\r\n' }, { raw: HEADER + '\r\nSecond\r\n' }, { raw: HEADER + '\r\nThird\r\n', preview: 'Stored' }]
                },
                '': {}
            }
        }));

        it('returns NIL until the preview has been generated', (t, done) => {
            const cmds = [...login, 'A3 FETCH 1:3 (PREVIEW (LAZY) FLAGS)', 'A4 FETCH 2 (PREVIEW)', 'A5 FETCH 1:3 (FLAGS PREVIEW (LAZY))', 'ZZ LOGOUT'];
            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(/^\* 1 FETCH \(PREVIEW NIL FLAGS \(\)\)$/m.test(resp), resp);
                assert.ok(/^\* 2 FETCH \(PREVIEW NIL FLAGS \(\)\)$/m.test(resp), resp);
                // the storage value is always available
                assert.ok(/^\* 3 FETCH \(PREVIEW "Stored" FLAGS \(\)\)$/m.test(resp), resp);
                assert.ok(/^\* 2 FETCH \(PREVIEW "Second"\)$/m.test(resp), resp);
                assert.ok(/^\* 1 FETCH \(FLAGS \(\) PREVIEW NIL\)$/m.test(resp), resp);
                assert.ok(/^\* 2 FETCH \(FLAGS \(\) PREVIEW "Second"\)$/m.test(resp), resp);
                assert.ok(/^A5 OK/m.test(resp), resp);
                done();
            });
        });

        // RFC 8970 6: fetch-att =/ "PREVIEW" [SP "(" preview-mod *(SP preview-mod) ")"]
        it('accepts the modifier on a single data item, repeated and in any case', (t, done) => {
            const cmds = [...login, 'A3 FETCH 3 PREVIEW (LAZY)', 'A4 UID FETCH 3 (PREVIEW (lazy LAZY))', 'ZZ LOGOUT'];
            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(/^\* 3 FETCH \(PREVIEW "Stored"\)$/m.test(resp), resp);
                assert.ok(/^\* 3 FETCH \(PREVIEW "Stored" UID 3\)$/m.test(resp), resp);
                assert.ok(/^A4 OK/m.test(resp), resp);
                done();
            });
        });
    });

    describe('strict syntax, RFC 8970 6', () => {
        const ctx = setupServer(() => ({
            plugins: ['PREVIEW'],
            storage: { INBOX: { messages: [{ raw: HEADER + '\r\nHello\r\n' }] }, '': {} }
        }));

        const CASES = [
            ['FETCH without arguments', 'FETCH'],
            ['empty modifier list', 'FETCH 1 (PREVIEW ())'],
            ['unknown modifier', 'FETCH 1 (PREVIEW (FOO))'],
            ['unknown modifier on a single data item', 'FETCH 1 PREVIEW (FOO)'],
            ['modifier that is not an atom', 'FETCH 1 (PREVIEW ("LAZY"))'],
            ['nested modifier list', 'FETCH 1 (PREVIEW ((LAZY)))'],
            ['modifier without parentheses', 'FETCH 1 (PREVIEW LAZY)'],
            ['modifier list without PREVIEW', 'FETCH 1 (FLAGS (LAZY))'],
            ['section', 'FETCH 1 PREVIEW[]'],
            ['PREVIEW.PEEK', 'FETCH 1 PREVIEW.PEEK'],
            ['FETCH modifiers without CONDSTORE', 'FETCH 1 PREVIEW (LAZY) (LAZY)']
        ];

        for (const [description, command] of CASES) {
            it('refuses ' + description, (t, done) => {
                ctx.run([...login, 'A3 ' + command, 'ZZ LOGOUT'], resp => {
                    resp = resp.toString();
                    assert.ok(/^A3 BAD/m.test(resp), resp);
                    assert.ok(!/^\* 1 FETCH/m.test(resp), resp);
                    done();
                });
            });
        }
    });

    describe('without the plugin', () => {
        const ctx = setupServer(() => ({
            storage: { INBOX: { messages: [{ raw: HEADER + '\r\nHello\r\n', preview: 'Stored' }] }, '': {} }
        }));

        it('leaves no trace', (t, done) => {
            ctx.run(['A0 CAPABILITY', ...login, 'A3 FETCH 1 PREVIEW', 'A4 FETCH 1 (PREVIEW (LAZY))', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.ok(!/^\* CAPABILITY .*\bPREVIEW\b/m.test(resp), resp);
                assert.ok(/^A3 BAD/m.test(resp), resp);
                assert.ok(/^A4 BAD/m.test(resp), resp);
                done();
            });
        });
    });

    // The CONDSTORE FETCH modifier follows the PREVIEW modifiers, whatever order the plugins are loaded in
    for (const plugins of [
        ['PREVIEW', 'CONDSTORE'],
        ['CONDSTORE', 'PREVIEW']
    ]) {
        describe('with ' + plugins.join(' and '), () => {
            const ctx = setupServer(() => ({
                plugins,
                storage: { INBOX: { messages: [{ raw: HEADER + '\r\nHello\r\n' }, { raw: HEADER + '\r\nWorld\r\n', MODSEQ: 50 }] }, '': {} }
            }));

            it('accepts PREVIEW (LAZY) with CHANGEDSINCE (RFC 7162 3.1.4.1)', (t, done) => {
                const cmds = [
                    ...login,
                    'A3 FETCH 1:* PREVIEW (LAZY) (CHANGEDSINCE 10)',
                    'A4 FETCH 1:* PREVIEW (CHANGEDSINCE 10)',
                    'A5 FETCH 1:* (PREVIEW (LAZY) UID) (CHANGEDSINCE 10)',
                    'A6 FETCH 1 PREVIEW (LAZY) (CHANGEDSINCE x)',
                    'ZZ LOGOUT'
                ];
                ctx.run(cmds, resp => {
                    resp = resp.toString();
                    assert.ok(/^\* 2 FETCH \(PREVIEW NIL MODSEQ \(50\)\)\r\nA3 OK/m.test(resp), resp);
                    assert.ok(/^\* 2 FETCH \(PREVIEW "World" MODSEQ \(50\)\)\r\nA4 OK/m.test(resp), resp);
                    assert.ok(/^\* 2 FETCH \(PREVIEW "World" UID 2 MODSEQ \(50\)\)\r\nA5 OK/m.test(resp), resp);
                    assert.ok(!/^\* 1 FETCH/m.test(resp), resp);
                    assert.ok(/^A6 BAD/m.test(resp), resp);
                    done();
                });
            });
        });
    }

    // RFC 8970 5 example 3: previews of a saved search result (RFC 5182)
    describe('with SEARCHRES', () => {
        const ctx = setupServer(() => ({
            plugins: ['ESEARCH', 'SEARCHRES', 'PREVIEW'],
            storage: { INBOX: { messages: [{ raw: HEADER + '\r\nHello\r\n' }, { raw: 'From: foo@example.com\r\n\r\nWorld\r\n' }] }, '': {} }
        }));

        it('fetches previews for $', (t, done) => {
            const cmds = [...login, 'A3 SEARCH RETURN (SAVE) FROM "foo"', 'A4 FETCH $ (UID PREVIEW (LAZY))', 'A5 UID FETCH 2 (PREVIEW)', 'ZZ LOGOUT'];
            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.ok(/^\* 2 FETCH \(UID 2 PREVIEW NIL\)\r\nA4 OK/m.test(resp), resp);
                assert.ok(/^\* 2 FETCH \(PREVIEW "World" UID 2\)\r\nA5 OK/m.test(resp), resp);
                done();
            });
        });
    });
});
