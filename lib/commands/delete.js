'use strict';

module.exports = function (connection, parsed, data, callback) {
    if (!parsed.attributes || parsed.attributes.length !== 1 || !parsed.attributes[0] || ['STRING', 'LITERAL', 'ATOM'].indexOf(parsed.attributes[0].type) < 0) {
        connection.send(
            {
                tag: parsed.tag,
                command: 'BAD',
                attributes: [
                    {
                        type: 'TEXT',
                        value: 'DELETE expects mailbox name'
                    }
                ]
            },
            'INVALID COMMAND',
            parsed,
            data
        );
        return callback();
    }

    const path = parsed.attributes[0].value;

    const mailbox = connection.server.getMailbox(path);

    if (!mailbox) {
        connection.sendStatus(parsed, data, 'NO', 'Mailbox does not exist', 'NONEXISTENT', 'DELETE FAILED');
        return callback();
    }

    try {
        connection.server.deleteMailbox(path);
    } catch (E) {
        connection.sendStatus(parsed, data, 'NO', E.message, E.code, 'DELETE FAILED');
        return callback();
    }

    connection.send(
        {
            tag: parsed.tag,
            command: 'OK',
            attributes: [
                {
                    type: 'TEXT',
                    value: 'DELETE completed'
                }
            ]
        },
        'DELETE',
        parsed,
        data
    );
    return callback();
};
