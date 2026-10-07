import { parseStatusItems, sendStatus } from './handlers/status.js';
import type { Callback, IMAPConnection, ParsedCommand } from '../types.js';

export default function statusCommand(connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) {
    if (
        !parsed.attributes ||
        parsed.attributes.length !== 2 ||
        !parsed.attributes[0] ||
        ['STRING', 'LITERAL', 'ATOM'].indexOf(parsed.attributes[0].type) < 0 ||
        !Array.isArray(parsed.attributes[1]) ||
        !parsed.attributes[1].length
    ) {
        connection.send(
            {
                tag: parsed.tag,
                command: 'BAD',
                attributes: [
                    {
                        type: 'TEXT',
                        value: 'STATUS expects mailbox argument and a list of status items'
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

    // invalid arguments are BAD even for a mailbox that does not exist
    let items;
    try {
        items = parseStatusItems(connection.server, parsed.attributes[1], connection);
    } catch (err) {
        connection.sendStatus(parsed, data, 'BAD', (err as Error).message, false, 'STATUS FAILED');
        return callback();
    }

    const mailbox = connection.server.getMailbox(path);

    if (!mailbox || mailbox.flags.indexOf('\\Noselect') >= 0) {
        connection.sendStatus(parsed, data, 'NO', 'Mailbox does not exist', 'NONEXISTENT', 'STATUS FAILED');
        return callback();
    }

    sendStatus(connection, path, mailbox, items, parsed, data);

    // RFC 3501 section 6.3.10 and RFC 9051 section 6.3.11: STATUS SHOULD NOT be used on the selected mailbox. It
    // works, but the client gets the CLIENTBUG response code (RFC 5530 section 3) like RFC 9051 section 7.1 shows
    const clientBug = connection.state === 'Selected' && connection.selectedMailbox === mailbox;
    connection.sendStatus(
        parsed,
        data,
        'OK',
        clientBug ? 'Status completed, STATUS SHOULD NOT be used on the selected mailbox' : 'Status completed',
        clientBug && 'CLIENTBUG'
    );
    return callback();
}
