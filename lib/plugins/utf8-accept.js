'use strict';

const { updateSession } = require('../utf8-session');
const { registerEnable } = require('./enable');

/**
 * @help Adds UTF8=ACCEPT [RFC9755] capability, loads ENABLE as well
 * @help After ENABLE UTF8=ACCEPT mailbox names are UTF-8 instead of
 * @help modified UTF-7 and strings are sent quoted as UTF-8
 */

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

module.exports = function (server) {
    // RFC 9755 section 3: the client turns UTF-8 support on with ENABLE
    server.registerCapability('UTF8=ACCEPT');

    registerEnable(server, 'UTF8=ACCEPT');

    // RFC 9755 section 3: a server that supports UTF8=ACCEPT accepts UTF-8 in quoted strings. Before
    // ENABLE, mailbox names must still be modified UTF-7 and SEARCH needs CHARSET UTF-8 for 8-bit strings.
    // See lib/utf8-session.js, the session state is shared with IMAP4rev2
    server.utf8Accept = true;
    server.connectionHandlers.push(updateSession);
    // RFC 8437 section 3: UNAUTHENTICATE resets the ENABLEd extensions
    server.resetHandlers.push(updateSession);

    server.outputHandlers.push((connection, response, description, parsed, data, extra) => {
        if (description === 'ENABLED' && Array.isArray(extra) && extra.indexOf('UTF8=ACCEPT') >= 0) {
            // strings that are valid UTF-8 are sent quoted, mailbox names are UTF-8 in both directions
            // ("&" is an ordinary character), SEARCH strings are UTF-8 and CHARSET is refused
            updateSession(connection);
        }
    });

    // RFC 9755 section 4: without ENABLE UTF8=ACCEPT, APPEND MUST be refused with NO
    // if the message header has 8-bit characters
    const appendHandler = server.getCommandHandler('APPEND');
    server.setCommandHandler('APPEND', (connection, parsed, data, callback) => {
        const args = parsed.attributes || [];
        const raw = args[args.length - 1];
        if (
            // UTF-8 is on after ENABLE UTF8=ACCEPT, or IMAP4rev2, which permits 8-bit characters in the message
            // (RFC 9051 section 6.3.12) and which RFC 9755 does not extend
            !connection.utf8Enabled &&
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
