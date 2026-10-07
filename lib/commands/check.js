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
                        value: 'CHECK does not take any arguments'
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
            'CHECK FAILED',
            parsed,
            data
        );
        return callback();
    }

    connection.send(
        {
            tag: parsed.tag,
            command: 'OK',
            attributes: [
                {
                    type: 'TEXT',
                    value: 'Completed'
                }
            ]
        },
        'CHECK',
        parsed,
        data
    );

    callback();
};
