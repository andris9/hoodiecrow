import type { Callback, IMAPConnection, IMAPServer, ParsedCommand } from '../types.js';

/**
 * @help Adds AUTH=PLAIN capability
 * @help Supports SASL-IR [RFC4959] as well
 */

const utf8 = new TextDecoder('utf-8', { fatal: true });

export default function authPlainPlugin(server: IMAPServer) {
    // Register AUTH=PLAIN capability for non authenticated state
    server.registerCapability('AUTH=PLAIN', (connection: IMAPConnection) => {
        return connection.state === 'Not Authenticated';
    });

    // Validates a base64 encoded "authzid NUL authcid NUL passwd" message (RFC 4616) and logs the user in
    const authenticate = (connection: IMAPConnection, parsed: ParsedCommand, data: string, input: string) => {
        const decoded = connection.decodeSaslResponse(input);
        if (!decoded) {
            return connection.sendStatus(parsed, data, 'BAD', 'Invalid base64 in SASL response', false, 'AUTHENTICATE PLAIN FAILED');
        }
        // RFC 4616 section 2: the message is UTF-8, user names are unicode strings like the keys of `users`
        let message;
        try {
            message = utf8.decode(decoded);
        } catch {
            return connection.sendStatus(parsed, data, 'BAD', 'Invalid UTF-8 in SASL PLAIN message', false, 'AUTHENTICATE PLAIN FAILED');
        }
        const parts = message.split('\x00');
        const authzid = parts[0] || '';
        const username = parts[1] || '';
        const password = parts[2] || '';
        const user = connection.server.getUser(username);

        if (parts.length !== 3 || !user || user.password !== password) {
            // RFC 5530 section 3: unknown user or bad password
            return connection.sendStatus(parsed, data, 'NO', 'Login failed: authentication failure', 'AUTHENTICATIONFAILED', 'AUTHENTICATE PLAIN FAILED');
        }

        if (authzid && authzid !== username) {
            // Acting as another user is not supported, authzid must be empty or the same as authcid. The credentials
            // were fine, so this is AUTHORIZATIONFAILED (RFC 5530 section 3, RFC 9051 section 7.1)
            return connection.sendStatus(parsed, data, 'NO', 'Can not act as ' + authzid, 'AUTHORIZATIONFAILED', 'AUTHENTICATE PLAIN FAILED');
        }

        connection.state = 'Authenticated';
        connection.username = username;
        connection.sendStatus(parsed, data, 'OK', 'User logged in', false, 'AUTHENTICATE PLAIN SUCCESS');
    };

    server.setCommandHandler('AUTHENTICATE PLAIN', (connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
        // If this is the old style api, send + and wait for password
        if (!parsed.attributes) {
            // Temporarily redirect client input to this function
            connection.inputHandler = function (str: string) {
                // Stop listening to any other user input
                connection.inputHandler = false;

                if (str === '*') {
                    // Client cancelled the exchange (RFC 3501 section 6.2.2)
                    return connection.sendStatus(parsed, data, 'BAD', 'Authentication cancelled', false, 'AUTHENTICATE PLAIN FAILED');
                }

                authenticate(connection, parsed, data, str);
            };

            // Send an empty continuation request to the client
            connection.sendContinuation('', 'AUTHENTICATE PLAIN');
        } else if (
            parsed.attributes.length === 1 &&
            // second argument must be Base64 string as ATOM
            parsed.attributes[0].type === 'ATOM'
        ) {
            if (!server.capabilities['SASL-IR'] || !server.capabilities['SASL-IR'](connection)) {
                connection.sendStatus(
                    parsed,
                    data,
                    'BAD',
                    'SASL-IR must be enabled to send Initial Response with the request',
                    false,
                    'AUTHENTICATE PLAIN FAILED'
                );
                return callback();
            }

            authenticate(connection, parsed, data, parsed.attributes[0].value);
        } else {
            // Not correct AUTH=PLAIN
            connection.sendStatus(parsed, data, 'BAD', 'Invalid attributes for AUTHENTICATE PLAIN', false, 'AUTHENTICATE PLAIN FAILED');
        }

        return callback();
    });
}
