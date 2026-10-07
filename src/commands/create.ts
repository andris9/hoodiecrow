import type { Callback, IMAPConnection, IMAPError, ParsedCommand } from '../types.js';

export default function createCommand(connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) {
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

    let mailbox;
    try {
        mailbox = connection.server.createMailbox(path);
    } catch (err) {
        const E = err as IMAPError;
        // RFC 5530 response codes, e.g. [ALREADYEXISTS]
        connection.sendStatus(parsed, data, 'NO', E.message, E.code, 'CREATE FAILED');
        return callback();
    }
    connection.server.mailboxChanged('create', mailbox.path);

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
        mailbox
    );
    return callback();
}
