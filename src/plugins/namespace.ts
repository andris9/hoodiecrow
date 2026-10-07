import { states } from '../command-states.js';
import type { Callback, IMAPConnection, IMAPServer, NamespaceType, ParsedCommand } from '../types.js';

/**
 * @help Adds NAMESPACE [RFC2342] capability
 */

export default function namespacePlugin(server: IMAPServer) {
    // Register capability, always usable
    server.registerCapability('NAMESPACE');

    // Add NAMESPACE command
    server.setCommandHandler(
        'NAMESPACE',
        (connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
            const list: Record<NamespaceType, [string, string][]> = {
                personal: [],
                user: [],
                shared: []
            };

            Object.keys(server.storage).forEach(key => {
                const ns = server.storage[key];
                // INBOX is a mailbox, not a namespace
                if (key === 'INBOX' || !ns) {
                    return;
                }
                if (Object.hasOwn(list, ns.type)) {
                    list[ns.type].push([connection.exportMailboxName(key), ns.separator]);
                }
            });

            connection.send(
                {
                    tag: '*',
                    command: 'NAMESPACE',
                    attributes: [list.personal.length ? list.personal : null, list.user.length ? list.user : null, list.shared.length ? list.shared : null]
                },
                'NAMESPACE',
                parsed,
                data,
                list
            );

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
                'NAMESPACE',
                parsed,
                data,
                list
            );

            return callback();
        },
        { states: states.AUTHENTICATED, noArguments: true }
    );
}
