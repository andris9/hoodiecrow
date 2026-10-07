import { getListExtensions } from '../list-extensions.js';
import { parseStatusItems, sendStatus } from '../commands/handlers/status.js';
import listExtended from './list-extended.js';
import type { IMAPConnection, IMAPServer, Mailbox, ParsedCommand } from '../types.js';

/**
 * @help Adds LIST-STATUS [RFC5819] capability, the STATUS return option
 * @help of LIST. Loads LIST-EXTENDED as well
 */

export default function listStatusPlugin(server: IMAPServer) {
    // the STATUS return option needs the extended LIST syntax (RFC 5819 section 4)
    listExtended(server);

    server.registerCapability('LIST-STATUS');

    // status-option = "STATUS" SP "(" status-att *(SP status-att) ")"
    getListExtensions(server).returnOptions.STATUS = {
        parse: (list: any[], connection: IMAPConnection) => parseStatusItems(server, list, connection),

        // RFC 5819 section 2: a STATUS response follows the LIST response of every selectable mailbox
        // that matches the selection criteria. Mailboxes listed only for CHILDINFO or as \NonExistent
        // get none. The selected mailbox is no exception (RFC 9051 section 6.3.11)
        onItem: (connection: IMAPConnection, folder: Mailbox, items: any[], info, parsed: ParsedCommand, data: string) => {
            if (info.matched && info.exists) {
                sendStatus(connection, folder.path, folder, items, parsed, data);
            }
        }
    };
}
