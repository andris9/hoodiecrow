import type { Callback, IMAPConnection, Mailbox, ParsedCommand } from '../types.js';

export default function listCommand(connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) {
    let folders;

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
                        value: 'LIST expects 2 string arguments'
                    }
                ]
            },
            'INVALID COMMAND',
            parsed,
            data
        );
        return callback();
    }

    if (!parsed.attributes[1].value) {
        // RFC 3501 section 6.3.8: "An empty ("" string) mailbox name argument is a special request to return the
        // hierarchy delimiter and the root name of the name given in the reference. The value returned as the root
        // MAY be the empty string if the reference is non-rooted or is an empty string."
        const server = connection.server;
        const reference: string = parsed.attributes[0].value || '';
        // the namespace of the reference, the personal one for a reference that is not a valid name
        let key = server.referenceNamespace;
        try {
            key = server.getNamespace(connection.importMailboxName(reference)) || key;
        } catch {
            // not a mailbox name, so not in another namespace
        }
        const namespace = key !== false ? server.storage[key] : undefined;
        // the root of a name in another namespace is the prefix of that namespace, like "#news." in the RFC example
        const root = key !== false && key !== server.referenceNamespace ? connection.exportMailboxName(key) : '';
        if (namespace) {
            connection.send(
                {
                    tag: '*',
                    command: 'LIST',
                    attributes: [
                        [
                            {
                                type: 'ATOM',
                                value: '\\Noselect'
                            }
                        ],
                        namespace.separator,
                        root
                    ]
                },
                'LIST ITEM',
                parsed,
                data
            );
        }
    } else {
        folders = connection.server.matchFolders(parsed.attributes[0].value, parsed.attributes[1].value, (path: string) => connection.exportMailboxName(path));

        folders.forEach((folder: Mailbox) => {
            connection.send(
                {
                    tag: '*',
                    command: 'LIST',
                    attributes: [
                        folder.flags.map((flag: string) => {
                            return {
                                type: 'ATOM',
                                value: flag
                            };
                        }),
                        connection.server.getSeparator(folder),
                        connection.exportMailboxName(folder.path)
                    ]
                },
                'LIST ITEM',
                parsed,
                data,
                folder
            );
        });
    }

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
        'LIST',
        parsed,
        data
    );

    return callback();
}
