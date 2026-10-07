import { getPendingTarget } from '../commands/append.js';
import type { AppendCheckOptions, AppendMessage, IMAPConnection, IMAPServer, Mailbox } from '../types.js';

/**
 * @help Adds APPENDLIMIT [RFC7889] capability
 * @help Server option "appendLimit" sets the limit in octets for all
 * @help mailboxes, a mailbox in storage can set its own "appendLimit"
 * @help (null for no limit)
 *
 * APPENDLIMIT: https://www.rfc-editor.org/rfc/rfc7889
 *
 * The server option "appendLimit" (octets) sets a limit for all mailboxes, advertised as
 * APPENDLIMIT=<n>. A mailbox in the storage can set its own "appendLimit" (a number, or null
 * for no limit), then the capability is a plain APPENDLIMIT and clients read the limits with
 * STATUS (APPENDLIMIT). A larger APPEND or REPLACE fails with NO [TOOBIG], a synchronizing
 * literal is refused before it is sent.
 */
export default function appendlimitPlugin(server: IMAPServer) {
    const serverLimit = 'appendLimit' in server.options ? server.options.appendLimit : null;
    if (serverLimit !== null && !isValidLimit(serverLimit)) {
        throw new TypeError('Invalid appendLimit option, expecting a non-negative integer');
    }

    const hasOwnLimit = (mailbox: Mailbox) => Object.hasOwn(mailbox, 'appendLimit');
    const hasMailboxLimits = () => Object.values(server.folderCache).some(hasOwnLimit);

    /**
     * @param {Object} mailbox Mailbox object
     * @return {Number|null} limit in octets, null if there is no limit
     */
    const getLimit = (mailbox: Mailbox) => {
        if (!hasOwnLimit(mailbox)) {
            return serverLimit;
        }
        return isValidLimit(mailbox.appendLimit) ? mailbox.appendLimit : null;
    };

    // RFC 7889 section 5: an APPENDLIMIT of 0 means that nothing can be appended
    const isTooBig = (mailbox: Mailbox, size: number) => {
        const limit = getLimit(mailbox);
        return limit !== null && (size > limit || limit === 0);
    };

    // RFC 7889 section 2: APPENDLIMIT=<n> for the same limit in every mailbox, otherwise a plain
    // APPENDLIMIT and the limits come from STATUS
    if (serverLimit !== null) {
        server.registerCapability('APPENDLIMIT=' + serverLimit, () => !hasMailboxLimits());
    }
    server.registerCapability('APPENDLIMIT', () => serverLimit === null || hasMailboxLimits());

    // RFC 7889 section 4: a message over the limit is refused with TOOBIG
    server.appendChecks.push((connection: IMAPConnection, mailbox: Mailbox, messages: AppendMessage[], options: AppendCheckOptions) => {
        // COPY and MOVE are not uploads (RFC 7889 section 1)
        if (!options.command) {
            return false;
        }
        if (messages.some(message => isTooBig(mailbox, message.raw.length))) {
            return { code: 'TOOBIG', text: 'Message exceeds the APPENDLIMIT of the mailbox' };
        }
        return false;
    });

    // Refuse the literal of a message that is too large before the client sends it, by not
    // sending a continuation request (RFC 3502 section 6.3.11 example A005)
    server.literalFilters.push((connection: IMAPConnection, command: string, line: string, literalSize: number) => {
        const path = getPendingTarget(connection, command, line);
        const mailbox = path !== false && server.getMailbox(path);
        if (mailbox && isTooBig(mailbox, literalSize)) {
            return { command: 'NO', code: 'TOOBIG', text: 'Message exceeds the APPENDLIMIT of the mailbox' };
        }
        return false;
    });

    // RFC 7889 section 3.1: status-att-val =/ "APPENDLIMIT" SP (number / nil)
    server.allowedStatus.push('APPENDLIMIT');
    // also used by the STATUS return option of LIST-STATUS (RFC 7889 section 3.2)
    server.statusHandlers.APPENDLIMIT = (connection: IMAPConnection, mailbox: Mailbox) => getLimit(mailbox);
}

function isValidLimit(value: any) {
    return Number.isSafeInteger(value) && value >= 0;
}
