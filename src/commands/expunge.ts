import type { Callback, IMAPConnection, Mailbox, ParsedCommand } from '../types.js';

export default function expungeCommand(connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) {
    if (connection.refuseReadOnly(parsed, data, 'EXPUNGE FAILED')) {
        return callback();
    }

    connection.expungeDeleted(connection.selectedMailbox as Mailbox, false, true);

    connection.send(
        {
            tag: parsed.tag,
            command: 'OK',
            attributes: [
                {
                    type: 'TEXT',
                    value: 'EXPUNGE Completed'
                }
            ]
        },
        'EXPUNGE',
        parsed,
        data
    );

    callback();
}
