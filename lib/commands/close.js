'use strict';

module.exports = function (connection, parsed, data, callback) {
    if (parsed.attributes) {
        connection.send(
            {
                tag: parsed.tag,
                command: 'BAD',
                attributes: [
                    {
                        type: 'TEXT',
                        value: 'CLOSE does not take any arguments'
                    }
                ]
            },
            'INVALID COMMAND',
            parsed,
            data
        );
        return callback();
    }

    if (connection.state !== 'Selected') {
        connection.send(
            {
                tag: parsed.tag,
                command: 'BAD',
                attributes: [
                    {
                        type: 'TEXT',
                        value: 'Select a mailbox first'
                    }
                ]
            },
            'CLOSE FAILED',
            parsed,
            data
        );
        return callback();
    }

    // a read-only mailbox is closed without removing anything
    if (!connection.readOnly) {
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
