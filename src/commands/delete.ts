import { deleteMailbox } from '../store-operations.js';
import type { Callback, IMAPConnection, IMAPError, ParsedCommand } from '../types.js';

export default function deleteCommand(connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) {
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

    try {
        deleteMailbox(connection.server, path);
    } catch (err) {
        const E = err as IMAPError;
        connection.sendStatus(parsed, data, 'NO', E.message, E.code, 'DELETE FAILED');
        return callback();
    }

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
}
