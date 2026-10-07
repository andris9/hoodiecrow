'use strict';

module.exports = function (connection, parsed, data, callback) {
    if (
        !parsed.attributes ||
        parsed.attributes.length !== 2 ||
        !parsed.attributes[0] ||
        ['STRING', 'LITERAL', 'ATOM'].indexOf(parsed.attributes[0].type) < 0 ||
        !parsed.attributes[1] ||
        ['STRING', 'LITERAL', 'ATOM'].indexOf(parsed.attributes[1].type) < 0
    ) {
        connection.send(
            {
                tag: parsed.tag,
                command: 'BAD',
                attributes: [
                    {
                        type: 'TEXT',
                        value: 'LSUB expects 2 string arguments'
                    }
                ]
            },
            'INVALID COMMAND',
            parsed,
            data
        );
        return callback();
    }

    const folders = connection.server.matchFolders(parsed.attributes[0].value, parsed.attributes[1].value, path => connection.exportMailboxName(path));

    folders.forEach(folder => {
        if (folder.subscribed) {
            connection.send(
                {
                    tag: '*',
                    command: 'LSUB',
                    attributes: [
                        folder.flags.map(flag => {
                            return {
                                type: 'ATOM',
                                value: flag
                            };
                        }),
                        connection.server.storage[folder.namespace].separator,
                        connection.exportMailboxName(folder.path)
                    ]
                },
                'LSUB ITEM',
                parsed,
                data,
                folder
            );
        }
    });

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
        'LSUB',
        parsed,
        data
    );

    return callback();
};
