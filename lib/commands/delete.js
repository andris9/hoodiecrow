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
    connection.server.mailboxChanged('delete', mailbox.path, { mailbox });

    // RFC 2180 section 3.3: the other sessions that have the mailbox selected are disconnected with an untagged
    // BYE (RFC 2683 section 3.1.2), as they can not be told about the deletion in any other way
    connection.server.connections.forEach(other => {
        if (other !== connection && other.selectedMailbox === mailbox) {
            other.bye('Selected mailbox was deleted', 'MAILBOX DELETED');
        }
    });

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
