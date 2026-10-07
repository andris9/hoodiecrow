'use strict';

/**
 * @help Adds ENABLE capability [RFC5161]
 * @help Plugins that can be enabled (eg. CONDSTORE)
 * @help can be loaded in any order
 */

module.exports = function (server) {
    server.registerCapability('ENABLE');

    // Shared with plugins that can be enabled, these might be loaded before or after this one
    server.enableAvailable = server.enableAvailable || [];

    server.connectionHandlers.push(connection => {
        connection.enabled = connection.enabled || [];
    });

    server.setCommandHandler('ENABLE', (connection, parsed, data, callback) => {
        let capability;
        let i;
        let len;

        // RFC 5161 lets servers skip the "no mailbox selected" check, so ENABLE is allowed in Selected state as well
        if (['Authenticated', 'Selected'].indexOf(connection.state) < 0) {
            connection.send(
                {
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [
                        {
                            type: 'TEXT',
                            value: 'ENABLE not allowed now.'
                        }
                    ]
                },
                'ENABLE FAILED',
                parsed,
                data
            );
            return callback();
        }

        if (!parsed.attributes) {
            connection.send(
                {
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [
                        {
                            type: 'TEXT',
                            value: 'ENABLE expects capability list'
                        }
                    ]
                },
                'INVALID COMMAND',
                parsed,
                data
            );
            return callback();
        }

        for (i = 0, len = parsed.attributes.length; i < len; i++) {
            if (!parsed.attributes[i] || parsed.attributes[i].type !== 'ATOM') {
                connection.send(
                    {
                        tag: parsed.tag,
                        command: 'BAD',
                        attributes: [
                            {
                                type: 'TEXT',
                                value: 'Attribute nr ' + (i + 1) + ' is not an ATOM'
                            }
                        ]
                    },
                    'INVALID COMMAND',
                    parsed,
                    data
                );
                return callback();
            }
        }

        // The ENABLED response lists only the extensions enabled by this command
        const enabled = [];
        for (i = 0, len = parsed.attributes.length; i < len; i++) {
            capability = parsed.attributes[i].value.toUpperCase();
            if (connection.enabled.indexOf(capability) < 0 && server.enableAvailable.indexOf(capability) >= 0) {
                connection.enabled.push(capability);
                enabled.push(capability);
            }
        }

        connection.send(
            {
                tag: '*',
                command: 'ENABLED',
                attributes: enabled.map(capability => ({
                    type: 'ATOM',
                    value: capability
                }))
            },
            'ENABLED',
            parsed,
            data,
            enabled
        );

        connection.send(
            {
                tag: parsed.tag,
                command: 'OK',
                attributes: [
                    {
                        type: 'TEXT',
                        value: 'ENABLE completed'
                    }
                ]
            },
            'ENABLE',
            parsed,
            data
        );

        return callback();
    });
};
