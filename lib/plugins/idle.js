'use strict';

/**
 * @help Adds IDLE [RFC2177] capability
 */

module.exports = function (server) {
    server.registerCapability('IDLE');

    server.setCommandHandler('IDLE', (connection, parsed, data, callback) => {
        if (connection.state === 'Not Authenticated') {
            connection.send(
                {
                    tag: parsed.tag,
                    command: 'NO',
                    attributes: [
                        {
                            type: 'TEXT',
                            value: 'Login first'
                        }
                    ]
                },
                'INVALID COMMAND',
                parsed,
                data
            );
            return callback();
        }

        if (parsed.attributes) {
            connection.send(
                {
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [
                        {
                            type: 'TEXT',
                            value: 'Unexpected arguments to IDLE'
                        }
                    ]
                },
                'INVALID COMMAND',
                parsed,
                data
            );
            return callback();
        }

        const idleTimer = setTimeout(
            () => {
                if (connection.socket && !connection.socket.destroyed) {
                    connection.send(
                        {
                            tag: '*',
                            command: 'BYE',
                            attributes: [
                                {
                                    type: 'TEXT',
                                    value: 'IDLE terminated'
                                }
                            ]
                        },
                        'IDLE EXPIRED',
                        parsed,
                        data
                    );
                    connection.socket.end();
                }
            },
            30 * 60 * 1000
        );
        // An idling client should not keep the process alive
        idleTimer.unref();

        const clearIdleTimer = () => clearTimeout(idleTimer);
        const socket = connection.socket;
        if (socket) {
            socket.once('close', clearIdleTimer);
        }

        connection.directNotifications = true;

        // Temporarily redirect client input to this function
        connection.inputHandler = function (str) {
            clearIdleTimer();
            if (socket) {
                socket.removeListener('close', clearIdleTimer);
            }

            // Stop listening to any other user input
            connection.inputHandler = false;

            // Notifications are sent again only while a command is in progress
            connection.directNotifications = false;

            if (str.toUpperCase() === 'DONE') {
                connection.send(
                    {
                        tag: parsed.tag,
                        command: 'OK',
                        attributes: [
                            {
                                type: 'TEXT',
                                value: 'IDLE terminated'
                            }
                        ]
                    },
                    'IDLE',
                    parsed,
                    data
                );
            } else {
                connection.send(
                    {
                        tag: parsed.tag,
                        command: 'BAD',
                        attributes: [
                            {
                                type: 'TEXT',
                                value: 'Invalid Idle continuation'
                            }
                        ]
                    },
                    'INVALID IDLE',
                    parsed,
                    data
                );
            }
        };

        if (connection.socket && !connection.socket.destroyed) {
            connection.socket.write('+ idling\r\n');
        }

        connection.processNotifications();

        return callback();
    });
};
