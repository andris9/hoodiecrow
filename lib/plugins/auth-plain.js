'use strict';

/**
 * @help Adds AUTH=PLAIN capability
 * @help Supports SALS-IR [RFC4959] as well
 */

module.exports = function (server) {
    // Register AUTH=PLAIN capability for non authenticated state
    server.registerCapability('AUTH=PLAIN', connection => {
        return connection.state === 'Not Authenticated';
    });

    const sendResponse = (connection, parsed, data, command, message, description) => {
        connection.send(
            {
                tag: parsed.tag,
                command,
                attributes: [
                    {
                        type: 'TEXT',
                        value: message
                    }
                ]
            },
            description,
            parsed,
            data
        );
    };

    // Validates a base64 encoded "authzid NUL authcid NUL passwd" message (RFC 4616) and logs the user in
    const authenticate = (connection, parsed, data, input) => {
        const parts = Buffer.from(input, 'base64').toString().split('\x00');
        const users = connection.server.users;
        const authzid = parts[0] || '';
        const username = parts[1] || '';
        const password = parts[2] || '';

        if (
            parts.length !== 3 ||
            // Acting as another user is not supported, authzid must be empty or the same as authcid
            (authzid && authzid !== username) ||
            !Object.hasOwn(users, username) ||
            !users[username] ||
            users[username].password !== password
        ) {
            return sendResponse(connection, parsed, data, 'NO', 'Login failed: authentication failure', 'AUTHENTICATE PLAIN FAILED');
        }

        connection.state = 'Authenticated';
        sendResponse(connection, parsed, data, 'OK', 'User logged in', 'AUTHENTICATE PLAIN SUCCESS');
    };

    server.setCommandHandler('AUTHENTICATE PLAIN', (connection, parsed, data, callback) => {
        // Not allowed if already logged in
        if (connection.state !== 'Not Authenticated') {
            sendResponse(connection, parsed, data, 'BAD', 'Already authenticated, identity change not allowed', 'AUTHENTICATE PLAIN FAILED');
            return callback();
        }

        // If this is the old style api, send + and wait for password
        if (!parsed.attributes) {
            // Temporarily redirect client input to this function
            connection.inputHandler = function (str) {
                // Stop listening to any other user input
                connection.inputHandler = false;

                if (str.trim() === '*') {
                    // Client cancelled the exchange (RFC 3501 section 6.2.2)
                    return sendResponse(connection, parsed, data, 'BAD', 'Authentication cancelled', 'AUTHENTICATE PLAIN FAILED');
                }

                authenticate(connection, parsed, data, str);
            };

            // Send an empty continuation request to the client
            if (connection.socket && !connection.socket.destroyed) {
                connection.socket.write('+ \r\n');
            }
        } else if (
            parsed.attributes.length === 1 &&
            // second argument must be Base64 string as ATOM
            parsed.attributes[0].type === 'ATOM'
        ) {
            if (!server.capabilities['SASL-IR'] || !server.capabilities['SASL-IR'](connection)) {
                sendResponse(connection, parsed, data, 'BAD', 'SASL-IR must be enabled to send Initial Response with the request', 'AUTHENTICATE PLAIN FAILED');
                return callback();
            }

            authenticate(connection, parsed, data, parsed.attributes[0].value);
        } else {
            // Not correct AUTH=PLAIN
            sendResponse(connection, parsed, data, 'BAD', 'Invalid attributes for AUTHENTICATE PLAIN', 'AUTHENTICATE PLAIN FAILED');
        }

        return callback();
    });
};
