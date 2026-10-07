'use strict';

module.exports = function (connection, parsed, data, callback) {
    if (
        !parsed.attributes ||
        parsed.attributes.length !== 2 ||
        !parsed.attributes[0] ||
        ['STRING', 'LITERAL', 'ATOM'].indexOf(parsed.attributes[0].type) < 0 ||
        !parsed.attributes[1] ||
        ['STRING', 'LITERAL', 'ATOM'].indexOf(parsed.attributes[1].type) < 0
    ) {
        connection.send(
            {
                tag: parsed.tag,
                command: 'BAD',
                attributes: [
                    {
                        type: 'TEXT',
                        value: 'RENAME expects mailbox source and destination names'
                    }
                ]
            },
            'INVALID COMMAND',
            parsed,
            data
        );
        return callback();
    }

    const source = parsed.attributes[0].value;
    const destination = parsed.attributes[1].value;

    if (!connection.checkMailboxName(source, parsed, data) || !connection.checkMailboxName(destination, parsed, data)) {
        return callback();
    }
    const server = connection.server;
    const mailbox = server.getMailbox(source);
    const target = server.getMailbox(destination);

    const sendError = (code, message) => {
        connection.sendStatus(parsed, data, 'NO', message, code, 'RENAME FAILED');
        return callback();
    };

    // check everything that can be checked up front, so that a failed RENAME never loses the source
    if (!mailbox || mailbox.flags.indexOf('\\Noselect') >= 0) {
        return sendError('NONEXISTENT', 'Mailbox does not exist');
    }

    if (target && target.flags.indexOf('\\Noselect') < 0) {
        return sendError('ALREADYEXISTS', 'Mailbox already exists');
    }

    const separator = (server.storage[mailbox.namespace] || {}).separator || '/';
    if (destination.substr(0, mailbox.path.length + separator.length) === mailbox.path + separator) {
        return sendError(false, 'Can not move a mailbox into itself');
    }

    try {
        if (source.toUpperCase() === 'INBOX') {
            // Renaming INBOX moves its messages to the new mailbox and leaves INBOX empty (RFC 3501 section 6.3.5)
            server.createMailbox(destination);
            const newMailbox = server.getMailbox(destination);
            mailbox.messages.forEach(message => {
                server.appendMessage(newMailbox, [].concat(message.flags), message.internaldate, message.raw);
            });
            connection.expungeSpecificMessages(mailbox, () => true);
        } else {
            server.deleteMailbox(source, true);
            try {
                server.createMailbox(destination, mailbox);
            } catch (E) {
                // put the source mailbox back where it was
                server.createMailbox(source, mailbox);
                server.indexFolders();
                throw E;
            }
            server.indexFolders();
        }
    } catch (E) {
        return sendError(false, E.message);
    }

    connection.send(
        {
            tag: parsed.tag,
            command: 'OK',
            attributes: [
                {
                    type: 'TEXT',
                    value: 'RENAME completed'
                }
            ]
        },
        'RENAME',
        parsed,
        data,
        mailbox
    );
    return callback();
};
