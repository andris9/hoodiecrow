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
                        value: 'EXPUNGE does not take any arguments'
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
                        value: 'Select mailbox first'
                    }
                ]
            },
            'EXPUNGE FAILED',
            parsed,
            data
        );
        return callback();
    }

    if (connection.readOnly) {
        connection.send(
            {
                tag: parsed.tag,
                command: 'NO',
                attributes: [
                    {
                        type: 'TEXT',
                        value: 'Mailbox is read-only'
                    }
                ]
            },
            'EXPUNGE FAILED',
            parsed,
            data
        );
        return callback();
    }

    connection.expungeDeleted(connection.selectedMailbox, false, true);

    connection.send(
        {
            tag: parsed.tag,
            command: 'OK',
            attributes: [
                {
                    type: 'TEXT',
                    value: 'EXPUNGE Completed'
                }
            ]
        },
        'EXPUNGE',
        parsed,
        data
    );

    callback();
};
