'use strict';

const { isUtf8 } = require('buffer');
const mailboxName = require('./mailbox-name');

/**
 * UTF-8 support of a session, shared by the UTF8=ACCEPT (RFC 9755) and IMAP4rev2 (RFC 9051) plugins. Both
 * turn on UTF-8 mailbox names and quoted strings with ENABLE, and they can be loaded in any order, so the
 * state of a session is always computed from what it has enabled, see updateSession().
 */

// RFC 9755 section 3: mailbox names MUST NOT contain control characters, DEL, LINE SEPARATOR or
// PARAGRAPH SEPARATOR. RFC 5198 section 2 (Net-Unicode) also forbids a leading BOM and unassigned code points
// eslint-disable-next-line no-control-regex
const INVALID_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|^\ufeff|\p{Cn}/u;

function badError(message) {
    const err = new Error(message);
    err.imapResponse = 'BAD';
    return err;
}

/**
 * Throws a BAD error for a mailbox name that is not Net-Unicode (RFC 9755 section 3, RFC 9051 section 5.1).
 * RFC 5198 section 2 also requires Normalization Form C
 *
 * @param {String|Boolean} decoded Mailbox name as a unicode string, false if it could not be decoded
 * @return {String} the decoded name
 */
function checkNetUnicode(decoded) {
    if (decoded === false || INVALID_NAME_CHARS.test(decoded)) {
        throw badError('Mailbox name must be valid Net-Unicode without control characters (RFC 9755 section 3)');
    }
    if (decoded.normalize('NFC') !== decoded) {
        throw badError('Mailbox name must be in Unicode Normalization Form C (RFC 5198 section 2, RFC 9051 section 5.1)');
    }
    return decoded;
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

/**
 * Sets the UTF-8 options of a session from the extensions it has enabled. Run it when the session starts,
 * after ENABLE and after UNAUTHENTICATE (once the ENABLE plugin has cleared `connection.enabled`).
 *
 * - With the UTF8=ACCEPT plugin, quoted strings may hold UTF-8 even before ENABLE (RFC 9755 section 3) and
 *   modified UTF-7 names must decode to Net-Unicode. Without it, 8-bit quoted strings are a syntax error until
 *   ENABLE IMAP4rev2, like RFC 3501 says
 * - ENABLE UTF8=ACCEPT or IMAP4rev2: mailbox names are UTF-8 in both directions and strings that are valid
 *   UTF-8 are sent quoted (RFC 9755 section 3, RFC 9051 sections 4.3 and 5.1)
 * - ENABLE UTF8=ACCEPT: SEARCH strings are UTF-8 and CHARSET is refused (RFC 9755 section 3)
 * - ENABLE IMAP4rev2: SEARCH strings are UTF-8 unless a CHARSET says otherwise (RFC 9051 section 6.4.4)
 *
 * @param {Object} connection IMAP connection
 */
function updateSession(connection) {
    const server = connection.server;
    const enabled = connection.enabled || [];
    const accept = enabled.indexOf('UTF8=ACCEPT') >= 0;
    const rev2 = enabled.indexOf('IMAP4rev2') >= 0;
    const utf8Names = accept || rev2;

    // UTF-8 names and quoted strings are on, plugins check this instead of the extension names
    connection.utf8Enabled = utf8Names;
    connection.parserOptions.utf8 = !!server.utf8Accept || rev2;
    connection.compilerOptions.utf8 = utf8Names;
    connection.searchCharset = accept ? 'UTF-8' : false;
    connection.defaultSearchCharset = rev2 ? 'UTF-8' : false;

    if (utf8Names) {
        connection.importMailboxName = importUtf8Name;
        connection.exportMailboxName = exportUtf8Name;
    } else {
        // back to the IMAPConnection methods
        delete connection.exportMailboxName;
        if (server.utf8Accept) {
            connection.importMailboxName = importMutf7Name;
        } else {
            delete connection.importMailboxName;
        }
    }
}

module.exports = { updateSession };
