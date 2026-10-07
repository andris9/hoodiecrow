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

    if (['Authenticated', 'Selected'].indexOf(connection.state) < 0) {
        connection.send(
            {
                tag: parsed.tag,
                command: 'BAD',
                attributes: [
                    {
                        type: 'TEXT',
                        value: 'Log in first'
                    }
                ]
            },
            'RENAME FAILED',
            parsed,
            data
        );
        return callback();
    }

    const source = parsed.attributes[0].value;
    const destination = parsed.attributes[1].value;
    const server = connection.server;
    const mailbox = server.getMailbox(source);
    const target = server.getMailbox(destination);

    const sendError = (code, message) => {
        connection.send(
            {
                tag: parsed.tag,
                command: 'NO',
                attributes: [].concat(
                    code
                        ? {
                              type: 'SECTION',
                              section: [
                                  {
                                      type: 'ATOM',
                                      value: code
                                  }
                              ]
                          }
                        : [],
                    {
                        type: 'TEXT',
                        value: message
                    }
                )
            },
            'RENAME FAILED',
            parsed,
            data
        );
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
