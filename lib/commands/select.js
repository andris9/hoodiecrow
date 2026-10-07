'use strict';

module.exports = function (connection, parsed, data, callback) {
    return selectMailbox(connection, parsed, data, callback, false);
};

/**
 * Shared implementation of SELECT and EXAMINE
 *
 * @param {Boolean} readOnly If true, the mailbox is opened read-only (EXAMINE)
 */
function selectMailbox(connection, parsed, data, callback, readOnly) {
    const command = readOnly ? 'EXAMINE' : 'SELECT';

    if (!parsed.attributes || parsed.attributes.length !== 1 || !parsed.attributes[0] || ['STRING', 'LITERAL', 'ATOM'].indexOf(parsed.attributes[0].type) < 0) {
        connection.send(
            {
                tag: parsed.tag,
                command: 'BAD',
                attributes: [
                    {
                        type: 'TEXT',
                        value: command + ' expects 1 mailbox argument'
                    }
                ]
            },
            'INVALID COMMAND',
            parsed,
            data
        );
        return callback();
    }

    const path = parsed.attributes[0].value;

    // ENABLE is not allowed once a mailbox has been selected (RFC 5161 section 3.1)
    connection.everSelected = true;

    if (!connection.checkMailboxName(path, parsed, data)) {
        return callback();
    }
    const mailbox = connection.server.getMailbox(path);

    if (!mailbox || mailbox.flags.indexOf('\\Noselect') >= 0) {
        // a failed SELECT leaves no mailbox selected (RFC 3501 section 6.3.1)
        connection.state = 'Authenticated';
        connection.selectedMailbox = false;
        connection.readOnly = false;
        connection.notificationQueue = [];

        connection.sendStatus(parsed, data, 'NO', 'Mailbox does not exist', 'NONEXISTENT', command + ' FAILED');
        return callback();
    }

    connection.state = 'Selected';
    connection.selectedMailbox = mailbox;
    connection.readOnly = readOnly;

    connection.notificationQueue = [];

    // \Recent is a session flag: a read-write session takes over the messages
    // that no other session has seen yet (RFC 3501 section 2.3.2)
    connection.recent = new Set();
    mailbox.messages.forEach(message => {
        if (message.recent) {
            connection.recent.add(message);
            if (!readOnly) {
                delete message.recent;
            }
        }
    });

    const status = connection.server.getStatus(mailbox);
    const permanentFlags = status.permanentFlags.map(flag => {
        return {
            type: 'ATOM',
            value: flag
        };
    });

    connection.send(
        {
            tag: '*',
            command: 'FLAGS',
            attributes: [permanentFlags]
        },
        command + ' FLAGS',
        parsed,
        data
    );

    if (mailbox.allowPermanentFlags) {
        permanentFlags.push({
            type: 'TEXT',
            value: '\\*'
        });
    }

    connection.send(
        {
            tag: '*',
            command: 'OK',
            attributes: [
                {
                    type: 'SECTION',
                    section: [
                        {
                            type: 'ATOM',
                            value: 'PERMANENTFLAGS'
                        },
                        // nothing can be changed in a read-only mailbox
                        readOnly ? [] : permanentFlags
                    ]
                }
            ]
        },
        command + ' PERMANENTFLAGS',
        parsed,
        data
    );

    connection.send(
        {
            tag: '*',
            attributes: [
                mailbox.messages.length,
                {
                    type: 'ATOM',
                    value: 'EXISTS'
                }
            ]
        },
        command + ' EXISTS',
        parsed,
        data
    );

    connection.send(
        {
            tag: '*',
            attributes: [
                connection.recent.size,
                {
                    type: 'ATOM',
                    value: 'RECENT'
                }
            ]
        },
        command + ' RECENT',
        parsed,
        data
    );

    const firstUnseen = mailbox.messages.findIndex(message => message.flags.indexOf('\\Seen') < 0);
    if (firstUnseen >= 0) {
        connection.send(
            {
                tag: '*',
                command: 'OK',
                attributes: [
                    {
                        type: 'SECTION',
                        section: [
                            {
                                type: 'ATOM',
                                value: 'UNSEEN'
                            },
                            firstUnseen + 1
                        ]
                    }
                ]
            },
            command + ' UNSEEN',
            parsed,
            data
        );
    }

    connection.send(
        {
            tag: '*',
            command: 'OK',
            attributes: [
                {
                    type: 'SECTION',
                    section: [
                        {
                            type: 'ATOM',
                            value: 'UIDVALIDITY'
                        },
                        mailbox.uidvalidity
                    ]
                }
            ]
        },
        command + ' UIDVALIDITY',
        parsed,
        data
    );

    connection.send(
        {
            tag: '*',
            command: 'OK',
            attributes: [
                {
                    type: 'SECTION',
                    section: [
                        {
                            type: 'ATOM',
                            value: 'UIDNEXT'
                        },
                        mailbox.uidnext
                    ]
                }
            ]
        },
        command + ' UIDNEXT',
        parsed,
        data
    );

    connection.send(
        {
            tag: parsed.tag,
            command: 'OK',
            attributes: [
                {
                    type: 'SECTION',
                    section: [
                        {
                            type: 'ATOM',
                            value: readOnly ? 'READ-ONLY' : 'READ-WRITE'
                        }
                    ]
                },
                {
                    type: 'TEXT',
                    value: 'Completed'
                }
            ]
        },
        command,
        parsed,
        data
    );
    return callback();
}

module.exports.selectMailbox = selectMailbox;
