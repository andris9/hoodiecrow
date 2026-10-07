'use strict';

/**
 * Response grammar guardrail. Checks that everything a server sent can be parsed by a standards
 * compliant client: framing (CRLF line ends, literals), the shape of tagged, untagged and
 * continuation responses as defined by the RFC 3501 section 9 formal syntax, and that ImapFlow's
 * response parser accepts every response.
 */

const assert = require('node:assert');
const { parser } = require('imapflow/lib/handler/imap-handler.js');
const framing = require('../../lib/framing');
const { TAG_REGEX } = require('../../lib/server');

const CR = 0x0d;

// Untagged response names hoodiecrow may send. RFC 3501 section 9 (response-data, mailbox-data,
// capability-data) plus the extensions it implements: ENABLED (RFC 5161), ID (RFC 2971),
// NAMESPACE (RFC 2342), ESEARCH (RFC 4731), VANISHED (RFC 7162). "X" prefixed names are
// experimental extensions (RFC 3501 section 6.5.1 allows X commands, and their responses).
const UNTAGGED = new Set([
    'OK',
    'NO',
    'BAD',
    'PREAUTH',
    'BYE',
    'CAPABILITY',
    'LIST',
    'LSUB',
    'STATUS',
    'SEARCH',
    'FLAGS',
    'ENABLED',
    'ID',
    'NAMESPACE',
    'ESEARCH',
    'VANISHED'
]);

// RFC 3501 section 9: message-data uses nz-number, EXISTS and RECENT use number
const NUMERIC = {
    EXISTS: 'number',
    RECENT: 'number',
    EXPUNGE: 'nz-number',
    FETCH: 'nz-number'
};

// RFC 3501 section 9: resp-text-code = ... / atom [SP 1*<any TEXT-CHAR except "]">]
const ATOM_RE = /^(?:(?![(){%*"\\\]])[!-~])+$/;

const NUMBER_RE = /^[0-9]+$/;
const NZ_NUMBER_RE = /^[1-9][0-9]*$/;

/**
 * Splits a transcript into responses with the shared framing code, and adds the strict checks:
 * every line ends with CRLF, no bare CR, and nothing is left over at the end.
 *
 * @param {Buffer|String} transcript Everything the server sent (a string is read as binary)
 * @param {Object} [options]
 * @param {Boolean} [options.partial] if true, an incomplete response at the end is not an error but
 *        is left out, for transcripts that are still being received
 * @return {Array} list of `{ payload, literals, text, end }`, where `payload` is the response without
 *         literal data and without the final CRLF (the shape ImapFlow's parser expects), `text`
 *         is a printable version for error messages and `end` is the offset right after the response
 */
function splitResponses(transcript, options) {
    const partial = !!(options && options.partial);
    const buf = Buffer.isBuffer(transcript) ? transcript : Buffer.from(transcript, 'binary');
    const framed = framing.splitResponses(buf);

    const responses = framed.responses.map(response => {
        response.lines.forEach(line => checkLineEnd(buf, line));
        return finishResponse(buf, response);
    });

    const incomplete = framed.incomplete;
    if (incomplete) {
        // the lines of an unfinished response that did end must end correctly as well
        incomplete.lines.forEach(line => checkLineEnd(buf, line));
    }
    if (incomplete && !partial) {
        const tail = buf.subarray(framed.end);
        if (incomplete.reason === 'literal') {
            fail('Literal of ' + incomplete.size + ' octets is cut short, only ' + incomplete.available + ' octets follow', tail);
        }
        if (incomplete.reason === 'response') {
            fail('Transcript ends inside a response that has a literal', tail);
        }
        fail('Response is not terminated with CRLF', tail);
    }

    return responses;
}

// RFC 3501 section 9: every line ends with CRLF, and CR is not allowed anywhere else in a line
function checkLineEnd(buf, line) {
    if (line.end === line.lf) {
        fail('Line ends with a bare LF instead of CRLF', buf.subarray(line.start, line.lf + 1));
    }
    if (buf.subarray(line.start, line.end).indexOf(CR) >= 0) {
        fail('Line contains a bare CR', buf.subarray(line.start, line.lf + 1));
    }
}

function finishResponse(buf, response) {
    const lines = response.lines.map(line => buf.subarray(line.start, line.end));
    const literals = response.literals.map(literal => buf.subarray(literal.start, literal.end));
    const parts = [];
    let text = '';
    lines.forEach((line, i) => {
        parts.push(line);
        if (i < lines.length - 1) {
            parts.push(Buffer.from('\r\n'));
        }
        text += line.toString('binary');
        if (i < literals.length) {
            text += '\r\n<' + literals[i].length + ' octets>';
        }
    });
    return {
        payload: Buffer.concat(parts),
        literals,
        literal8: response.literals.map(literal => literal.literal8),
        lines,
        text,
        end: response.end
    };
}

function fail(message, data) {
    const text = Buffer.isBuffer(data) ? data.toString('binary') : String(data);
    throw new assert.AssertionError({ message: message + ': ' + JSON.stringify(text.length > 500 ? text.substr(0, 500) + '...' : text) });
}

/**
 * Checks `resp-text` (RFC 3501 section 9: resp-text = ["[" resp-text-code "]" SP] text) that
 * follows a status keyword. `rest` is everything after the keyword.
 */
function checkRespText(rest, response) {
    if (rest.charAt(0) !== ' ') {
        // RFC 3501 section 9: resp-cond-state = ("OK" / "NO" / "BAD") SP resp-text
        fail('Status response keyword must be followed by SP and text', response.text);
    }
    let text = rest.substr(1);
    if (text.charAt(0) === '[') {
        const end = text.indexOf(']');
        if (end < 0) {
            fail('Response code is missing the closing "]"', response.text);
        }
        const code = text.substring(1, end);
        const space = code.indexOf(' ');
        const name = space >= 0 ? code.substr(0, space) : code;
        if (!ATOM_RE.test(name)) {
            fail('Response code name is not an atom', response.text);
        }
        if (space >= 0 && space === code.length - 1) {
            fail('Response code has SP without arguments', response.text);
        }
        text = text.substr(end + 1);
        if (text.charAt(0) !== ' ') {
            fail('Response code must be followed by SP and text', response.text);
        }
        text = text.substr(1);
    }
    if (!text.length) {
        // RFC 3501 section 9: text = 1*TEXT-CHAR (RFC 9051 made it optional, IMAP4rev1 clients may not cope)
        fail('Status response has no human readable text', response.text);
    }
}

function checkResponse(response, parsed) {
    const first = response.lines[0].toString('binary');

    // RFC 3501 section 9: CHAR = %x01-7F, TEXT-CHAR and QUOTED-CHAR are 7-bit, only literals carry 8-bit
    // data. Literals (CHAR8 = %x01-ff) must not contain NUL, literal8 (RFC 3516) may.
    response.lines.forEach(line => {
        for (let i = 0; i < line.length; i++) {
            if (line[i] === 0 || line[i] >= 0x80) {
                fail('Response line contains a ' + (line[i] ? '8-bit' : 'NUL') + ' octet outside a literal', response.text);
            }
        }
    });
    response.literals.forEach((literal, i) => {
        if (!response.literal8[i] && literal.indexOf(0) >= 0) {
            fail('Literal contains a NUL octet', response.text);
        }
    });

    if (parsed.tag === '+') {
        // RFC 3501 section 9 and RFC 9051 section 9: continue-req = "+" SP (resp-text / base64) CRLF.
        // base64 may be empty, so "+ " is valid but a bare "+" is not.
        if (!/^\+ /.test(first)) {
            fail('Continuation response must start with "+ "', response.text);
        }
        return;
    }

    if (parsed.tag !== '*') {
        // RFC 3501 section 9: response-tagged = tag SP resp-cond-state CRLF
        const match = first.match(/^([^ ]+) (OK|NO|BAD)(?![^ ])(.*)$/i);
        if (!match || !TAG_REGEX.test(match[1])) {
            fail('Tagged response must be "tag OK|NO|BAD text"', response.text);
        }
        checkRespText(match[3], response);
        return;
    }

    const numeric = first.match(/^\* ([^ ]+) ([^ ]+)/);
    if (numeric && /^[0-9]/.test(numeric[1])) {
        const name = numeric[2].toUpperCase();
        if (!NUMERIC[name]) {
            fail('Unknown numeric untagged response', response.text);
        }
        const re = NUMERIC[name] === 'number' ? NUMBER_RE : NZ_NUMBER_RE;
        if (!re.test(numeric[1])) {
            fail(name + ' requires a ' + NUMERIC[name], response.text);
        }
        if (name === 'FETCH') {
            // RFC 3501 section 9: "FETCH" SP msg-att, msg-att = "(" att SP value *(SP att SP value) ")"
            const attrs = parsed.attributes || [];
            if (attrs.length !== 2 || !Array.isArray(attrs[1]) || !/^\* [0-9]+ FETCH \(/i.test(first)) {
                fail('FETCH response must have exactly one parenthesized list', response.text);
            }
            if (!attrs[1].length || attrs[1].length % 2) {
                fail('FETCH response list must hold attribute and value pairs', response.text);
            }
        } else if ((parsed.attributes || []).length !== 1) {
            fail(name + ' response takes no arguments', response.text);
        }
        return;
    }

    const name = String(parsed.command || '').toUpperCase();
    if (!UNTAGGED.has(name) && !/^X/.test(name)) {
        fail('Unknown untagged response "' + parsed.command + '"', response.text);
    }

    if (['OK', 'NO', 'BAD', 'PREAUTH', 'BYE'].includes(name)) {
        // RFC 3501 section 9: resp-cond-state, resp-cond-auth, resp-cond-bye are all keyword SP resp-text
        checkRespText(first.substr(2 + name.length), response);
        return;
    }

    if (name === 'SEARCH') {
        // RFC 3501 section 9: "SEARCH" *(SP nz-number), RFC 7162 section 7 appends SP "(" "MODSEQ" SP mod-sequence-value ")"
        const attrs = parsed.attributes || [];
        attrs.forEach((attr, i) => {
            if (Array.isArray(attr)) {
                const ok =
                    i === attrs.length - 1 &&
                    attr.length === 2 &&
                    String(attr[0].value).toUpperCase() === 'MODSEQ' &&
                    attr[1] &&
                    NZ_NUMBER_RE.test(attr[1].value);
                if (!ok) {
                    fail('SEARCH response has an invalid list', response.text);
                }
                return;
            }
            if (!attr || attr.type !== 'ATOM' || !NZ_NUMBER_RE.test(attr.value)) {
                fail('SEARCH response must only list nz-numbers', response.text);
            }
        });
    }
}

/**
 * Validates a full server transcript. Rejects with an AssertionError naming the offending response.
 *
 * @param {Buffer|String} transcript Everything the server sent (a string is read as binary)
 * @return {Promise} resolves once every response has been checked
 */
async function validateResponses(transcript) {
    const responses = splitResponses(transcript);
    for (const response of responses) {
        let parsed;
        try {
            parsed = await parser(response.payload, { literals: response.literals.slice() });
        } catch (err) {
            fail('ImapFlow can not parse the response (' + err.message + ')', response.text);
        }
        checkResponse(response, parsed);
    }
    return responses;
}

/**
 * Validates a transcript and then calls `callback` outside of the promise chain, so that assertion
 * errors from either the validator or the callback surface as uncaught exceptions that node:test
 * attributes to the running test.
 *
 * @param {Buffer|String} transcript Everything the server sent
 * @param {Function} callback Called with no arguments once the transcript is valid
 */
function validateThen(transcript, callback) {
    validateResponses(transcript).then(
        () => setImmediate(callback),
        err =>
            setImmediate(() => {
                throw err;
            })
    );
}

module.exports = { validateResponses, validateThen, splitResponses };
