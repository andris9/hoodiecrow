'use strict';

// RFC 2047 encoded words in header values, decoded for SEARCH, SORT and THREAD

// RFC 2047 section 2: encoded-word = "=?" charset "?" encoding "?" encoded-text "?=", RFC 2231 section 5
// adds an optional "*" language suffix to the charset
const ENCODED_WORD = /=\?([^?\s*]+)(?:\*[^?\s]*)?\?([BbQq])\?([^?\s]*)\?=/g;

const utf8Decoder = new TextDecoder('utf-8');

/**
 * Reads a binary string (one char per octet) as UTF-8, invalid sequences become U+FFFD
 */
function decodeUtf8(value) {
    return utf8Decoder.decode(Buffer.from(value, 'binary'));
}

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
    if (value.indexOf('=?') < 0 && !/[\u0080-\u00ff]/.test(value)) {
        // nothing to decode
        return value;
    }
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
            result += decodeUtf8(between);
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
    return result + decodeUtf8(value.substr(lastIndex));
}

module.exports = { decodeHeader, decodeUtf8 };
