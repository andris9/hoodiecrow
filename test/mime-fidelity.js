'use strict';

// MIME fidelity tests, modelled on WildDuck's indexer fidelity tests. Every fixture in
// test/fixtures/mime and compare/messages is stored as a message, and the FETCH output is checked
// against properties that must hold for any message:
//
// - BODY[] is the source with CRLF line breaks, and RFC822.SIZE is its length (RFC 3501 6.4.5, 7.4.2)
// - BODY[HEADER] followed by BODY[TEXT] is BODY[] (RFC 3501 6.4.5)
// - every BODYSTRUCTURE size is the length of BODY[part], and the line count of text and
//   message/rfc822 parts is the number of lines of BODY[part] (RFC 3501 7.4.2 body-fld-octets, body-fld-lines)
// - BODY[part.MIME] followed by BODY[part] is a slice of BODY[] (RFC 3501 6.4.5)
// - partial fetches BODY[]<origin.length> are slices of BODY[] (RFC 3501 6.4.5)
// - BODYSTRUCTURE and ENVELOPE parse with ImapFlow's parser, use no 8-bit quoted strings (RFC 3501 9,
//   QUOTED-CHAR is 7-bit) and compile back to the same values

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const imapHandler = require('imapflow/lib/handler/imap-handler.js');
const { parseBodystructure, parseEnvelope } = require('imapflow/lib/tools.js');
const { setupServer } = require('./helpers');
const { openSession } = require('./helpers/session');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIRS = [path.join(__dirname, 'fixtures', 'mime'), path.join(ROOT, 'compare', 'messages')];

const fixtures = [];
FIXTURE_DIRS.forEach(dir => {
    fs.readdirSync(dir)
        .filter(name => /\.eml$/.test(name))
        .sort()
        .forEach(name => {
            fixtures.push({
                name: path.relative(ROOT, path.join(dir, name)),
                // binary string, one character per octet
                raw: fs.readFileSync(path.join(dir, name)).toString('binary')
            });
        });
});

// FETCH output for some fixtures, written in the RFC 3501 9 wire form and checked against Dovecot 2.4
// (npm run compare). The values agree with Dovecot. Dovecot differs only where the RFC leaves a choice: it
// lowercases strings, adds the default charset us-ascii (RFC 2045 5.2) and sends body-fld-loc and body-fld-lang,
// while ImapKit leaves out trailing extension fields (RFC 3501 7.4.2 allows omitting extension data).
//
// The grammar puts no SP between the parts of a multipart body (body-type-mpart = 1*body SP media-subtype) or
// between the addresses of an address list (env-from = "(" 1*address ")" / nil), Dovecot sends ")(" there.
const GOLDEN = {
    'test/fixtures/mime/nested.eml': {
        BODYSTRUCTURE:
            '(("TEXT" "PLAIN" ("CHARSET" "us-ascii") NIL NIL "7BIT" 31 1 NIL NIL NIL)' +
            '("MESSAGE" "RFC822" NIL NIL "forwarded" "7BIT" 399 ("Sun, 04 Oct 2026 18:00:00 +0000" "Inner subject" (("Inner" NIL "inner" "example.com")) (("Inner" NIL "inner" "example.com")) (("Inner" NIL "inner" "example.com")) ((NIL NIL "outer" "example.com")) NIL NIL NIL NIL) ' +
            '(("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 29 1 NIL NIL NIL)("TEXT" "HTML" ("CHARSET" "utf-8") NIL NIL "7BIT" 24 0 NIL NIL NIL) "ALTERNATIVE" ("BOUNDARY" "inner") NIL NIL) 18 NIL NIL NIL)' +
            '("IMAGE" "PNG" ("NAME" "pixels.png") "<pixels@example.com>" NIL "BASE64" 700 NIL ("ATTACHMENT" ("FILENAME" "pixels.png")) NIL) "MIXED" ("BOUNDARY" "outer") NIL NIL)',
        ENVELOPE:
            '("Mon, 05 Oct 2026 09:15:00 +0200" "Nested message" (("Outer Sender" NIL "outer" "example.com")) (("Outer Sender" NIL "outer" "example.com")) (("Outer Sender" NIL "outer" "example.com")) ' +
            '(("Recipient" NIL "rcpt" "example.com")(NIL NIL "other" "example.com")) NIL NIL NIL "<nested@example.com>")'
    },
    'test/fixtures/mime/digest.eml': {
        BODYSTRUCTURE:
            '(("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 61 (NIL "First post" ((NIL NIL "first" "example.com")) ((NIL NIL "first" "example.com")) ((NIL NIL "first" "example.com")) NIL NIL NIL NIL NIL) ("TEXT" "PLAIN" NIL NIL NIL "7BIT" 13 1 NIL NIL NIL) 4 NIL NIL NIL)' +
            '("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 118 (NIL "Second post" ((NIL NIL "second" "example.com")) ((NIL NIL "second" "example.com")) ((NIL NIL "second" "example.com")) NIL NIL NIL NIL NIL) ("TEXT" "PLAIN" ("CHARSET" "us-ascii") NIL NIL "7BIT" 24 2 NIL NIL NIL) 6 NIL NIL NIL)' +
            '("TEXT" "PLAIN" NIL NIL NIL "7BIT" 32 0 NIL NIL NIL) "DIGEST" ("BOUNDARY" "dig") NIL NIL)'
    },
    'test/fixtures/mime/rfc2231.eml': {
        BODYSTRUCTURE:
            '(("TEXT" "PLAIN" ("CHARSET" "us-ascii" "FORMAT" "flowed") NIL NIL "7BIT" 22 0 NIL NIL NIL)' +
            '("APPLICATION" "PDF" ("NAME" {18}\r\n\xc3\x84rger und \xc3\x96l.pdf) NIL NIL "BASE64" 12 NIL ("ATTACHMENT" ("SIZE" "12" "FILENAME" "a very long file name that continues here.pdf")) ("de" "en")) "MIXED" ("BOUNDARY" "simple") NIL NIL)'
    },
    'test/fixtures/mime/base64-attachment.eml': {
        BODYSTRUCTURE:
            '("APPLICATION" "OCTET-STREAM" ("NAME" "blob.bin") NIL "binary blob" "BASE64" 276 "Q2hlY2sgSW50ZWdyaXR5IQ==" ("ATTACHMENT" ("FILENAME" "blob.bin")) NIL)'
    },
    'test/fixtures/mime/lf-only.eml': {
        BODYSTRUCTURE:
            '(("TEXT" "PLAIN" NIL NIL NIL "7BIT" 18 1 NIL NIL NIL)("TEXT" "PLAIN" ("NAME" "b.txt") NIL NIL "7BIT" 15 0 NIL ("ATTACHMENT" NIL) NIL) "MIXED" ("BOUNDARY" "lf") NIL NIL)'
    },
    'test/fixtures/mime/missing-end-boundary.eml': {
        BODYSTRUCTURE:
            '(("TEXT" "PLAIN" NIL NIL NIL "7BIT" 10 0 NIL NIL NIL)("TEXT" "PLAIN" NIL NIL NIL "7BIT" 27 1 NIL NIL NIL) "MIXED" ("BOUNDARY" "nb") NIL NIL)'
    },
    'test/fixtures/mime/eightbit-headers.eml': {
        BODYSTRUCTURE: '("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "8BIT" 41 2 NIL NIL NIL)',
        ENVELOPE:
            '("Tue, 29 Sep 2026 10:00:00 +0300" {25}\r\nTere, \xc3\xb5unad ja \xc3\xa4\xc3\xa4dikas (({14}\r\nJ\xc3\xbcri \xc3\x95unapuu NIL "juri" "example.com")) (({14}\r\nJ\xc3\xbcri \xc3\x95unapuu NIL "juri" "example.com")) ' +
            '(({14}\r\nJ\xc3\xbcri \xc3\x95unapuu NIL "juri" "example.com")) (({7}\r\n\xc3\x84mblik NIL "amblik" "example.com")) NIL NIL NIL NIL)'
    }
};

const crlf = str => str.replace(/\r?\n/g, '\r\n');

/**
 * Splits a server transcript into responses the way ImapFlow's ImapStream does: the payload keeps the
 * literal size markers, and the literal data is returned separately
 *
 * @param {String} transcript Binary string
 * @return {Array} list of {text, payload, literals}, where text is the full response as sent
 */
function splitResponses(transcript) {
    const responses = [];
    let current = { text: '', payload: '', literals: [] };
    let pos = 0;
    while (pos < transcript.length) {
        const lineEnd = transcript.indexOf('\r\n', pos);
        if (lineEnd < 0) {
            break;
        }
        const line = transcript.substring(pos, lineEnd);
        pos = lineEnd + 2;
        const literal = line.match(/\{(\d+)\}$/);
        if (literal) {
            const size = Number(literal[1]);
            const data = transcript.substr(pos, size);
            current.text += line + '\r\n' + data;
            current.payload += line + '\r\n';
            current.literals.push(Buffer.from(data, 'binary'));
            pos += size;
            continue;
        }
        current.text += line;
        current.payload += line;
        responses.push(current);
        current = { text: '', payload: '', literals: [] };
    }
    return responses;
}

const parseResponse = response => imapHandler.parser(Buffer.from(response.payload, 'binary'), { literals: response.literals });

/**
 * Returns the response name of a FETCH item as parsed by ImapFlow, eg. BODY[1.MIME]<0>
 */
function itemKey(item) {
    let key = item.value.toUpperCase();
    if (item.section) {
        key +=
            '[' +
            item.section
                .map(part => (Array.isArray(part) ? '(' + part.map(field => field.value.toUpperCase()).join(' ') + ')' : part.value.toUpperCase()))
                .join(' ') +
            ']';
    }
    if (item.partial) {
        key += '<' + item.partial.join('.') + '>';
    }
    return key;
}

const toBinary = value => (Buffer.isBuffer(value) ? value.toString('binary') : value);
const tokenValue = token => (token && token.value !== undefined ? toBinary(token.value) : token);

/**
 * Lists the parts of a BODYSTRUCTURE (tokens from ImapFlow's parser) with their part numbers. Part numbers
 * follow RFC 3501 6.4.5: the body of a non-multipart message is part 1, and a message/rfc822 part P with a
 * non-multipart body has that body as part P.1
 *
 * @param {Array} node BODYSTRUCTURE tokens
 * @param {String} [partPath] Part number of the node, empty for the message itself
 * @return {Array} list of {part, type, size, lines}
 */
function listParts(node, partPath, list) {
    list = list || [];
    partPath = partPath || '';

    if (Array.isArray(node[0])) {
        // body-type-mpart = 1*body SP media-subtype
        for (let i = 0; Array.isArray(node[i]); i++) {
            listParts(node[i], (partPath ? partPath + '.' : '') + (i + 1), list);
        }
        return list;
    }

    const part = {
        part: partPath || '1',
        type: (tokenValue(node[0]) + '/' + tokenValue(node[1])).toLowerCase(),
        size: Number(tokenValue(node[6]))
    };
    list.push(part);
    if (part.type === 'message/rfc822') {
        // body-type-msg = media-message SP body-fields SP envelope SP body SP body-fld-lines
        part.lines = Number(tokenValue(node[9]));
        listParts(node[8], Array.isArray(node[8][0]) ? part.part : part.part + '.1', list);
    } else if (/^text\//.test(part.type)) {
        // body-type-text = media-text SP body-fields SP body-fld-lines
        part.lines = Number(tokenValue(node[7]));
    }
    return list;
}

describe('MIME fidelity', () => {
    const ctx = setupServer(() => ({
        storage: {
            INBOX: {
                messages: fixtures.map((fixture, i) => ({ raw: fixture.raw, uid: i + 1, flags: [] }))
            }
        }
    }));

    /**
     * Runs FETCH commands for a message in a fresh session
     *
     * @param {Number} seq Message sequence number
     * @param {Array} itemLists FETCH item lists, one FETCH command for each
     * @return {Promise<Array>} for every command the response as sent (text), the parsed response and a map of item names to values
     */
    const fetchMessage = (seq, itemLists) =>
        new Promise((resolve, reject) => {
            openSession(ctx.server.address().port, session => {
                const results = [];
                const commands = ['L1 LOGIN testuser testpass', 'S1 EXAMINE INBOX'].concat(
                    itemLists.map((items, i) => 'F' + i + ' FETCH ' + seq + ' (' + items + ')')
                );
                const next = () => {
                    const command = commands.shift();
                    if (!command) {
                        session.close();
                        return Promise.all(results).then(resolve, reject);
                    }
                    session.run(command, output => {
                        if (!/^F/.test(command)) {
                            return next();
                        }
                        const tag = command.split(' ')[0];
                        const responses = splitResponses(output);
                        const tagged = responses.find(response => response.text.indexOf(tag + ' ') === 0);
                        const fetch = responses.filter(response => response.text.indexOf('* ' + seq + ' FETCH ') === 0);
                        if (!tagged || !/ OK /.test(tagged.text) || fetch.length !== 1) {
                            session.close();
                            return reject(new Error(command + ' failed: ' + output));
                        }
                        results.push(
                            parseResponse(fetch[0]).then(parsed => {
                                const values = new Map();
                                const list = parsed.attributes[1];
                                for (let i = 0; i < list.length; i += 2) {
                                    values.set(itemKey(list[i]), list[i + 1]);
                                }
                                return { text: fetch[0].text, payload: fetch[0].payload, parsed, values };
                            })
                        );
                        next();
                    });
                };
                next();
            });
        });

    const getStructure = async seq => {
        const [result] = await fetchMessage(seq, ['BODYSTRUCTURE RFC822.SIZE BODY.PEEK[]']);
        return {
            result,
            structure: result.values.get('BODYSTRUCTURE'),
            body: toBinary(result.values.get('BODY[]').value)
        };
    };

    fixtures.forEach((fixture, i) => {
        const seq = i + 1;
        const expected = crlf(fixture.raw);

        describe(fixture.name, () => {
            it('serves BODY[] as the CRLF source and RFC822.SIZE as its length (RFC 3501 6.4.5, 7.4.2)', async () => {
                const { result, body } = await getStructure(seq);
                assert.strictEqual(body, expected);
                assert.strictEqual(Number(result.values.get('RFC822.SIZE').value), expected.length);
            });

            it('serves BODY[HEADER] followed by BODY[TEXT] as BODY[] (RFC 3501 6.4.5)', async () => {
                const [result] = await fetchMessage(seq, ['BODY.PEEK[HEADER] BODY.PEEK[TEXT] RFC822.HEADER']);
                const header = toBinary(result.values.get('BODY[HEADER]').value);
                const text = toBinary(result.values.get('BODY[TEXT]').value);
                assert.strictEqual(header + text, expected);
                // RFC 3501 7.4.2: the blank line is part of the header, except for a message with no body and no blank line
                if (/\r\n\r\n/.test(expected)) {
                    assert.ok(/\r\n\r\n$/.test(header), 'header ends with a blank line');
                }
                // RFC822.HEADER is BODY.PEEK[HEADER] (RFC 3501 6.4.5)
                assert.strictEqual(toBinary(result.values.get('RFC822.HEADER').value), header);
            });

            it('reports part sizes and line counts that match BODY[part] (RFC 3501 7.4.2)', async () => {
                const { structure } = await getStructure(seq);
                const parts = listParts(structure);
                assert.ok(parts.length > 0);

                const [result] = await fetchMessage(seq, [parts.map(part => 'BODY.PEEK[' + part.part + ']').join(' ')]);
                parts.forEach(part => {
                    const content = toBinary(result.values.get('BODY[' + part.part + ']').value);
                    assert.strictEqual(part.size, content.length, 'size of part ' + part.part);
                    if ('lines' in part) {
                        assert.strictEqual(part.lines, (content.match(/\n/g) || []).length, 'lines of part ' + part.part);
                    }
                });
            });

            it('serves BODY[part.MIME] followed by BODY[part] as a slice of BODY[] (RFC 3501 6.4.5)', async t => {
                const { structure, body } = await getStructure(seq);
                if (!Array.isArray(structure[0])) {
                    return t.skip('not a multipart message');
                }
                const parts = listParts(structure).filter(part => part.part.indexOf('.') < 0);
                const items = parts.map(part => 'BODY.PEEK[' + part.part + '.MIME] BODY.PEEK[' + part.part + ']').join(' ');
                const [result] = await fetchMessage(seq, [items]);

                let offset = 0;
                parts.forEach(part => {
                    const mime = toBinary(result.values.get('BODY[' + part.part + '.MIME]').value);
                    const content = toBinary(result.values.get('BODY[' + part.part + ']').value);
                    const entity = mime + content;
                    const found = body.indexOf(entity, offset);
                    assert.ok(found >= 0, 'part ' + part.part + ' MIME header and body are not contiguous in BODY[]');
                    // the part follows a delimiter line (RFC 2046 5.1.1)
                    assert.ok(/(^|\r\n)--[^\r\n]*\r\n$/.test(body.substring(0, found)), 'part ' + part.part + ' does not start after a delimiter');
                    offset = found + entity.length;
                });
            });

            it('serves the header and text of message/rfc822 parts (RFC 3501 6.4.5)', async t => {
                const { structure } = await getStructure(seq);
                const messages = listParts(structure).filter(part => part.type === 'message/rfc822');
                if (!messages.length) {
                    return t.skip('no message/rfc822 parts');
                }
                const items = messages.map(part => ['', '.HEADER', '.TEXT'].map(suffix => 'BODY.PEEK[' + part.part + suffix + ']').join(' ')).join(' ');
                const [result] = await fetchMessage(seq, [items]);
                messages.forEach(part => {
                    const value = suffix => toBinary(result.values.get('BODY[' + part.part + suffix + ']').value);
                    assert.strictEqual(value('.HEADER') + value('.TEXT'), value(''), 'part ' + part.part);
                    assert.ok(/\r\n\r\n$/.test(value('.HEADER')), 'part ' + part.part + ' header ends with a blank line');
                });
            });

            it('serves partial BODY[]<origin.length> as slices of BODY[] (RFC 3501 6.4.5)', async () => {
                const length = expected.length;
                const origins = [...new Set([0, 1, Math.floor(length / 2), length - 1, length, length + 10])];
                const lengths = [1, 7, 50, length + 1];
                const itemLists = lengths.map(size => origins.map(origin => 'BODY.PEEK[]<' + origin + '.' + size + '>').join(' '));
                const results = await fetchMessage(seq, itemLists);
                lengths.forEach((size, i) => {
                    origins.forEach(origin => {
                        // RFC 3501 7.4.2: only the origin octet is returned in the response
                        const item = results[i].values.get('BODY[]<' + origin + '>');
                        assert.ok(item, 'missing BODY[]<' + origin + '>');
                        assert.strictEqual(toBinary(item.value), expected.substr(origin, size), '<' + origin + '.' + size + '>');
                    });
                });
            });

            it('serves partial BODY[1]<origin.length> as slices of BODY[1] (RFC 3501 6.4.5)', async () => {
                const [full] = await fetchMessage(seq, ['BODY.PEEK[1]']);
                const part = toBinary(full.values.get('BODY[1]').value);
                const origins = [...new Set([0, 1, part.length - 1, part.length, part.length + 5].filter(origin => origin >= 0))];
                const [result] = await fetchMessage(seq, [origins.map(origin => 'BODY.PEEK[1]<' + origin + '.3>').join(' ')]);
                origins.forEach(origin => {
                    assert.strictEqual(toBinary(result.values.get('BODY[1]<' + origin + '>').value), part.substr(origin, 3), '<' + origin + '.3>');
                });
            });

            it('sends BODYSTRUCTURE, BODY and ENVELOPE that round trip through ImapFlow', async () => {
                const [result] = await fetchMessage(seq, ['BODYSTRUCTURE ENVELOPE BODY']);

                // RFC 3501 9: QUOTED-CHAR is 7-bit and has no CR or LF, anything else must be sent as a literal.
                // The payload leaves out the literal data
                (result.payload.match(/"(?:[^"\\]|\\.)*"/g) || []).forEach(value => {
                    assert.ok(!/[\x80-\xff\r\n]/.test(value), 'invalid quoted string ' + JSON.stringify(value));
                });

                // compiling the parsed response and parsing it again gives the same values
                const compiled = (await imapHandler.compiler(result.parsed)).toString('binary');
                const [again] = splitResponses(compiled + '\r\n');
                assert.deepStrictEqual(await parseResponse(again), result.parsed);

                // the parsed values are usable
                const envelope = parseEnvelope(result.values.get('ENVELOPE'));
                assert.strictEqual(typeof envelope, 'object');
                const structure = parseBodystructure(result.values.get('BODYSTRUCTURE'));
                assert.ok(structure.type);

                // BODY is BODYSTRUCTURE without the extension data (RFC 3501 7.4.2)
                const summary = node => listParts(node).map(part => [part.part, part.type, part.size, part.lines]);
                assert.deepStrictEqual(summary(result.values.get('BODY')), summary(result.values.get('BODYSTRUCTURE')));
            });

            Object.keys(GOLDEN[fixture.name] || {}).forEach(item => {
                const golden = GOLDEN[fixture.name][item];
                const expectedText = '* ' + seq + ' FETCH (' + item + ' ' + golden + ')';

                it('sends the expected ' + item + ' values', async () => {
                    const [result] = await fetchMessage(seq, [item]);
                    const [expectedResponse] = splitResponses(expectedText + '\r\n');
                    assert.deepStrictEqual(result.parsed, await parseResponse(expectedResponse));
                });

                it('sends ' + item + ' in the RFC 3501 9 wire form', async () => {
                    const [result] = await fetchMessage(seq, [item]);
                    assert.strictEqual(result.text, expectedText);
                });
            });
        });
    });

    describe('selected details', () => {
        const seqOf = name => fixtures.findIndex(fixture => fixture.name === name) + 1;

        it('decodes RFC 2231 parameters and continuations (RFC 2231 3, 4)', async () => {
            const [result] = await fetchMessage(seqOf('test/fixtures/mime/rfc2231.eml'), ['BODYSTRUCTURE']);
            const structure = parseBodystructure(result.values.get('BODYSTRUCTURE'));
            const pdf = structure.childNodes[1];
            assert.strictEqual(pdf.parameters.name, 'Ärger und Öl.pdf');
            assert.strictEqual(pdf.dispositionParameters.filename, 'a very long file name that continues here.pdf');
            assert.strictEqual(pdf.dispositionParameters.size, '12');
            assert.deepStrictEqual(pdf.language, ['de', 'en']);
        });

        it('treats multipart/digest parts without Content-Type as message/rfc822 (RFC 2046 5.1.5)', async () => {
            const [result] = await fetchMessage(seqOf('test/fixtures/mime/digest.eml'), ['BODYSTRUCTURE']);
            const parts = listParts(result.values.get('BODYSTRUCTURE'));
            assert.deepStrictEqual(
                parts.map(part => [part.part, part.type]),
                [
                    ['1', 'message/rfc822'],
                    ['1.1', 'text/plain'],
                    ['2', 'message/rfc822'],
                    ['2.1', 'text/plain'],
                    ['3', 'text/plain']
                ]
            );
        });

        it('sends 8-bit header values as literals in ENVELOPE (RFC 3501 4.3, 9)', async () => {
            const [result] = await fetchMessage(seqOf('test/fixtures/mime/eightbit-headers.eml'), ['ENVELOPE']);
            const envelope = parseEnvelope(result.values.get('ENVELOPE'));
            assert.strictEqual(envelope.subject, 'Tere, õunad ja äädikas');
            assert.deepStrictEqual(envelope.from, [{ name: 'Jüri Õunapuu', address: 'juri@example.com' }]);
        });

        it('serves a nested message part by part number (RFC 3501 6.4.5)', async () => {
            const seq = seqOf('test/fixtures/mime/nested.eml');
            const [result] = await fetchMessage(seq, [
                'BODY.PEEK[2.HEADER.FIELDS (SUBJECT)] BODY.PEEK[2.1] BODY.PEEK[2.2.MIME] BODY.PEEK[3]<0.10> BODY.PEEK[4]'
            ]);
            assert.strictEqual(toBinary(result.values.get('BODY[2.HEADER.FIELDS (SUBJECT)]').value), 'Subject: Inner subject\r\n\r\n');
            assert.strictEqual(toBinary(result.values.get('BODY[2.1]').value), 'Inner plain text\r\nsecond line');
            assert.strictEqual(toBinary(result.values.get('BODY[2.2.MIME]').value), 'Content-Type: text/html; charset=utf-8\r\n\r\n');
            assert.strictEqual(toBinary(result.values.get('BODY[3]<0>').value), 'AAECAwQFBg');
            // a part that does not exist is an empty string (RFC 3501 6.4.5 leaves this open, Dovecot does the same)
            assert.strictEqual(toBinary(result.values.get('BODY[4]').value), '');
        });
    });
});
