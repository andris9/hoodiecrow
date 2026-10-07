'use strict';

const { getMessageData, resolveNode, render, parseTree, normalizeLineBreaks, IDENTITY_ENCODINGS } = require('../mimeparser');
const { applyPartial } = require('../commands/handlers/fetch');

/**
 * @help Adds BINARY [RFC3516] capability
 *
 * BINARY: https://www.rfc-editor.org/rfc/rfc3516
 *
 * Additional FETCH items:
 * - BINARY[<part>]<<partial>>, BINARY.PEEK[<part>]<<partial>> and BINARY.SIZE[<part>]
 *
 * APPEND accepts the message as a literal8 (~{n}), binary parts are stored base64 encoded
 */

// RFC 3516 section 7: section-binary = "[" [section-part] "]", section-part = nz-number *("." nz-number)
const SECTION_PART = /^[1-9]\d*(?:\.[1-9]\d*)*$/;

// decoded leaf parts, the tree of a message is replaced when its source changes
const decodedCache = new WeakMap();

/**
 * Creates an error that fails a command with NO [UNKNOWN-CTE] (RFC 3516 sections 4.3 and 4.4)
 *
 * @param {String} message Human readable text
 * @return {Error}
 */
function unknownCte(message) {
    const err = new Error(message);
    err.imapResponse = 'NO';
    err.code = 'UNKNOWN-CTE';
    return err;
}

/**
 * Returns the media type of a tree node, e.g. "text/plain"
 */
function mediaType(node) {
    const contentType = node.parsedHeader['content-type'];
    return ((contentType && contentType.value) || '').toLowerCase();
}

/**
 * Returns the lower case content transfer encoding of a node, 7bit if not set (RFC 2045 section 6.1)
 */
function transferEncoding(node) {
    return (node.parsedHeader['content-transfer-encoding'] || '7bit').toString().trim().toLowerCase();
}

/**
 * RFC 9051 section 6.4.5: BINARY applies to leaf body parts only, not to multipart/*, message/rfc822
 * or message/global parts
 */
function isLeaf(node) {
    const type = mediaType(node);
    return !node.boundary && !/^multipart\//.test(type) && type !== 'message/rfc822' && type !== 'message/global';
}

/**
 * Decodes base64 data. RFC 2045 section 6.8: characters outside the base64 alphabet are ignored, and
 * "=" marks the end of the data
 *
 * @param {String} str Encoded data
 * @return {String} Decoded octets as a binary string
 */
function decodeBase64(str) {
    let data = str.replace(/[^A-Za-z0-9+/=]/g, '').split('=')[0];
    if (data.length % 4 === 1) {
        // a single leftover character does not hold a whole octet
        data = data.slice(0, -1);
    }
    return Buffer.from(data, 'base64').toString('binary');
}

/**
 * Decodes quoted-printable data (RFC 2045 section 6.7). Trailing white space of a line is removed
 * (rule 3), a line that ends with "=" continues on the next line (rule 5), and an "=" that is not
 * followed by two hex digits is kept as it is, as the RFC suggests for robust implementations
 *
 * @param {String} str Encoded data with CRLF line breaks
 * @return {String} Decoded octets as a binary string
 */
function decodeQuotedPrintable(str) {
    return str
        .replace(/[ \t]+(?=\r\n|$)/g, '')
        .replace(/=(?:\r\n|$)/g, '')
        .replace(/=([0-9A-Fa-f]{2})/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Returns the content of a BINARY section with the content transfer encoding removed
 *
 * @param {Object} message Message object
 * @param {Object} query Parsed fetch item
 * @return {String} Decoded section as a binary string
 */
function getDecodedSection(message, query) {
    const key = query.value.toUpperCase();
    const section = query.section;

    if (!section) {
        throw new Error(key + ' requires a section');
    }
    if (!section.length) {
        // the grammar allows BINARY[], but the whole message is not a leaf body part
        throw new Error(key + '[] is not allowed, BINARY applies to leaf body parts only (RFC 9051 section 6.4.5)');
    }
    if (section.length !== 1 || section[0].type !== 'ATOM' || !SECTION_PART.test(section[0].value)) {
        throw new Error('Invalid ' + key + ' section, expecting a part number (RFC 3516 section 7)');
    }

    const node = resolveNode(getMessageData(message).tree, section[0].value);
    if (!node) {
        // like BODY[<section>], a part that does not exist is empty
        return '';
    }
    if (!isLeaf(node)) {
        throw new Error(key + '[' + section[0].value + '] is not a leaf body part (RFC 9051 section 6.4.5)');
    }

    if (!decodedCache.has(node)) {
        decodedCache.set(node, decodeNode(node));
    }
    return decodedCache.get(node);
}

/**
 * Removes the content transfer encoding of a leaf part
 *
 * @param {Object} node Tree node
 * @return {String} Decoded body as a binary string
 */
function decodeNode(node) {
    const body = render(node, true);
    const encoding = transferEncoding(node);
    let decoded;
    if (IDENTITY_ENCODINGS.includes(encoding)) {
        decoded = body;
    } else if (encoding === 'base64') {
        decoded = decodeBase64(body);
    } else if (encoding === 'quoted-printable') {
        decoded = decodeQuotedPrintable(body);
    } else {
        throw unknownCte('Unknown Content-Transfer-Encoding ' + JSON.stringify(encoding).replace(/[^\x20-\x7e]/g, '?'));
    }

    // RFC 3516 section 6: textual sections are sent with CRLF line breaks
    return /^text\//.test(mediaType(node)) ? normalizeLineBreaks(decoded) : decoded;
}

/**
 * BINARY[<section>]<<partial>> (RFC 3516 section 4.2)
 */
function fetchBinary(connection, message, query) {
    // RFC 3516 section 4.2: the range applies to the decoded data
    const value = applyPartial(getDecodedSection(message, query), query.partial);

    // RFC 3516 section 4.3: data without NUL is sent as a string, a literal8 only when it is needed
    return {
        type: value.indexOf('\x00') >= 0 ? 'LITERAL8' : 'LITERAL',
        value
    };
}
// BINARY sets \Seen like BODY[<section>] does
fetchBinary.setsSeen = true;

/**
 * BINARY.SIZE[<section>] (RFC 3516 section 4.2), the size of the decoded section
 */
function fetchBinarySize(connection, message, query) {
    if (query.partial) {
        // RFC 3516 section 7: "BINARY.SIZE" section-binary, without a partial
        throw new Error('BINARY.SIZE does not take a partial range');
    }
    return getDecodedSection(message, query).length;
}

/**
 * Base64 encodes the binary parts of a message that was appended as a literal8, as the IMAP4rev1
 * part of the protocol can not carry them (RFC 3516 sections 4.4 and 6): parts with the binary
 * encoding, and parts with an identity encoding that contain NUL octets anyway. Any other NUL octet
 * (in a header, or in a part with another encoding) can not be stored.
 *
 * @param {String} raw Message as a binary string
 * @return {String} Message to store
 */
function storeBinaryMessage(raw) {
    const tree = parseTree(raw);

    // returns true if the node or anything in it was converted
    const convert = node => {
        if (node.childNodes) {
            // every part is converted, so no short circuit
            return node.childNodes.map(convert).includes(true);
        }
        if (node.message) {
            // RFC 2046 section 5.2.1: a message/rfc822 part keeps its identity encoding, its parts are converted
            if (!convert(node.message)) {
                return false;
            }
            node.body = render(node.message);
            return true;
        }
        const encoding = transferEncoding(node);
        if (!isLeaf(node) || !node.body || !(encoding === 'binary' || (IDENTITY_ENCODINGS.includes(encoding) && node.body.indexOf('\x00') >= 0))) {
            return false;
        }
        // RFC 2045 section 6.8: encoded lines are at most 76 characters long
        node.body = Buffer.from(node.body, 'binary')
            .toString('base64')
            .match(/.{1,76}/g)
            .join('\r\n');
        node.header = node.header.filter(line => !/^content-transfer-encoding\s*:/i.test(line)).concat('Content-Transfer-Encoding: base64');
        return true;
    };

    const result = convert(tree) ? render(tree) : raw;
    if (result.indexOf('\x00') >= 0) {
        throw unknownCte('NUL octets are only allowed in the body of a part with the binary, 7bit or 8bit encoding');
    }
    return result;
}

module.exports = function (server) {
    server.registerCapability('BINARY');

    // RFC 3516 section 7: literal8 and the BINARY fetch items with a section and a partial range
    server.parserOptions.literal8 = true;
    server.parserOptions.allowSection.push('BINARY', 'BINARY.PEEK', 'BINARY.SIZE');

    server.fetchHandlers.BINARY = fetchBinary;
    // the same without setting \Seen
    server.fetchHandlers['BINARY.PEEK'] = (connection, message, query) => fetchBinary(connection, message, query);
    server.fetchHandlers['BINARY.SIZE'] = fetchBinarySize;

    // RFC 3516 section 4.4: APPEND takes the message as a literal8
    const appendHandler = server.getCommandHandler('APPEND');
    server.setCommandHandler(
        'APPEND',
        (connection, parsed, data, callback) => {
            const args = parsed.attributes || [];
            try {
                // the mailbox name (the first argument) is never a message, APPEND refuses it as it is
                for (let i = 1; i < args.length; i++) {
                    if (args[i] && args[i].type === 'LITERAL8') {
                        args[i] = { type: 'LITERAL', value: storeBinaryMessage(args[i].value) };
                    }
                }
            } catch (err) {
                connection.sendStatus(parsed, data, 'NO', err.message, err.code, 'APPEND FAILED');
                return callback();
            }
            appendHandler(connection, parsed, data, callback);
        },
        Object.assign({}, server.getCommandOptions('APPEND'), { literal8: true })
    );
};

module.exports.decodeBase64 = decodeBase64;
module.exports.decodeQuotedPrintable = decodeQuotedPrintable;
module.exports.storeBinaryMessage = storeBinaryMessage;
