import { renameMailbox } from '../store-operations.js';
import type { Callback, IMAPConnection, IMAPError, ParsedCommand } from '../types.js';

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

    let renamed;
    try {
        renamed = renameMailbox(connection.server, source, destination);
    } catch (err) {
        const E = err as IMAPError;
        connection.sendStatus(parsed, data, 'NO', E.message, E.code, 'RENAME FAILED');
        return callback();
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
        renamed.mailbox
    );
    return callback();
}
