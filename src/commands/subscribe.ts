import { subscribeMailbox } from '../store-operations.js';
import type { Callback, IMAPConnection, IMAPError, ParsedCommand } from '../types.js';

export default function subscribeCommand(connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) {
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

    try {
        subscribeMailbox(connection.server, parsed.attributes[0].value);
    } catch (err) {
        const E = err as IMAPError;
        connection.sendStatus(parsed, data, 'NO', E.message, E.code, 'SUBSCRIBE FAILED');
        return callback();
    }

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
}
