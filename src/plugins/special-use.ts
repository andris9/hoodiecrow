import { getListExtensions } from '../list-extensions.js';
import type { Callback, CommandHandler, IMAPConnection, IMAPResponse, IMAPServer, Mailbox, ParsedCommand } from '../types.js';

/**
 * @help Enables SPECIAL-USE [RFC6154] capability
 * @help Mailboxes need to have a "special-use"
 * @help property (String or Array) that will be used
 * @help as extra flag for LIST and LSUB responses.
 * @help With LIST-EXTENDED the SPECIAL-USE selection and
 * @help return options work with the other LIST options
 */

export default function specialUsePlugin(server: IMAPServer) {
    // Register capability
    server.registerCapability('SPECIAL-USE');

    const getSpecialUse = (folder: Mailbox) => [].concat((folder && folder['special-use']) || []);

    // RFC 6154 section 2: with LIST-EXTENDED, SPECIAL-USE is a list-select-independent-opt that
    // implies the SPECIAL-USE return option. The LIST-EXTENDED plugin may be loaded before or after this one
    const listExtensions = getListExtensions(server);
    listExtensions.selectionOptions['SPECIAL-USE'] = {
        type: 'independent',
        returnOption: 'SPECIAL-USE',
        match: (folder: Mailbox) => folder.flags.indexOf('\\Noselect') < 0 && getSpecialUse(folder).length > 0
    };
    // special-use attributes are always included, so the return option needs no extra handling
    listExtensions.returnOptions['SPECIAL-USE'] = {};

    const listHandler = server.getCommandHandler('LIST') as CommandHandler;

    server.setCommandHandler('LIST', (connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
        if (listExtensions.enabled) {
            // LIST-EXTENDED handles the options
            return listHandler(connection, parsed, data, callback);
        }

        // without LIST-EXTENDED only the SPECIAL-USE options are understood
        let i;
        if (parsed.attributes && Array.isArray(parsed.attributes[0])) {
            for (i = parsed.attributes[0].length - 1; i >= 0; i--) {
                if (parsed.attributes[0][i] && parsed.attributes[0][i].type === 'ATOM' && parsed.attributes[0][i].value.toUpperCase() === 'SPECIAL-USE') {
                    parsed.attributes[0].splice(i, 1);
                    parsed.listSpecialUseOnly = true;
                }
            }
            // remove parameter if no other memebers were left
            if (!parsed.attributes[0].length) {
                parsed.attributes.splice(0, 1);
            }
        }

        if (
            parsed.attributes &&
            parsed.attributes[2] &&
            parsed.attributes[2].type === 'ATOM' &&
            parsed.attributes[2].value.toUpperCase() === 'RETURN' &&
            Array.isArray(parsed.attributes[3])
        ) {
            for (i = parsed.attributes[3].length - 1; i >= 0; i--) {
                if (parsed.attributes[3][i] && parsed.attributes[3][i].type === 'ATOM' && parsed.attributes[3][i].value.toUpperCase() === 'SPECIAL-USE') {
                    // special-use attributes are always included, so the return option needs no extra handling
                    parsed.attributes[3].splice(i, 1);
                }
            }

            // Remove RETURN (List) if no members were left
            if (!parsed.attributes[3].length) {
                parsed.attributes.splice(2, 2);
            }
        }

        listHandler(connection, parsed, data, callback);
    });

    server.outputHandlers.push(
        (connection: IMAPConnection, response: IMAPResponse, description: string, parsed: ParsedCommand, data: string, folder: Mailbox) => {
            const specialUseList = getSpecialUse(folder).map(specialUse => {
                return {
                    type: 'ATOM',
                    value: specialUse
                };
            });

            if ((description === 'LIST ITEM' || description === 'LSUB ITEM') && folder && response.attributes && Array.isArray(response.attributes[0])) {
                if (specialUseList.length) {
                    // special-use attributes are added to the other mailbox attributes, also with RETURN (SPECIAL-USE)
                    response.attributes[0] = response.attributes[0].concat(specialUseList);
                } else if (parsed.listSpecialUseOnly) {
                    // Do not show this response
                    response.skipResponse = true;
                }
            }
        }
    );
}
