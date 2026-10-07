import fetchHandlers from '../commands/handlers/fetch.js';
import type { IMAPConnection, IMAPServer, Mailbox, Message } from '../types.js';

/**
 * @help Adds STATUS=SIZE [RFC8438] capability. The SIZE status item
 * @help is the sum of the RFC822.SIZE values of the messages, it can
 * @help also be used with LIST-STATUS
 */

export default function statusSizePlugin(server: IMAPServer) {
    server.registerCapability('STATUS=SIZE');

    server.allowedStatus.push('SIZE');

    // RFC 8438 section 3: at least the sum of the RFC822.SIZE values of all messages in the mailbox
    server.statusHandlers.SIZE = (connection: IMAPConnection, mailbox: Mailbox) =>
        mailbox.messages.reduce((size: number, message: Message) => size + fetchHandlers['RFC822.SIZE'](connection, message), 0);
}
