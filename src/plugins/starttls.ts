import type { Callback, IMAPConnection, IMAPServer, ParsedCommand } from '../types.js';

/**
 * @help Adds STARTTLS command
 */

export default function starttlsPlugin(server: IMAPServer) {
    // Register capability, usable with unsecure connection
    server.registerCapability('STARTTLS', (connection: IMAPConnection) => {
        return !connection.secureConnection;
    });

    // Add STARTTLS command
    server.setCommandHandler('STARTTLS', (connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
        // only works in insecure setting
        if (connection.secureConnection) {
            return sendError('Connection is already secured', connection, parsed, data, callback);
        }

        connection.send(
            {
                tag: parsed.tag,
                command: 'OK',
                attributes: [
                    {
                        type: 'TEXT',
                        value: 'Server ready to start TLS negotiation'
                    }
                ]
            },
            'STARTTLS INIT',
            parsed,
            data
        );

        connection.upgradeConnection(callback);
    });
}

function sendError(message: string, connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) {
    connection.send(
        {
            tag: parsed.tag,
            command: 'BAD',
            attributes: [
                {
                    type: 'TEXT',
                    value: message
                }
            ]
        },
        'INVALID COMMAND',
        parsed,
        data
    );
    return callback();
}
