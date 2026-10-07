import type { Callback, IMAPConnection, IMAPError, Message, ParsedCommand } from '../types.js';

export default function renameCommand(connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) {
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

    const server = connection.server;
    const mailbox = server.getMailbox(source);
    const target = server.getMailbox(destination);

    const sendError = (code: string | undefined, message: string) => {
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

    const separator = server.getSeparator(mailbox);
    if (destination.substr(0, mailbox.path.length + separator.length) === mailbox.path + separator) {
        return sendError('CANNOT', 'Can not move a mailbox into itself');
    }

    const oldPath = mailbox.path;
    let newPath: string;
    try {
        if (source.toUpperCase() === 'INBOX') {
            // Renaming INBOX moves its messages to the new mailbox and leaves INBOX empty (RFC 3501 section 6.3.5)
            const newMailbox = server.createMailbox(destination);
            newPath = newMailbox.path;
            mailbox.messages.forEach((message: Message) => {
                server.copyMessage(newMailbox, message);
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
            newPath = mailbox.path;
        }
    } catch (err) {
        const E = err as IMAPError;
        return sendError(E.code, E.message);
    }
    server.mailboxChanged('rename', newPath, { oldPath });

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
}
