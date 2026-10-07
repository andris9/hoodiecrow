import type { Callback, IMAPConnection, Mailbox, ParsedCommand, SubscriptionStandIn } from '../types.js';

export default function lsubCommand(connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) {
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

    const server = connection.server;
    const match = parsed.attributes[1].value;
    const folders = server.matchFolders(parsed.attributes[0].value, match, (path: string) => connection.exportMailboxName(path), server.getSubscriptionTree());

    folders.forEach((folder: Mailbox | SubscriptionStandIn) => {
        let flags;
        if (folder.subscribed) {
            // the subscription list holds names, a subscribed name is listed even if the mailbox does not exist.
            // \Noselect has a special meaning in LSUB (RFC 5258 section 3.1), so it is not listed for these
            flags = folder.flags.filter((flag: string) => flag !== '\\Noselect');
        } else if (match.substr(-1) === '%') {
            // RFC 3501 section 6.3.9: with "%" a level that is not subscribed but has subscribed names
            // below it is listed with \Noselect
            flags = ['\\Noselect'];
        } else {
            return;
        }

        connection.send(
            {
                tag: '*',
                command: 'LSUB',
                attributes: [
                    flags.map((flag: string) => {
                        return {
                            type: 'ATOM',
                            value: flag
                        };
                    }),
                    server.getSeparator(folder),
                    connection.exportMailboxName(folder.path)
                ]
            },
            'LSUB ITEM',
            parsed,
            data,
            folder
        );
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
}
