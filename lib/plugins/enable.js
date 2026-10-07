'use strict';

const { states } = require('../command-states');

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

    // RFC 8437 section 4.1: extensions enabled with ENABLE cease to be enabled after UNAUTHENTICATE
    server.resetHandlers.push(connection => {
        connection.enabled = [];
    });

    server.setCommandHandler(
        'ENABLE',
        (connection, parsed, data, callback) => {
            let capability;
            let i;
            let len;

            // RFC 5161 section 3.1: "Clients MUST NOT issue ENABLE once they SELECT/EXAMINE a mailbox".
            // Servers do not have to check this, hoodiecrow does to catch the client bug.
            if (connection.everSelected) {
                connection.sendStatus(parsed, data, 'BAD', 'ENABLE is not allowed after SELECT or EXAMINE');
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
            // Capability names are matched case-insensitively and listed in the spelling the server advertises them
            // (`server.enableAvailable`), e.g. "IMAP4rev2", so plugins look them up in `connection.enabled` by that name
            const enabled = [];
            for (i = 0, len = parsed.attributes.length; i < len; i++) {
                const requested = parsed.attributes[i].value.toUpperCase();
                capability = server.enableAvailable.find(name => name.toUpperCase() === requested);
                if (capability && connection.enabled.indexOf(capability) < 0) {
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
        },
        { states: states.AUTHENTICATED }
    );
};
