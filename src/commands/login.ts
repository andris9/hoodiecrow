import type { Callback, IMAPConnection, ParsedCommand } from '../types.js';

export default function loginCommand(connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) {
    // LOGIN expects 2 string params - username and password
    if (
        !parsed.attributes ||
        parsed.attributes.length !== 2 ||
        !parsed.attributes[0] ||
        !parsed.attributes[1] ||
        ['STRING', 'LITERAL', 'ATOM'].indexOf(parsed.attributes[0].type) < 0 ||
        ['STRING', 'LITERAL', 'ATOM'].indexOf(parsed.attributes[1].type) < 0
    ) {
        connection.send(
            {
                tag: parsed.tag,
                command: 'BAD',
                attributes: [
                    {
                        type: 'TEXT',
                        value: 'LOGIN takes 2 string arguments'
                    }
                ]
            },
            'INVALID COMMAND',
            parsed,
            data
        );
        return callback();
    }

    // User names are unicode strings everywhere (LOGIN, SASL, ACL identifiers). LOGIN does not take UTF-8
    // user names or passwords, a client MUST use AUTHENTICATE for these (RFC 6855 and RFC 9755 section 5)
    if (parsed.attributes.some(attr => /[\x80-\xff]/.test(attr.value))) {
        connection.sendStatus(parsed, data, 'BAD', 'LOGIN does not take UTF-8 user names or passwords, use AUTHENTICATE (RFC 9755 section 5)');
        return callback();
    }

    const user = connection.server.getUser(parsed.attributes[0].value);

    if (!user || user.password !== parsed.attributes[1].value) {
        // RFC 5530 section 3: unknown user or bad password
        connection.sendStatus(parsed, data, 'NO', 'Login failed: authentication failure', 'AUTHENTICATIONFAILED', 'LOGIN FAILED');
        return callback();
    }

    connection.state = 'Authenticated';
    // the authenticated user, for plugins that tell users apart (e.g. ACL)
    connection.username = parsed.attributes[0].value;

    connection.send(
        {
            tag: parsed.tag,
            command: 'OK',
            attributes: [
                {
                    type: 'TEXT',
                    value: 'User logged in'
                }
            ]
        },
        'LOGIN SUCCESS',
        parsed,
        data
    );

    callback();
}
