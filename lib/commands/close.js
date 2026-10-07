'use strict';

module.exports = function (connection, parsed, data, callback) {
    // a read-only mailbox is closed without removing anything
    if (connection.canExpunge()) {
        connection.expungeDeleted(connection.selectedMailbox, true);
    }

    // CLOSE does not send pending EXPUNGE or EXISTS responses (RFC 3501 section 6.4.2)
    connection.notificationQueue = [];

    connection.send(
        {
            tag: parsed.tag,
            command: 'OK',
            attributes: [
                {
                    type: 'TEXT',
                    value: 'Mailbox closed'
                }
            ]
        },
        'CLOSE',
        parsed,
        data
    );

    connection.state = 'Authenticated';
    connection.selectedMailbox = false;
    return callback();
};
