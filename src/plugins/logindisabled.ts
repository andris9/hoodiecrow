import type { Callback, CommandHandler, IMAPConnection, IMAPServer, ParsedCommand } from '../types.js';

/**
 * @help Disables LOGIN support for unencrypted connections
 */

export default function logindisabledPlugin(server: IMAPServer) {
    server.registerCapability('LOGINDISABLED', (connection: IMAPConnection) => {
        return !connection.secureConnection && connection.state === 'Not Authenticated';
    });

    // Retrieve actual LOGIN handler
    // Will be run if conditions are met
    const oldHandler = server.getCommandHandler('LOGIN') as CommandHandler;

    // Override LOGIN
    server.setCommandHandler('LOGIN', (connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
        // If the connection is unsecure, do not allow LOGIN
        if (!connection.secureConnection) {
            connection.send(
                {
                    tag: parsed.tag,
                    command: 'NO',
                    attributes: [
                        {
                            type: 'SECTION',
                            section: [
                                {
                                    type: 'ATOM',
                                    value: 'PRIVACYREQUIRED'
                                }
                            ]
                        },
                        {
                            type: 'TEXT',
                            value: 'Run STARTTLS first'
                        }
                    ]
                },
                'LOGIN FAILED',
                parsed,
                data
            );
            return callback();
        }

        // Reroute command to actual LOGIN handler
        oldHandler(connection, parsed, data, callback);
    });
}
