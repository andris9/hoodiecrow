import type { Callback, IMAPConnection, ParsedCommand } from '../types.js';

export default function unsubscribeCommand(connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) {
    if (!parsed.attributes || parsed.attributes.length !== 1 || !parsed.attributes[0] || ['STRING', 'LITERAL', 'ATOM'].indexOf(parsed.attributes[0].type) < 0) {
        connection.send(
            {
                tag: parsed.tag,
                command: 'BAD',
                attributes: [
                    {
                        type: 'TEXT',
                        value: 'UNSUBSCRIBE expects mailbox name'
                    }
                ]
            },
            'INVALID COMMAND',
            parsed,
            data
        );
        return callback();
    }

    let path = parsed.attributes[0].value;
    if (path.toUpperCase() === 'INBOX') {
        path = 'INBOX';
    }

    // The subscription list holds names, so a name stays removable after its mailbox is deleted
    // (RFC 3501 section 6.3.6). Removing a name that is not subscribed is not an error (RFC 9051 section 6.3.8)
    if (connection.server.subscriptions.delete(path)) {
        connection.server.mailboxChanged('unsubscribe', path);
    }

    connection.send(
        {
            tag: parsed.tag,
            command: 'OK',
            attributes: [
                {
                    type: 'TEXT',
                    value: 'UNSUBSCRIBE completed'
                }
            ]
        },
        'UNSUBSCRIBE',
        parsed,
        data
    );
    return callback();
}
