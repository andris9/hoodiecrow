/**
 * Changes of the message store that IMAP commands and the control API share: expunge, flag changes, and the
 * mailbox operations of DELETE, RENAME, SUBSCRIBE and UNSUBSCRIBE. Each one tells the sessions about the change
 * the way another session's command would (EXISTS, EXPUNGE, unsolicited FETCH, BYE, `mailbox` events). The
 * session that caused a change is `server.activeConnection` (null for the control API), the commands keep only
 * what is specific to a session: argument checks, the selected mailbox, read-only state and the responses.
 */

import { normalizeSystemFlag, checkSystemFlags } from './commands/handlers/flags.js';
import { seededRandom } from './random.js';
import { MAX_NUMBER } from './numbers.js';
import type { IMAPConnection, IMAPServer, Mailbox, Message } from './types.js';

/** the XOAUTH2 session timeout of the default user, and of a user the control API adds without one */
const DEFAULT_SESSION_TIMEOUT = 3600 * 1000;

/** An error of a failed store operation or control API call, `code` is a RFC 5530 response code or INVALID */
class ImapKitError extends Error {
    code: string;

    constructor(message: string, code: string) {
        super(message);
        this.name = 'ImapKitError';
        this.code = code;
    }
}

/**
 * Creates an error for a failed operation, with a RFC 5530 response code
 *
 * @param {String} message Error message
 * @param {String} code Response code, e.g. "NONEXISTENT"
 * @return {Error} Error object
 */
function storeError(message: string, code: string): ImapKitError {
    return new ImapKitError(message, code);
}

interface ExpungeOptions {
    /** the session that caused the expunge, for the `expunge` event (QRESYNC, NOTIFY), defaults to the active session */
    origin?: IMAPConnection | null | undefined;
    /** a session that gets no EXPUNGE and no EXISTS responses (CLOSE) */
    skip?: IMAPConnection | false | null | undefined;
    /** a session that gets the EXPUNGE responses but no EXISTS response (EXPUNGE, MOVE) */
    skipExists?: IMAPConnection | false | null | undefined;
    /** the EXPUNGE responses go from the highest UID to the lowest (MESSAGELIMIT, RFC 9738 section 3.1) */
    highestFirst?: boolean | undefined;
}

/**
 * Removes messages from a mailbox and tells the sessions that have it selected with EXPUNGE responses
 * (VANISHED with QRESYNC) and a new EXISTS. The `expunge` event goes out before the notifications
 *
 * @param {Object} server IMAP server
 * @param {Object} mailbox Mailbox of the messages
 * @param {Array|Function} messagesOrFilterFunc Messages to remove, or a function that returns true for them
 * @param {Object} [options] `{ origin, skip, skipExists, highestFirst }`
 * @return {Array} the removed messages
 */
function expungeMessages(
    server: IMAPServer,
    mailbox: Mailbox,
    messagesOrFilterFunc: Message[] | ((message: Message) => unknown),
    options: ExpungeOptions = {}
): Message[] {
    let filterFunc: (message: Message) => unknown;
    if (Array.isArray(messagesOrFilterFunc)) {
        const messageSet = new Set(messagesOrFilterFunc);
        filterFunc = (message: Message) => messageSet.has(message);
    } else {
        filterFunc = messagesOrFilterFunc;
    }

    // sequence numbers of the removed messages, each one as it is after the earlier EXPUNGE responses. From the
    // highest message down, the earlier responses do not change the sequence numbers of the later ones
    const expunged: { seq: number; message: Message }[] = [];
    const kept: Message[] = [];
    mailbox.messages.forEach((message, i) => {
        if (filterFunc(message)) {
            message.ghost = true;
            expunged.push({ seq: options.highestFirst ? i + 1 : kept.length + 1, message });
        } else {
            kept.push(message);
        }
    });

    if (!expunged.length) {
        return [];
    }

    // old copy is required for those sessions that run FETCH before
    // displaying the EXPUNGE notice
    const mailboxCopy = mailbox.messages.slice();

    // update the list in place, other code might hold a reference to it
    kept.forEach((message, i) => {
        mailbox.messages[i] = message;
    });
    mailbox.messages.length = kept.length;

    const messages = expunged.map(entry => entry.message);
    const origin = options.origin !== undefined ? options.origin : server.activeConnection;

    // lets plugins track the removal (e.g. mod-sequences of CONDSTORE and QRESYNC) before any notification
    server.emit('expunge', mailbox, messages, origin);

    (options.highestFirst ? expunged.slice().reverse() : expunged).forEach(entry => {
        server.notify(
            {
                tag: '*',
                attributes: [
                    entry.seq,
                    {
                        type: 'ATOM',
                        value: 'EXPUNGE'
                    }
                ],
                // the removed message, for plugins that report it differently (e.g. VANISHED of QRESYNC)
                message: entry.message
            },
            mailbox,
            options.skip
        );
    });

    server.notify(
        {
            tag: '*',
            attributes: [
                mailbox.messages.length,
                {
                    type: 'ATOM',
                    value: 'EXISTS'
                }
            ],
            // distribute the old mailbox data with the notification
            mailboxCopy: mailboxCopy
        },
        mailbox,
        options.skip || options.skipExists
    );

    return messages;
}

/**
 * Tells the sessions that have a mailbox selected about changed flags, they get an untagged FETCH with the
 * new flags (RFC 3501 section 5.2)
 *
 * @param {Object} server IMAP server
 * @param {Object} mailbox Mailbox of the messages
 * @param {Array} messages Messages with changed flags
 * @param {Object} [ignoreConnection] A session that is not told, e.g. the one whose STORE changed the flags
 */
function notifyFlagChanges(server: IMAPServer, mailbox: Mailbox, messages: Message[], ignoreConnection?: IMAPConnection | null): void {
    if (messages.length) {
        server.notify({ tag: '*', flagUpdate: messages }, mailbox, ignoreConnection);
    }
}

type FlagMode = 'set' | 'add' | 'remove';

/**
 * Checks flags the way STORE does: system flags the server knows (never \Recent), valid keywords, and only
 * permanent flags in a mailbox that does not allow new keywords
 *
 * @param {Object} server IMAP server
 * @param {Object} mailbox Mailbox the flags are for
 * @param {Array} flags Flags to check
 * @param {Boolean} stored true if the flags are stored, so they must be permanent flags of the mailbox
 * @return {Array} the normalized flags without duplicates
 * @throws {Error} INVALID for a flag that can not be used
 */
function checkFlags(server: IMAPServer, mailbox: Mailbox, flags: unknown, stored: boolean): string[] {
    if (!Array.isArray(flags)) {
        throw storeError('Flags must be an array', 'INVALID');
    }
    const list: string[] = [];
    flags.forEach((value: unknown) => {
        if (typeof value !== 'string') {
            throw storeError('Flags must be strings', 'INVALID');
        }
        const flag = normalizeSystemFlag(value);
        try {
            checkSystemFlags(server, flag);
        } catch (err) {
            throw storeError((err as Error).message, 'INVALID');
        }
        if (stored && mailbox.permanentFlags.indexOf(flag) < 0 && !mailbox.allowPermanentFlags) {
            throw storeError('Flag ' + flag + ' is not a permanent flag of ' + mailbox.path, 'INVALID');
        }
        if (list.indexOf(flag) < 0) {
            list.push(flag);
        }
    });

    return list;
}

/**
 * Changes the flags of messages outside of a STORE command. The flags follow the rules of STORE: system flags
 * the server knows (never \Recent), valid keywords, and only permanent flags in a mailbox that does not allow
 * new keywords. Plugins learn about the changed messages from the `flags` event `(mailbox, messages, origin)`
 * before the sessions are told (CONDSTORE gives them new mod-sequences there)
 *
 * @param {Object} server IMAP server
 * @param {Object} mailbox Mailbox of the messages
 * @param {Array} messages Messages to change
 * @param {Array} flags Flags to set, add or remove
 * @param {String} mode "set", "add" or "remove"
 * @return {Array} the messages whose flags changed
 */
function changeFlags(server: IMAPServer, mailbox: Mailbox, messages: Message[], flags: string[], mode: FlagMode): Message[] {
    if (['set', 'add', 'remove'].indexOf(mode) < 0) {
        throw storeError('Invalid flag mode ' + JSON.stringify(mode) + ', expected set, add or remove', 'INVALID');
    }
    const list = checkFlags(server, mailbox, flags, mode !== 'remove');

    const changed: Message[] = [];
    messages.forEach(message => {
        const before = message.flags.join(' ');
        if (mode === 'set') {
            message.flags = list.slice();
        } else if (mode === 'add') {
            list.forEach(flag => server.ensureFlag(message.flags, flag));
        } else {
            list.forEach(flag => server.removeFlag(message.flags, flag));
        }
        server.rememberFlags(mailbox, message.flags);
        if (message.flags.join(' ') !== before) {
            changed.push(message);
        }
    });

    if (changed.length) {
        server.emit('flags', mailbox, changed, server.activeConnection);
        notifyFlagChanges(server, mailbox, changed, null);
    }
    return changed;
}

/**
 * Creates a mailbox (CREATE), with any missing superior hierarchy levels
 *
 * @param {Object} server IMAP server
 * @param {String} path Storage name of the mailbox
 * @return {Object} the created mailbox
 * @throws {Error} with a RFC 5530 `code` (ALREADYEXISTS, CANNOT ...)
 */
function createMailbox(server: IMAPServer, path: string): Mailbox {
    const existing = new Set(Object.keys(server.folderCache));
    const mailbox = server.createMailbox(path);
    // the superior levels that did not exist are new mailboxes as well, plugins set them up like the target (ACL)
    const created = Object.keys(server.folderCache)
        .filter(name => !existing.has(name))
        .sort((a, b) => a.length - b.length);
    server.mailboxChanged('create', mailbox.path, { created });
    return mailbox;
}

/**
 * Deletes a mailbox (DELETE). Other sessions that have it selected are disconnected with an untagged BYE
 * (RFC 2180 section 3.3, RFC 2683 section 3.1.2), as they can not be told about the deletion in any other way
 *
 * @param {Object} server IMAP server
 * @param {String} path Storage name of the mailbox
 * @throws {Error} with a response `code` (NONEXISTENT, CANNOT, HASCHILDREN ...)
 */
function deleteMailbox(server: IMAPServer, path: string): void {
    const mailbox = server.getMailbox(path);
    if (!mailbox) {
        throw storeError('Mailbox does not exist', 'NONEXISTENT');
    }

    server.deleteMailbox(path);
    server.mailboxChanged('delete', mailbox.path, { mailbox });
    byeSelected(server, mailbox, 'Selected mailbox was deleted', 'MAILBOX DELETED');
}

/**
 * Disconnects the sessions that have a mailbox selected with an untagged BYE, except the one that made the change
 *
 * @param {Object} server IMAP server
 * @param {Object} mailbox Mailbox
 * @param {String} text Text of the BYE
 * @param {String} description Description for output handlers
 */
function byeSelected(server: IMAPServer, mailbox: Mailbox, text: string, description: string): void {
    const origin = server.activeConnection;
    server.connections.forEach(connection => {
        if (connection !== origin && connection.selectedMailbox === mailbox) {
            connection.bye(text, description);
        }
    });
}

/**
 * Renames a mailbox (RENAME). Renaming INBOX moves its messages to the new mailbox and leaves INBOX
 * empty (RFC 3501 section 6.3.5). Everything that can be checked is checked up front, so that a failed
 * rename never loses the source
 *
 * @param {Object} server IMAP server
 * @param {String} source Storage name of the mailbox
 * @param {String} destination New storage name
 * @return {Object} `{ path, mailbox }`: the new name, and the source mailbox object, which is INBOX itself for
 *   a rename of INBOX
 * @throws {Error} with a RFC 5530 `code` (NONEXISTENT, ALREADYEXISTS, CANNOT ...)
 */
function renameMailbox(server: IMAPServer, source: string, destination: string): { path: string; mailbox: Mailbox } {
    const mailbox = server.getMailbox(source);
    const target = server.getMailbox(destination);

    if (!mailbox || mailbox.flags.indexOf('\\Noselect') >= 0) {
        throw storeError('Mailbox does not exist', 'NONEXISTENT');
    }

    if (target && target.flags.indexOf('\\Noselect') < 0) {
        throw storeError('Mailbox already exists', 'ALREADYEXISTS');
    }

    const separator = server.getSeparator(mailbox);
    if (destination.substr(0, mailbox.path.length + separator.length) === mailbox.path + separator) {
        throw storeError('Can not move a mailbox into itself', 'CANNOT');
    }

    const oldPath = mailbox.path;
    let path: string;
    if (source.toUpperCase() === 'INBOX') {
        const renamed = server.createMailbox(destination);
        path = renamed.path;
        mailbox.messages.forEach((message: Message) => {
            server.copyMessage(renamed, message);
        });
        expungeMessages(server, mailbox, () => true);
    } else {
        server.deleteMailbox(source, true);
        try {
            server.createMailbox(destination, mailbox);
        } catch (E) {
            // put the source mailbox back where it was
            server.createMailbox(source, mailbox);
            server.indexFolders();
            throw E;
        }
        server.indexFolders();
        path = mailbox.path;
    }
    server.mailboxChanged('rename', path, { oldPath });
    return { path, mailbox };
}

type UidMode = 'keep' | 'renumber' | 'shuffle' | 'offset';

interface UidValidityOptions {
    /** the new UIDVALIDITY, it must be greater than the current one. Default: one above every value in use */
    uidvalidity?: number | undefined;
    /** what happens to the UIDs: "keep" (default), "renumber" (1 to n in the current order), "shuffle" (1 to n in a
     * random order) or "offset" (every UID moves above the old UIDNEXT, plus `offset`) */
    uids?: UidMode | undefined;
    /** extra gap for "offset" */
    offset?: number | undefined;
    /** seed of the "shuffle" order, for repeatable tests */
    seed?: number | undefined;
}

/**
 * Gives a mailbox a new UIDVALIDITY, optionally with new UIDs. A UID never changes during a session (RFC 9051
 * section 2.3.1.1), so the sessions that have the mailbox selected are disconnected with BYE, and the new value
 * is greater than every earlier one, as UIDs that do not persist require. A client that keeps its cached UIDs
 * without checking UIDVALIDITY gets other messages ("shuffle") or none ("offset") for them
 *
 * @param {Object} server IMAP server
 * @param {Object} mailbox Mailbox, not \Noselect
 * @param {Object} [options] `{ uidvalidity, uids, offset, seed }`
 * @return {Object} `{ uidvalidity, uidnext, uids }`, `uids` maps every old UID to its new one
 * @throws {Error} INVALID for a UIDVALIDITY that is not greater, or invalid options
 */
function resetUidValidity(
    server: IMAPServer,
    mailbox: Mailbox,
    options: UidValidityOptions = {}
): { uidvalidity: number; uidnext: number; uids: { uid: number; newUid: number }[] } {
    const mode = options.uids || 'keep';
    if (['keep', 'renumber', 'shuffle', 'offset'].indexOf(mode) < 0) {
        throw storeError('Invalid UID mode ' + JSON.stringify(mode) + ', expected keep, renumber, shuffle or offset', 'INVALID');
    }
    const offset = options.offset === undefined ? 0 : options.offset;
    if (!Number.isSafeInteger(offset) || offset < 0) {
        throw storeError('Offset must be a non-negative integer', 'INVALID');
    }
    let uidvalidity = options.uidvalidity;
    if (uidvalidity === undefined) {
        uidvalidity = Math.max(mailbox.uidvalidity, server.uidvalidityCounter) + 1;
    } else if (!Number.isSafeInteger(uidvalidity) || uidvalidity <= mailbox.uidvalidity || uidvalidity > 0xffffffff) {
        // nz-number of RFC 3501 section 9, a 32-bit value
        throw storeError('UIDVALIDITY must be an integer above ' + mailbox.uidvalidity + ' and below 2^32', 'INVALID');
    }
    if (options.seed !== undefined && !Number.isSafeInteger(options.seed)) {
        throw storeError('Seed must be an integer', 'INVALID');
    }

    byeSelected(server, mailbox, 'UIDVALIDITY of the selected mailbox changed', 'UIDVALIDITY CHANGED');

    const messages = mailbox.messages;
    const oldUids = messages.map(message => message.uid);
    let newUids = oldUids;
    if (mode === 'renumber' || mode === 'shuffle') {
        newUids = messages.map((message, i) => i + 1);
        if (mode === 'shuffle') {
            const random = seededRandom(options.seed === undefined ? Math.floor(Math.random() * MAX_NUMBER) : options.seed);
            // Fisher-Yates
            for (let i = newUids.length - 1; i > 0; i--) {
                const j = Math.floor(random() * (i + 1));
                [newUids[i], newUids[j]] = [newUids[j], newUids[i]];
            }
        }
        mailbox.uidnext = messages.length + 1;
    } else if (mode === 'offset') {
        const shift = mailbox.uidnext - 1 + offset;
        newUids = oldUids.map(uid => uid + shift);
        mailbox.uidnext += shift;
    }

    messages.forEach((message, i) => {
        message.uid = newUids[i];
    });
    if (mode === 'shuffle') {
        // the other modes keep the UID order
        messages.sort((a, b) => a.uid - b.uid);
    }
    mailbox.uidvalidity = uidvalidity;
    server.uidvalidityCounter = Math.max(server.uidvalidityCounter, uidvalidity);

    return {
        uidvalidity,
        uidnext: mailbox.uidnext,
        uids: oldUids.map((uid, i) => ({ uid, newUid: newUids[i] }))
    };
}

/**
 * Subscribes a mailbox (SUBSCRIBE), only an existing mailbox can be subscribed
 *
 * @param {Object} server IMAP server
 * @param {String} path Storage name of the mailbox
 * @return {Boolean} true if the subscription changed
 * @throws {Error} NONEXISTENT for a name that is not a mailbox
 */
function subscribeMailbox(server: IMAPServer, path: string): boolean {
    const mailbox = server.getMailbox(path);
    if (!mailbox || mailbox.flags.indexOf('\\Noselect') >= 0) {
        throw storeError('Mailbox does not exist', 'NONEXISTENT');
    }
    if (mailbox.subscribed) {
        return false;
    }
    mailbox.subscribed = true;
    server.mailboxChanged('subscribe', mailbox.path);
    return true;
}

/**
 * Unsubscribes a name (UNSUBSCRIBE). The subscription list holds names, so a name stays removable after its
 * mailbox is deleted (RFC 3501 section 6.3.6). Removing a name that is not subscribed is not an error
 * (RFC 9051 section 6.3.8)
 *
 * @param {Object} server IMAP server
 * @param {String} path Storage name
 * @return {Boolean} true if the subscription changed
 */
function unsubscribeMailbox(server: IMAPServer, path: string): boolean {
    if (path.toUpperCase() === 'INBOX') {
        path = 'INBOX';
    }
    if (!server.subscriptions.delete(path)) {
        return false;
    }
    server.mailboxChanged('unsubscribe', path);
    return true;
}

export {
    DEFAULT_SESSION_TIMEOUT,
    ImapKitError,
    storeError,
    expungeMessages,
    notifyFlagChanges,
    checkFlags,
    changeFlags,
    createMailbox,
    deleteMailbox,
    renameMailbox,
    resetUidValidity,
    subscribeMailbox,
    unsubscribeMailbox
};
export type { ExpungeOptions, FlagMode, UidMode, UidValidityOptions };
