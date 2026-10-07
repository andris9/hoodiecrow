'use strict';

const fetchHandlers = require('../commands/handlers/fetch');

/**
 * @help Adds STATUS=SIZE [RFC8438] capability. The SIZE status item
 * @help is the sum of the RFC822.SIZE values of the messages, it can
 * @help also be used with LIST-STATUS
 */

module.exports = function (server) {
    server.registerCapability('STATUS=SIZE');

    server.allowedStatus.push('SIZE');

    // RFC 8438 section 3: at least the sum of the RFC822.SIZE values of all messages in the mailbox
    server.statusHandlers.SIZE = (connection, mailbox) =>
        mailbox.messages.reduce((size, message) => size + fetchHandlers['RFC822.SIZE'](connection, message), 0);
};
