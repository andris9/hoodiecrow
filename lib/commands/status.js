'use strict';

const { parseStatusItems, sendStatus } = require('./handlers/status');

module.exports = function (connection, parsed, data, callback) {
    if (
        !parsed.attributes ||
        parsed.attributes.length !== 2 ||
        !parsed.attributes[0] ||
        ['STRING', 'LITERAL', 'ATOM'].indexOf(parsed.attributes[0].type) < 0 ||
        !Array.isArray(parsed.attributes[1]) ||
        !parsed.attributes[1].length
    ) {
        connection.send(
            {
                tag: parsed.tag,
                command: 'BAD',
                attributes: [
                    {
                        type: 'TEXT',
                        value: 'STATUS expects mailbox argument and a list of status items'
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

    // invalid arguments are BAD even for a mailbox that does not exist
    let items;
    try {
        items = parseStatusItems(connection.server, parsed.attributes[1]);
    } catch (err) {
        connection.sendStatus(parsed, data, 'BAD', err.message, false, 'STATUS FAILED');
        return callback();
    }

    const mailbox = connection.server.getMailbox(path);

    if (!mailbox || mailbox.flags.indexOf('\\Noselect') >= 0) {
        connection.sendStatus(parsed, data, 'NO', 'Mailbox does not exist', 'NONEXISTENT', 'STATUS FAILED');
        return callback();
    }

    sendStatus(connection, path, mailbox, items, parsed, data);

    connection.send(
        {
            tag: parsed.tag,
            command: 'OK',
            attributes: [
                {
                    type: 'TEXT',
                    value: 'Status completed'
                }
            ]
        },
        'STATUS',
        parsed,
        data
    );
    return callback();
};
