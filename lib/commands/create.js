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
                        value: 'CREATE expects mailbox name'
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

    if (!connection.checkMailboxName(path, parsed, data)) {
        return callback();
    }

    try {
        connection.server.createMailbox(path);
    } catch (E) {
        // RFC 5530 response codes, e.g. [ALREADYEXISTS]
        connection.sendStatus(parsed, data, 'NO', E.message, E.code, 'CREATE FAILED');
        return callback();
    }

    connection.send(
        {
            tag: parsed.tag,
            command: 'OK',
            attributes: [
                {
                    type: 'TEXT',
                    value: 'CREATE completed'
                }
            ]
        },
        'CREATE',
        parsed,
        data,
        connection.server.getMailbox(path)
    );
    return callback();
};
