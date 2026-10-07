import type { Callback, IMAPConnection, Mailbox, ParsedCommand } from '../types.js';

export default function closeCommand(connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) {
    // a read-only mailbox is closed without removing anything
    if (connection.canExpunge()) {
        connection.expungeDeleted(connection.selectedMailbox as Mailbox, true);
    }

    // CLOSE does not send pending EXPUNGE or EXISTS responses (RFC 3501 section 6.4.2)
    connection.notificationQueue = [];

    connection.send(
        {
            tag: parsed.tag,
            command: 'OK',
            attributes: [
                {
                    type: 'TEXT',
                    value: 'Mailbox closed'
                }
            ]
        },
        'CLOSE',
        parsed,
        data
    );

    connection.closeMailbox();
    return callback();
}
