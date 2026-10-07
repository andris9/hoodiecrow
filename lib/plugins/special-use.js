'use strict';

/**
 * @help Enables SPECIAL-USE [RFC6154] capability
 * @help Mailboxes need to have a "special-use"
 * @help property (String or Array) that will be used
 * @help as extra flag for LIST and LSUB responses
 */

module.exports = function (server) {
    // Register capability
    server.registerCapability('SPECIAL-USE');

    const listHandler = server.getCommandHandler('LIST');

    server.setCommandHandler('LIST', (connection, parsed, data, callback) => {
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

    server.outputHandlers.push((connection, response, description, parsed, data, folder) => {
        const specialUseList = [].concat((folder && folder['special-use']) || []).map(specialUse => {
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
    });
};
