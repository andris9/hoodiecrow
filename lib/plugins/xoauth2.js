'use strict';

// https://developers.google.com/gmail/xoauth2_protocol

/**
 * @help Enables XOAUTH2 capability
 * @help Implementation difference - Hoodiecrow requires
 * @help SASL-IR enabled and used while Gmail does not
 * @help Valid login info:
 * @help   Username: testuser
 * @help   Access Token: testtoken
 */

module.exports = function (server) {
    // Register capability, usable for non authenticated users
    server.registerCapability('AUTH=XOAUTH2', connection => {
        return connection.state === 'Not Authenticated';
    });

    server.setCommandHandler('AUTHENTICATE XOAUTH2', (connection, parsed, data, callback) => {
        if (!server.capabilities['SASL-IR'] || !server.capabilities['SASL-IR'](connection)) {
            connection.send(
                {
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [
                        {
                            type: 'TEXT',
                            value: 'SASL-IR must be enabled to support XOAUTH2'
                        }
                    ]
                },
                'AUTHENTICATE XOAUTH2 FAILED',
                parsed,
                data
            );
            return callback();
        }

        if (!parsed.attributes || parsed.attributes.length !== 1 || !parsed.attributes[0] || ['STRING', 'ATOM'].indexOf(parsed.attributes[0].type) < 0) {
            connection.send(
                {
                    tag: parsed.tag,
                    command: 'NO',
                    attributes: [
                        {
                            type: 'TEXT',
                            value: 'Invalid SASL argument'
                        }
                    ]
                },
                'AUTHENTICATE XOAUTH2 FAILED',
                parsed,
                data
            );
            return callback();
        }

        const decoded = connection.decodeSaslResponse(parsed.attributes[0].value);
        if (!decoded) {
            connection.sendStatus(parsed, data, 'BAD', 'Invalid base64 in SASL response', false, 'AUTHENTICATE XOAUTH2 FAILED');
            return callback();
        }
        const parts = decoded.toString('utf-8').split('\x01');
        const user = (parts[0] || '').substr(5);
        const accessToken = (parts[1] || '').substr(12);

        if (
            parts.length !== 4 ||
            !parts[0].match(/^user=/) ||
            !parts[1].match(/^auth=Bearer /) ||
            !user || // Must be present
            !accessToken || // Must be present
            parts[2] || // Must be empty
            parts[3] // Must be empty
        ) {
            connection.send(
                {
                    tag: parsed.tag,
                    command: 'NO',
                    attributes: [
                        {
                            type: 'TEXT',
                            value: 'Invalid SASL argument.'
                        }
                    ]
                },
                'AUTHENTICATE XOAUTH2 FAILED',
                parsed,
                data
            );
            return callback();
        }

        const userData = connection.server.getUser(user);
        if (!userData) {
            connection.send(
                {
                    tag: parsed.tag,
                    command: 'NO',
                    attributes: [
                        {
                            type: 'TEXT',
                            value: 'Invalid credentials'
                        }
                    ]
                },
                'AUTHENTICATE XOAUTH2 FAILED',
                parsed,
                data
            );
            return callback();
        }

        if (!userData.xoauth2 || userData.xoauth2.accessToken !== accessToken) {
            connection.send(
                {
                    tag: '+',
                    attributes: [
                        {
                            type: 'ATOM',
                            value: Buffer.from(
                                JSON.stringify({
                                    status: '400',
                                    schemes: 'Bearer',
                                    scope: 'https://mail.google.com/'
                                })
                            ).toString('base64')
                        }
                    ]
                },
                'AUTHENTICATE XOAUTH2 FAILED',
                parsed,
                data
            );

            // wait for response
            connection.inputHandler = function () {
                connection.inputHandler = false;
                connection.send(
                    {
                        tag: parsed.tag,
                        command: 'NO',
                        attributes: [
                            {
                                type: 'TEXT',
                                value: 'SASL authentication failed'
                            }
                        ]
                    },
                    'AUTHENTICATE XOAUTH2 FAILED',
                    parsed,
                    data
                );
            };
        } else {
            connection.state = 'Authenticated';
            connection.username = user;
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
                'AUTHENTICATE XOAUTH2 SUCCESS',
                parsed,
                data
            );
        }
        return callback();
    });
};
