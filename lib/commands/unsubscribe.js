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
                        value: 'UNSUBSCRIBE expects mailbox name'
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
        connection.send(
            {
                tag: parsed.tag,
                command: 'OK',
                attributes: [
                    {
                        type: 'TEXT',
                        value: 'UNSUBSCRIBE completed'
                    }
                ]
            },
            'UNSUBSCRIBE',
            parsed,
            data
        );
        return callback();
    }

    if (mailbox.flags.indexOf('\\Noselect') >= 0) {
        connection.sendStatus(parsed, data, 'NO', 'Mailbox does not exist', 'NONEXISTENT', 'UNSUBSCRIBE FAILED');
        return callback();
    }

    if (mailbox.subscribed) {
        mailbox.subscribed = false;
        connection.server.mailboxChanged('unsubscribe', mailbox.path);
    }

    connection.send(
        {
            tag: parsed.tag,
            command: 'OK',
            attributes: [
                {
                    type: 'TEXT',
                    value: 'UNSUBSCRIBE completed'
                }
            ]
        },
        'UNSUBSCRIBE',
        parsed,
        data
    );
    return callback();
};
