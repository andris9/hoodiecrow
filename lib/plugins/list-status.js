'use strict';

const { getListExtensions } = require('../list-extensions');
const { parseStatusItems, sendStatus } = require('../commands/handlers/status');
const listExtended = require('./list-extended');

/**
 * @help Adds LIST-STATUS [RFC5819] capability, the STATUS return option
 * @help of LIST. Loads LIST-EXTENDED as well
 */

module.exports = function (server) {
    // the STATUS return option needs the extended LIST syntax (RFC 5819 section 4)
    listExtended(server);

    server.registerCapability('LIST-STATUS');

    // status-option = "STATUS" SP "(" status-att *(SP status-att) ")"
    getListExtensions(server).returnOptions.STATUS = {
        parse: list => parseStatusItems(server, list),

        // RFC 5819 section 2: a STATUS response follows the LIST response of every selectable mailbox
        // that matches the selection criteria. Mailboxes listed only for CHILDINFO or as \NonExistent
        // get none. The selected mailbox is no exception (RFC 9051 section 6.3.11)
        onItem: (connection, folder, items, info, parsed, data) => {
            if (info.matched && info.exists) {
                sendStatus(connection, folder.path, folder, items, parsed, data);
            }
        }
    };
};
