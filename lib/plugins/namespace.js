'use strict';

/**
 * @help Adds NAMESPACE [RFC2342] capability
 */

module.exports = function (server) {
    // Register capability, always usable
    server.registerCapability('NAMESPACE');

    // Add NAMESPACE command
    server.setCommandHandler('NAMESPACE', (connection, parsed, data, callback) => {
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
                            value: 'Unexpected arguments to NAMESPACE'
                        }
                    ]
                },
                'INVALID COMMAND',
                parsed,
                data
            );
            return callback();
        }

        const list = {
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
                list[ns.type].push([key, ns.separator]);
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
    });
};
