import type { Attribute, Callback, CommandHandler, IMAPConnection, IMAPResponse, IMAPServer, Mailbox, ParsedCommand } from '../types.js';

/**
 * @help Enables CREATE-SPECIAL-USE [RFC6154] capability
 * @help Allowed special flags can be set with server
 * @help option "special-use"
 */

// use-attr-ext = "\" atom (RFC 6154 section 6), ATOM-CHAR is any CHAR except atom-specials (RFC 3501 section 9)
// eslint-disable-next-line no-control-regex
const USE_ATTR = /^\\[^\x00-\x20\x7f-\xff(){%*"\\\]]+$/;

export default function createSpecialUsePlugin(server: IMAPServer) {
    // Register capability
    server.registerCapability('CREATE-SPECIAL-USE');

    const createHandler = server.getCommandHandler('CREATE') as CommandHandler;
    const allowedList = ([] as string[]).concat(server.options['special-use'] || ['\\Archive', '\\Drafts', '\\Flagged', '\\Junk', '\\Sent', '\\Trash']);

    server.setCommandHandler('CREATE', (connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
        let i: number;
        let len: number;
        let specialUseList: Attribute[] | undefined;
        const mailboxSpecialUse: string[] = [];
        if (parsed.attributes && Array.isArray(parsed.attributes[1])) {
            for (i = 0; i < parsed.attributes[1].length; i += 2) {
                if (
                    parsed.attributes[1][i] &&
                    parsed.attributes[1][i].type === 'ATOM' &&
                    parsed.attributes[1][i].value.toUpperCase() === 'USE' &&
                    Array.isArray(parsed.attributes[1][i + 1])
                ) {
                    specialUseList = parsed.attributes[1][i + 1];
                    parsed.attributes[1].splice(i, 2);
                    i -= 2;
                }
            }

            // Remove extra arguments if no members were left
            if (!parsed.attributes[1].length) {
                parsed.attributes.splice(1, 1);
            }
        }

        if (specialUseList) {
            for (i = 0, len = specialUseList.length; i < len; i++) {
                // RFC 6154 section 6: use-attr-ext = "\" atom, so every entry is an atom that starts with a backslash,
                // not NIL, a string, a literal, a number or a list
                const entry = specialUseList[i];
                if (!entry || Array.isArray(entry) || entry.type !== 'ATOM' || typeof entry.value !== 'string' || !USE_ATTR.test(entry.value)) {
                    connection.send(
                        {
                            tag: parsed.tag,
                            command: 'BAD',
                            attributes: [
                                {
                                    type: 'TEXT',
                                    value: 'Invalid syntax for special use flag #' + (i + 1)
                                }
                            ]
                        },
                        'CREATE-SPECIAL-USE FAILED',
                        parsed,
                        data
                    );
                    return callback();
                }
                // attribute names are case-insensitive, store the canonical form
                const specialUse = allowedList.find(value => value.toLowerCase() === String(specialUseList![i].value).toLowerCase());
                if (!specialUse) {
                    connection.send(
                        {
                            tag: parsed.tag,
                            command: 'NO',
                            attributes: [
                                {
                                    type: 'SECTION',
                                    section: [
                                        {
                                            type: 'ATOM',
                                            value: 'USEATTR'
                                        }
                                    ]
                                },
                                {
                                    type: 'TEXT',
                                    value: specialUseList[i].value + ' not supported'
                                }
                            ]
                        },
                        'CREATE-SPECIAL-USE FAILED',
                        parsed,
                        data
                    );
                    return callback();
                }
                if (mailboxSpecialUse.indexOf(specialUse) < 0) {
                    mailboxSpecialUse.push(specialUse);
                }
            }
        }

        if (mailboxSpecialUse.length) {
            parsed.mailboxSpecialUse = mailboxSpecialUse;
        }

        createHandler(connection, parsed, data, callback);
    });

    server.outputHandlers.push(
        (connection: IMAPConnection, response: IMAPResponse, description: string, parsed: ParsedCommand, data: string, folder: Mailbox) => {
            if (description === 'CREATE' && folder && parsed.mailboxSpecialUse) {
                folder['special-use'] = parsed.mailboxSpecialUse;
            }
        }
    );
}
