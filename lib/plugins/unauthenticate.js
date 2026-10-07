'use strict';

const { states } = require('../command-states');

/**
 * @help Adds UNAUTHENTICATE [RFC8437] capability
 * @help Returns to the Not Authenticated state, everything
 * @help but TLS is reset (selected mailbox, ENABLE, COMPRESS)
 */

module.exports = function (server) {
    server.registerCapability('UNAUTHENTICATE');

    server.setCommandHandler(
        'UNAUTHENTICATE',
        (connection, parsed, data, callback) => {
            // RFC 8437 section 3: a NO response is not permitted, the reset can not fail here
            connection.sendStatus(parsed, data, 'OK', 'Completed, now in not authenticated state');

            // RFC 8437 sections 3 and 4.1: the mailbox is closed without EXPUNGE responses, ENABLEd
            // extensions and CONDSTORE are turned off, and compression ends after the CRLF of the OK
            connection.resetSession();

            return callback();
        },
        { states: states.AUTHENTICATED, noArguments: true }
    );
};
