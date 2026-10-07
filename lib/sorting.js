'use strict';

// Message values for SORT and THREAD (RFC 5256): string collation, base subject, sent date,
// addresses and Message IDs, and the search step that both commands start with

const { getMessageData } = require('./mimeparser');
const { processAddress } = require('./envelope');
const { monthIndex, isRealDate } = require('./dates');
const makeSearch = require('./commands/handlers/search');
const { badError } = makeSearch;

// RFC 2047 section 2: encoded-word = "=?" charset "?" encoding "?" encoded-text "?=", RFC 2231 section 5
// adds an optional "*" language suffix to the charset
const ENCODED_WORD = /=\?([^?\s*]+)(?:\*[^?\s]*)?\?([BbQq])\?([^?\s]*)\?=/g;

const utf8Decoder = new TextDecoder('utf-8');

// decoders by lower case charset name, false for a charset that TextDecoder does not know
const decoders = new Map();

/**
 * Decodes the octets of an encoded word, or returns false if the charset is unknown
 */
function decodeCharset(charset, octets) {
    charset = charset.toLowerCase();
    if (!decoders.has(charset)) {
        let decoder = false;
        try {
            decoder = new TextDecoder(charset);
        } catch {
            // unknown charset
        }
        decoders.set(charset, decoder);
    }
    const decoder = decoders.get(charset);
    return decoder && decoder.decode(octets);
}

/**
 * Decodes an RFC 2047 header value to a Unicode string. Text outside encoded words is read as UTF-8
 * (invalid sequences become U+FFFD). Adjacent encoded words in the same charset are decoded together,
 * so a multi-octet character may span them, and the white space between them is dropped (RFC 2047
 * section 6.2). Encoded words in an unknown charset are kept as they are.
 *
 * @param {String} value Header value as a binary string
 * @return {String} Decoded value
 */
function decodeHeader(value) {
    value = (value || '').toString();
    let result = '';
    let pending = null;
    let lastIndex = 0;

    const flush = () => {
        if (pending) {
            const decoded = decodeCharset(pending.charset, Buffer.concat(pending.octets));
            result += decoded === false ? pending.source : decoded;
            pending = null;
        }
    };

    ENCODED_WORD.lastIndex = 0;
    let match;
    while ((match = ENCODED_WORD.exec(value))) {
        const between = value.substring(lastIndex, match.index);
        const adjacent = pending && /^\s*$/.test(between);
        if (!adjacent) {
            flush();
            result += utf8Decoder.decode(Buffer.from(between, 'binary'));
        }
        lastIndex = ENCODED_WORD.lastIndex;

        const octets =
            match[2].toUpperCase() === 'B'
                ? Buffer.from(match[3], 'base64')
                : Buffer.from(
                      match[3].replace(/_/g, ' ').replace(/=([0-9a-fA-F]{2})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16))),
                      'binary'
                  );

        if (pending && pending.charset.toLowerCase() !== match[1].toLowerCase()) {
            flush();
        }
        if (!pending) {
            pending = { charset: match[1], octets: [], source: '' };
        }
        pending.octets.push(octets);
        pending.source += (pending.source ? between : '') + match[0];
    }
    flush();
    return result + utf8Decoder.decode(Buffer.from(value.substr(lastIndex), 'binary'));
}

// UnicodeData.txt titlecase mappings that differ from the single code point uppercase mapping
// that String#toUpperCase gives: the Latin digraphs and the Greek letters with ypogegrammeni
const TITLECASE = new Map([
    [0x01c4, 0x01c5],
    [0x01c6, 0x01c5],
    [0x01c7, 0x01c8],
    [0x01c9, 0x01c8],
    [0x01ca, 0x01cb],
    [0x01cc, 0x01cb],
    [0x01f1, 0x01f2],
    [0x01f3, 0x01f2],
    [0x1fb3, 0x1fbc],
    [0x1fc3, 0x1fcc],
    [0x1ff3, 0x1ffc]
]);
for (const start of [0x1f80, 0x1f90, 0x1fa0]) {
    for (let i = 0; i < 8; i++) {
        TITLECASE.set(start + i, start + i + 8);
    }
}

/**
 * Returns the i;unicode-casemap form of a string (RFC 5051 section 2): every character is titlecased
 * and then decomposed (NFKD). Comparing the UTF-8 octets of the results is the collation that
 * RFC 5256 section 7 requires for SORT and THREAD (I18NLEVEL=1, RFC 5255 section 4.5)
 *
 * @param {String} str Unicode string
 * @return {Buffer} UTF-8 octets to compare with Buffer.compare
 */
function collationKey(str) {
    let result = '';
    for (const char of str) {
        const code = char.codePointAt(0);
        if (TITLECASE.has(code)) {
            result += String.fromCodePoint(TITLECASE.get(code));
            continue;
        }
        // full case mappings (e.g. "ß" to "SS") are not the simple mapping of UnicodeData.txt
        const upper = char.toUpperCase();
        result += [...upper].length === 1 ? upper : char;
    }
    return Buffer.from(result.normalize('NFKD'), 'utf-8');
}

// RFC 5256 section 5: subj-refwd = ("re" / ("fw" ["d"])) *WSP [subj-blob] ":", subj-blob = "[" *BLOBCHAR "]" *WSP
const SUBJ_BLOB = '\\[[^[\\]]*\\] *';
const SUBJ_LEADER = new RegExp('^(?:' + SUBJ_BLOB + ')*(?:re|fwd?) *(?:' + SUBJ_BLOB + ')?:', 'i');
const SUBJ_BLOB_PREFIX = new RegExp('^' + SUBJ_BLOB);

/**
 * Extracts the base subject (RFC 5256 section 2.1) and tells if the subject marks a reply or a
 * forward (RFC 5256 section 3, REFERENCES): the extraction removed a subj-refwd, a "(fwd)" trailer
 * or a subj-fwd-hdr and subj-fwd-trl pair.
 *
 * @param {String} subject Subject header value as a binary string
 * @return {Object} `{ subject, isReply }`, subject is the base subject as a Unicode string
 */
function baseSubject(subject) {
    let isReply = false;

    // (1) decode encoded words, tabs and continuations become a space, runs of spaces one space
    let text = decodeHeader(subject)
        .replace(/\r?\n(?=[ \t])/g, '')
        .replace(/[\t\r\n]/g, ' ')
        .replace(/ {2,}/g, ' ');

    for (;;) {
        // (2) remove subj-trailer text until there is none
        let end = text.length;
        for (;;) {
            if (text.charAt(end - 1) === ' ') {
                end--;
            } else if (end >= 5 && text.substring(end - 5, end).toLowerCase() === '(fwd)') {
                isReply = true;
                end -= 5;
            } else {
                break;
            }
        }
        text = text.substring(0, end);

        // (3) remove subj-leader text, (4) remove a subj-blob prefix if a subj-base remains, (5) repeat
        for (;;) {
            let match;
            if (text.charAt(0) === ' ') {
                text = text.substr(1);
            } else if ((match = text.match(SUBJ_LEADER))) {
                isReply = true;
                text = text.substr(match[0].length);
            } else if ((match = text.match(SUBJ_BLOB_PREFIX)) && match[0].length < text.length) {
                text = text.substr(match[0].length);
            } else {
                break;
            }
        }

        // (6) unwrap "[fwd: ... ]" and start over from step (2)
        if (/^\[fwd:/i.test(text) && /\]$/.test(text)) {
            isReply = true;
            text = text.slice(5, -1);
            continue;
        }

        // (7) the remaining text is the base subject
        return { subject: text, isReply };
    }
}

// RFC 5322 section 4.3 obsolete zones, military zones are treated as "-0000"
const ZONES = { UT: 0, GMT: 0, EST: -5, EDT: -4, CST: -6, CDT: -5, MST: -7, MDT: -6, PST: -8, PDT: -7 };

/**
 * Converts date and time parts to milliseconds since the epoch, adjusted by the time zone
 */
function toTimestamp(day, month, year, hours, minutes, seconds, zone) {
    let offset = 0;
    if (/^[+-]\d{4}$/.test(zone || '')) {
        const sign = zone.charAt(0) === '-' ? -1 : 1;
        const zoneHours = Number(zone.substr(1, 2));
        const zoneMinutes = Number(zone.substr(3, 2));
        if (zoneMinutes < 60) {
            offset = sign * (zoneHours * 60 + zoneMinutes);
        }
    } else if (zone && Object.hasOwn(ZONES, zone.toUpperCase())) {
        offset = ZONES[zone.toUpperCase()] * 60;
    }
    return Date.UTC(year, month, day, hours, minutes, seconds) - offset * 60 * 1000;
}

/**
 * Internal date and time of a message in milliseconds (RFC 5256 ARRIVAL)
 *
 * @param {Object} message Message object
 * @return {Number} timestamp, 0 if the internal date can not be parsed
 */
function arrivalTime(message) {
    const match = (message.internaldate || '').toString().match(/^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})/);
    if (!match) {
        return 0;
    }
    return toTimestamp(Number(match[1]), monthIndex(match[2]), Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]), match[7]);
}

/**
 * Sent date of a message in milliseconds (RFC 5256 section 2.2): the Date header normalized to UTC.
 * An invalid zone is read as UTC and an invalid time as 00:00:00, and if the header is missing or
 * has no valid date, the internal date is used instead.
 *
 * @param {Object} message Message object
 * @return {Number} timestamp
 */
function sentTime(message) {
    const header = getMessageData(message).tree.parsedHeader.date;
    // RFC 5322 section 3.3: [day-of-week ","] day month year time zone, with the obsolete forms of section 4.3
    const match = (header || '')
        .toString()
        .replace(/\([^()]*\)/g, ' ')
        .match(/^\s*(?:[A-Za-z]+\s*,)?\s*(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})(?:\s+(\d{1,2})\s*:\s*(\d{2})(?:\s*:\s*(\d{2}))?(?:\s+([+-]\d{4}|[A-Za-z]+))?)?/);
    if (match) {
        let year = Number(match[3]);
        // RFC 5322 section 4.3: two digit years below 50 are 20xx, three digit years add 1900
        if (match[3].length === 2) {
            year += year < 50 ? 2000 : 1900;
        } else if (match[3].length === 3) {
            year += 1900;
        }
        const day = Number(match[1]);
        const month = monthIndex(match[2]);
        if (isRealDate(day, month, year)) {
            let time = [Number(match[4]), Number(match[5]), Number(match[6] || 0)];
            if (match[4] === undefined || time[0] > 23 || time[1] > 59 || time[2] > 60) {
                time = [0, 0, 0];
            }
            return toTimestamp(day, month, year, time[0], time[1], time[2], match[7]);
        }
    }
    return arrivalTime(message);
}

/**
 * Returns the first address of an envelope address list, as [name, adl, mailbox, host]
 */
function firstAddress(message, header) {
    const list = processAddress(getMessageData(message).tree.parsedHeader[header]);
    return (list && list[0]) || null;
}

/**
 * addr-mailbox of the first address in a header (RFC 5256 CC, FROM and TO), empty if there is none
 *
 * @param {Object} message Message object
 * @param {String} header "from", "to" or "cc"
 * @return {String} Unicode string
 */
function addressMailbox(message, header) {
    const address = firstAddress(message, header);
    return address && address[2] ? decodeHeader(address[2]) : '';
}

/**
 * DISPLAY sort value of the first address in a header (RFC 5957 sections 3 and 4): the decoded
 * addr-name, or addr-mailbox@addr-host, or addr-mailbox, or the empty string
 *
 * @param {Object} message Message object
 * @param {String} header "from" or "to"
 * @return {String} Unicode string
 */
function displayAddress(message, header) {
    const address = firstAddress(message, header);
    const name = address && address[0] ? decodeHeader(address[0]) : '';
    if (name || !address || !address[2]) {
        return name;
    }
    return decodeHeader(address[3] ? address[2] + '@' + address[3] : address[2]);
}

/**
 * Lists the Message IDs in a header value, normalized so that quoting does not matter (RFC 5256
 * section 3, REFERENCES): comments and white space are dropped and a quoted id-left is unquoted.
 * Only ids of the form "<" id-left "@" id-right ">" (RFC 5322 section 3.6.4) are valid.
 *
 * @param {String|Array} value Header value
 * @return {Array} Message IDs
 */
function parseMessageIds(value) {
    const str = [].concat(value || []).join(' ');
    const ids = [];
    let depth = 0;
    let quoted = false;
    let current = null;

    for (let i = 0; i < str.length; i++) {
        const char = str.charAt(i);
        if (quoted) {
            if (char === '\\') {
                if (current !== null) {
                    current += str.charAt(i + 1);
                }
                i++;
            } else if (char === '"') {
                quoted = false;
            } else if (current !== null) {
                current += char;
            }
        } else if (depth) {
            if (char === '\\') {
                i++;
            } else if (char === '(') {
                depth++;
            } else if (char === ')') {
                depth--;
            }
        } else if (char === '"') {
            quoted = true;
        } else if (char === '(') {
            depth++;
        } else if (char === '<') {
            current = '';
        } else if (char === '>') {
            if (current !== null) {
                const at = current.lastIndexOf('@');
                if (at > 0 && at < current.length - 1) {
                    ids.push(current);
                }
            }
            current = null;
        } else if (current !== null && !/\s/.test(char)) {
            current += char;
        }
    }
    return ids;
}

/**
 * Runs the search part of SORT and THREAD (RFC 5256 section 3): the charset is mandatory and the
 * criteria follow it, both as in SEARCH. Sends a tagged BAD or NO response if the search fails.
 *
 * @param {Object} connection IMAP connection
 * @param {Object} parsed Parsed command
 * @param {String} data Raw command
 * @param {Array} attributes Command arguments starting with the charset
 * @return {Object|Boolean} `{ list, numbers }` like the SEARCH handler returns, or false after an error
 */
function searchMessages(connection, parsed, data, attributes) {
    const command = parsed.command.toUpperCase();
    const charset = attributes[0];
    try {
        // RFC 5256 section 5: charset = atom / quoted
        if (attributes.length < 2) {
            throw badError(command + ' expects a charset and search criteria');
        }
        if (!charset || ['ATOM', 'STRING'].indexOf(charset.type) < 0) {
            throw badError('Charset must be an atom or a quoted string');
        }
        const convert = (argument, i) => {
            if (Array.isArray(argument)) {
                return argument.map(convert);
            }
            if (!argument || ['STRING', 'ATOM', 'LITERAL', 'SEQUENCE'].indexOf(argument.type) < 0) {
                throw badError('Invalid search criteria argument #' + (i + 1));
            }
            return argument.value;
        };
        const params = ['CHARSET', charset.value].concat(attributes.slice(1).map(convert));
        return makeSearch(connection, connection.getSessionMessages(), params);
    } catch (E) {
        const attributes = [];
        if (E.code === 'BADCHARSET') {
            // RFC 5256 section 3 and RFC 3501 section 7.1: NO [BADCHARSET (charsets)]
            attributes.push({
                type: 'SECTION',
                section: [{ type: 'ATOM', value: 'BADCHARSET' }, E.charsets.map(value => ({ type: 'ATOM', value }))]
            });
        }
        attributes.push({ type: 'TEXT', value: E.message });
        connection.send({ tag: parsed.tag, command: E.imapResponse === 'BAD' ? 'BAD' : 'NO', attributes }, command + ' FAILED', parsed, data);
        return false;
    }
}

module.exports = {
    decodeHeader,
    collationKey,
    baseSubject,
    arrivalTime,
    sentTime,
    addressMailbox,
    displayAddress,
    parseMessageIds,
    searchMessages
};
