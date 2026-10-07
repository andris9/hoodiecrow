import { states } from '../command-states.js';
import type { Callback, IMAPConnection, IMAPServer, ParsedCommand } from '../types.js';

/**
 * @help Adds UNSELECT [RFC3691] capability
 */

export default function unselectPlugin(server: IMAPServer) {
    server.registerCapability('UNSELECT');

    server.setCommandHandler(
        'UNSELECT',
        (connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
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
        },
        { states: states.SELECTED, noArguments: true }
    );
}
