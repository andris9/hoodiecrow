import type { Callback, IMAPConnection, ParsedCommand } from '../types.js';

export default function noopCommand(connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) {
    connection.send(
        {
            tag: parsed.tag,
            command: 'OK',
            attributes: [
                {
                    type: 'TEXT',
                    value: 'Completed'
                }
            ]
        },
        'NOOP completed',
        parsed,
        data
    );

    callback();
}
