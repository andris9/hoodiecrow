'use strict';

const { isUtf8 } = require('buffer');
const mailboxName = require('../mailbox-name');

/**
 * @help Adds UTF8=ACCEPT [RFC9755] capability, loads ENABLE as well
 * @help After ENABLE UTF8=ACCEPT mailbox names are UTF-8 instead of
 * @help modified UTF-7 and strings are sent quoted as UTF-8
 */

// RFC 9755 section 3: mailbox names MUST NOT contain control characters, DEL, LINE SEPARATOR or
// PARAGRAPH SEPARATOR. RFC 5198 section 2 (Net-Unicode) also forbids a leading BOM and unassigned code points
// eslint-disable-next-line no-control-regex
const INVALID_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|^\ufeff|\p{Cn}/u;

/**
 * Checks if the header of a message holds 8-bit octets
 *
 * @param {String} raw Message source as a binary string
 * @return {Boolean} true if the header has 8-bit octets
 */
function has8bitHeader(raw) {
    const match = raw.match(/\r?\n\r?\n/);
    return /[\x80-\xff]/.test(match ? raw.substr(0, match.index) : raw);
}

/**
 * Throws a BAD error for a mailbox name that breaks the RFC 9755 section 3 rules
 *
 * @param {String|Boolean} decoded Mailbox name as a unicode string, false if it could not be decoded
 * @return {String} the decoded name
 */
function checkNetUnicode(decoded) {
    if (decoded === false || INVALID_NAME_CHARS.test(decoded)) {
        throw badError('Mailbox name must be valid Net-Unicode without control characters (RFC 9755 section 3)');
    }
    return decoded;
}

function badError(message) {
    const err = new Error(message);
    err.imapResponse = 'BAD';
    return err;
}

/**
 * Checks a modified UTF-7 mailbox name from a client that did not enable UTF-8. The RFC 9755
 * section 3 rules apply to these names as well, e.g. "&AA0-" encodes CR
 *
 * @param {String} name Mailbox name as a binary string
 * @return {String} Storage name
 * @throws {Error} BAD error if the name is not valid
 */
function importMutf7Name(name) {
    const error = mailboxName(name);
    if (error) {
        throw badError(error);
    }
    checkNetUnicode(mailboxName.decode(name));
    return name;
}

/**
 * Converts a UTF-8 mailbox name from the client to the modified UTF-7 storage name
 *
 * @param {String} name Mailbox name as a binary string
 * @return {String} Storage name
 * @throws {Error} BAD error if the name is not valid
 */
function importUtf8Name(name) {
    const buf = Buffer.from(name, 'binary');
    return mailboxName.encode(checkNetUnicode(isUtf8(buf) && buf.toString('utf-8')));
}

/**
 * Converts a modified UTF-7 storage name to UTF-8. A name that is not valid modified UTF-7
 * is sent as it is.
 *
 * @param {String} path Storage name
 * @return {String} Mailbox name as a binary string
 */
function exportUtf8Name(path) {
    const decoded = mailboxName.decode(path);
    return decoded === false ? path : Buffer.from(decoded, 'utf-8').toString('binary');
}

module.exports = function (server) {
    // RFC 9755 section 3: the client turns UTF-8 support on with ENABLE
    server.registerCapability('UTF8=ACCEPT');

    // Shared with the ENABLE plugin
    server.enableAvailable = server.enableAvailable || [];
    if (server.enableAvailable.indexOf('UTF8=ACCEPT') < 0) {
        server.enableAvailable.push('UTF8=ACCEPT');
    }

    // RFC 9755 section 3: a server that supports UTF8=ACCEPT accepts UTF-8 in quoted strings. Before
    // ENABLE, mailbox names must still be modified UTF-7 and SEARCH needs CHARSET UTF-8 for 8-bit strings
    const disable = connection => {
        connection.parserOptions.utf8 = true;
        connection.compilerOptions.utf8 = false;
        connection.searchCharset = false;
        connection.importMailboxName = importMutf7Name;
        // back to IMAPConnection#exportMailboxName
        delete connection.exportMailboxName;
    };
    server.connectionHandlers.push(disable);
    // RFC 8437 section 3: UNAUTHENTICATE resets the ENABLEd extensions
    server.resetHandlers.push(disable);

    server.outputHandlers.push((connection, response, description, parsed, data, extra) => {
        if (description !== 'ENABLED' || !Array.isArray(extra) || extra.indexOf('UTF8=ACCEPT') < 0) {
            return;
        }
        // strings that are valid UTF-8 are sent quoted, not as literals
        connection.compilerOptions.utf8 = true;
        // RFC 9755 section 3: SEARCH strings are UTF-8 and CHARSET is refused
        connection.searchCharset = 'UTF-8';
        // mailbox names are UTF-8 in both directions, "&" is an ordinary character
        connection.importMailboxName = importUtf8Name;
        connection.exportMailboxName = exportUtf8Name;
    });

    // RFC 9755 section 5: UTF-8 user names and passwords need AUTHENTICATE
    const loginHandler = server.getCommandHandler('LOGIN');
    server.setCommandHandler('LOGIN', (connection, parsed, data, callback) => {
        if ((parsed.attributes || []).some(attr => attr && typeof attr.value === 'string' && /[\x80-\xff]/.test(attr.value))) {
            connection.sendStatus(parsed, data, 'BAD', 'LOGIN does not take UTF-8 user names or passwords, use AUTHENTICATE (RFC 9755 section 5)');
            return callback();
        }
        return loginHandler(connection, parsed, data, callback);
    });

    // RFC 9755 section 4: without ENABLE UTF8=ACCEPT, APPEND MUST be refused with NO
    // if the message header has 8-bit characters
    const appendHandler = server.getCommandHandler('APPEND');
    server.setCommandHandler('APPEND', (connection, parsed, data, callback) => {
        const args = parsed.attributes || [];
        const raw = args[args.length - 1];
        if (
            connection.enabled.indexOf('UTF8=ACCEPT') < 0 &&
            args.length >= 2 &&
            raw &&
            ['LITERAL', 'LITERAL8'].indexOf(raw.type) >= 0 &&
            has8bitHeader(raw.value || '')
        ) {
            connection.sendStatus(parsed, data, 'NO', 'Message header has 8-bit characters, ENABLE UTF8=ACCEPT first (RFC 9755 section 4)');
            return callback();
        }
        return appendHandler(connection, parsed, data, callback);
    });
};

// ENABLE UTF8=ACCEPT is the only way to use this extension
module.exports.requires = ['ENABLE'];
