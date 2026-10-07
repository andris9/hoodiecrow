'use strict';

/**
 * IMAP framing helpers shared by the mock client, the test helpers and the compare tool.
 * Both functions take a Buffer or a binary string (one character per octet).
 */

const LF = 0x0a;
const CR = 0x0d;

/**
 * Splits received server data into responses. A response is one line, or a line that ends with a
 * literal marker `{n}` or `~{n}` (RFC 3516 literal8), followed by n octets and the rest of the
 * response. Lenient: lines end at LF, a CR before it is not required. Callers that need strict
 * framing check the line ends themselves.
 *
 * @param {Buffer|String} data Received data, possibly ending with an incomplete response
 * @return {Object} `{ responses, end, incomplete }`. Every response is `{ start, end, lines, literals }`,
 *         where `lines` lists `{ start, end, lf }` (end excludes the CR before the LF, `lf` is the
 *         offset of the LF) and `literals` lists `{ start, end, literal8 }`. `end` is the offset right
 *         after the last complete response. `incomplete` is false when all data was used, otherwise
 *         `{ reason, lines }` with the complete lines of the unfinished response, where reason is
 *         'line' for a line without LF, 'literal' for literal data that is cut short (with `size`
 *         and `available`), or 'response' when the data ends right after literal data.
 */
function splitResponses(data) {
    const isBuffer = Buffer.isBuffer(data);
    const length = data.length;
    const charAt = isBuffer ? i => data[i] : i => data.charCodeAt(i);
    const slice = isBuffer ? (start, end) => data.toString('binary', start, end) : (start, end) => data.slice(start, end);

    const responses = [];
    let pos = 0;
    let end = 0;
    let current = null;

    while (pos < length) {
        const lf = data.indexOf(isBuffer ? LF : '\n', pos);
        if (lf < 0) {
            return { responses, end, incomplete: { reason: 'line', lines: current ? current.lines : [] } };
        }

        const lineStart = pos;
        const lineEnd = lf > pos && charAt(lf - 1) === CR ? lf - 1 : lf;
        if (!current) {
            current = { start: pos, end: 0, lines: [], literals: [] };
        }
        current.lines.push({ start: lineStart, end: lineEnd, lf });
        pos = lf + 1;

        // only lines that end with "}" can carry a literal marker, so most lines are not sliced
        const marker = lineEnd > lineStart && charAt(lineEnd - 1) === 0x7d && slice(Math.max(lineEnd - 32, lineStart), lineEnd).match(/(~?)\{(\d+)\}$/);
        if (marker) {
            const size = Number(marker[2]);
            if (pos + size > length) {
                return { responses, end, incomplete: { reason: 'literal', size, available: length - pos, lines: current.lines } };
            }
            current.literals.push({ start: pos, end: pos + size, literal8: !!marker[1] });
            pos += size;
            continue;
        }

        current.end = end = pos;
        responses.push(current);
        current = null;
    }

    // the data ended right after a literal, the rest of the response is missing
    return { responses, end, incomplete: current ? { reason: 'response', lines: current.lines } : false };
}

/**
 * Splits an outgoing command after every synchronizing literal marker, as a client must wait for the
 * continuation request before it sends the literal data (RFC 3501 section 4.3). The data of every
 * literal, synchronizing or not ({n+}, RFC 7888), is skipped, so markers inside it are not matched.
 *
 * @param {Buffer|String} payload Command, as a Buffer or a binary string
 * @return {Array} Chunks to send, of the same type as the payload
 */
function splitAtLiterals(payload) {
    const isBuffer = Buffer.isBuffer(payload);
    const str = isBuffer ? payload.toString('binary') : String(payload);
    const cut = (start, end) => (isBuffer ? payload.subarray(start, end) : str.slice(start, end));
    const chunks = [];
    const re = /~?\{(\d+)(\+?)\}\r\n/g;
    let start = 0;
    let match;

    while ((match = re.exec(str))) {
        const end = match.index + match[0].length;
        if (!match[2]) {
            chunks.push(cut(start, end));
            start = end;
        }
        re.lastIndex = end + Number(match[1]);
    }
    chunks.push(cut(start));

    return chunks.filter(chunk => chunk.length);
}

module.exports = { splitResponses, splitAtLiterals };
