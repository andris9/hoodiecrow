'use strict';

// Message values for SORT and THREAD (RFC 5256): string collation, base subject, sent date,
// addresses and Message IDs, and the search step that both commands start with

const { getMessageData } = require('./mimeparser');
const { processAddress } = require('./envelope');
const { parseDateTime, parseHeaderDate, toTimestamp } = require('./dates');
const makeSearch = require('./commands/handlers/search');
const { badError, criteriaValues, sendSearchError } = makeSearch;
const { decodeHeader } = require('./encoded-words');

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

/**
 * Internal date and time of a message in milliseconds (RFC 5256 ARRIVAL)
 *
 * @param {Object} message Message object
 * @return {Number} timestamp, 0 if the internal date can not be parsed
 */
function arrivalTime(message) {
    const date = parseDateTime(message.internaldate);
    return date ? toTimestamp(date) : 0;
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
    const date = parseHeaderDate(getMessageData(message).tree.parsedHeader.date);
    if (!date) {
        return arrivalTime(message);
    }
    if (date.hours === undefined || date.hours > 23 || date.minutes > 59 || date.seconds > 60) {
        Object.assign(date, { hours: 0, minutes: 0, seconds: 0 });
    }
    return toTimestamp(date);
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
        const criteria = criteriaValues(attributes.slice(1));
        if (connection.searchCharset) {
            // RFC 9755 section 3: with a fixed session charset (UTF8=ACCEPT) other charsets are BAD
            if (charset.value.toUpperCase() !== connection.searchCharset) {
                throw badError('Charset must be ' + connection.searchCharset + ' in this session');
            }
            return makeSearch(connection, connection.getSessionMessages(), criteria);
        }
        const params = ['CHARSET', charset.value].concat(criteria);
        return makeSearch(connection, connection.getSessionMessages(), params);
    } catch (E) {
        sendSearchError(connection, parsed, data, E, command + ' FAILED');
        return false;
    }
}

module.exports = {
    collationKey,
    baseSubject,
    arrivalTime,
    sentTime,
    addressMailbox,
    displayAddress,
    parseMessageIds,
    searchMessages
};
