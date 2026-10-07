import type { AppendCheckOptions, AppendMessage, IMAPConnection, IMAPServer, Mailbox } from '../types.js';

/**
 * @help Adds MULTIAPPEND [RFC3502] capability
 * @help With UIDPLUS, APPENDUID lists the UIDs of all messages
 *
 * MULTIAPPEND: https://www.rfc-editor.org/rfc/rfc3502
 *
 * APPEND takes several messages, which are appended all or nothing. A zero-length
 * message literal cancels the whole APPEND with NO. With UIDPLUS, APPENDUID lists the
 * UIDs of all appended messages as a UID set.
 */
export default function multiappendPlugin(server: IMAPServer) {
    server.registerCapability('MULTIAPPEND');
    server.multiAppend = true;

    // RFC 3502 section 6.3.11: "A zero-length message literal argument is an error, and MUST return a NO.
    // This can be used to cancel the append." Nothing is stored when any message fails
    server.appendChecks.push((connection: IMAPConnection, mailbox: Mailbox, messages: AppendMessage[], options: AppendCheckOptions) => {
        // only APPEND like commands, not COPY or MOVE
        if (options.command && messages.some(message => !message.resolve && !message.raw.length)) {
            return { text: 'Zero-length message literal, APPEND cancelled' };
        }
        return false;
    });
}
