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
                        value: 'SUBSCRIBE expects mailbox name'
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

    if (!mailbox || mailbox.flags.indexOf('\\Noselect') >= 0) {
        connection.sendStatus(parsed, data, 'NO', 'Mailbox does not exist', 'NONEXISTENT', 'SUBSCRIBE FAILED');
        return callback();
    }

    mailbox.subscribed = true;

    connection.send(
        {
            tag: parsed.tag,
            command: 'OK',
            attributes: [
                {
                    type: 'TEXT',
                    value: 'SUBSCRIBE completed'
                }
            ]
        },
        'SUBSCRIBE',
        parsed,
        data
    );
    return callback();
};
