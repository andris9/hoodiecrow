'use strict';

module.exports = function (connection, parsed, data, callback) {
    const capabilities = ['IMAP4rev1'];

    Object.keys(connection.server.capabilities).forEach(key => {
        if (connection.server.capabilities[key](connection)) {
            capabilities.push(key);
        }
    });

    connection.send(
        {
            tag: '*',
            command: 'CAPABILITY',
            attributes: capabilities.map(capability => {
                return {
                    type: 'TEXT',
                    value: capability
                };
            })
        },
        'CAPABILITY LIST',
        parsed,
        data,
        capabilities
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
        'CAPABILITY COMPLETED',
        parsed,
        data,
        capabilities
    );

    callback();
};
