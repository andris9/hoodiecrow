import { getDateKey } from '../commands/handlers/search.js';
import type { IMAPConnection, IMAPServer, Mailbox, Message } from '../types.js';

/**
 * @help Adds SAVEDATE [RFC8514] capability
 * @help Every message gets a save date when it is added to a mailbox (APPEND,
 * @help COPY, MOVE, and when the storage is loaded), messages in storage can
 * @help set it with a "SAVEDATE" value. A mailbox with "SAVEDATE": false in
 * @help storage does not support save dates, FETCH returns NIL for its messages
 *
 * SAVEDATE: https://www.rfc-editor.org/rfc/rfc8514.txt
 *
 * Additional FETCH items:
 * - SAVEDATE
 *
 * Additional SEARCH keys:
 * - SAVEDBEFORE, SAVEDON, SAVEDSINCE, SAVEDATESUPPORTED
 */
export default function savedatePlugin(server: IMAPServer) {
    server.registerCapability('SAVEDATE');

    // RFC 8514 section 3: storage may lack save dates for some mailboxes
    const isSupported = (mailbox: Mailbox | false | undefined) => !!mailbox && mailbox.SAVEDATE !== false;

    // RFC 8514 section 3: the save date is the current time when the message is saved in a mailbox, it is
    // never copied from the source message. Messages from storage may bring their own value.
    server.messageHandlers.push((server: IMAPServer, message: Message, mailbox: Mailbox) => {
        if (!isSupported(mailbox)) {
            delete message.SAVEDATE;
            return;
        }

        const savedate = server.normalizeDateTime(message.SAVEDATE || server.now());
        if (!server.validateInternalDate(savedate)) {
            throw new Error('Invalid SAVEDATE value ' + JSON.stringify(savedate) + ' in mailbox ' + mailbox.path);
        }
        message.SAVEDATE = savedate;
    });

    // RFC 8514 section 4.2: date-time, or NIL if the mailbox does not support save dates
    server.fetchHandlers.SAVEDATE = (connection: IMAPConnection, message: Message) => message.SAVEDATE || null;

    const dateKey = (name: string, compare: (saved: string, date: string) => boolean) => {
        const handler = (connection: IMAPConnection, message: Message, index: number, date: string) => {
            // RFC 8514 section 4.3: without save dates the internal date is used instead
            const saved = getDateKey(message.SAVEDATE || message.internaldate);
            return !!saved && compare(saved, date);
        };
        handler.argumentTypes = () => ['date'];
        server.searchHandlers[name] = handler;
    };

    dateKey('SAVEDBEFORE', (saved, date) => saved < date);
    dateKey('SAVEDON', (saved, date) => saved === date);
    dateKey('SAVEDSINCE', (saved, date) => saved >= date);

    server.searchHandlers.SAVEDATESUPPORTED = (connection: IMAPConnection) => isSupported(connection.selectedMailbox);
}
