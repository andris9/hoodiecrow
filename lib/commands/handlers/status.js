'use strict';

/**
 * STATUS data items, shared by the STATUS command and the STATUS return option of LIST (LIST-STATUS,
 * RFC 5819). A STATUS item can only be requested when it is listed in `server.allowedStatus`.
 * Plugins add their items to `server.statusHandlers` (consulted before the built-in items) and to
 * `server.allowedStatus`.
 */

const statusHandlers = {
    MESSAGES: (connection, mailbox) => mailbox.messages.length,
    RECENT: (connection, mailbox, status) => status.recent,
    UIDNEXT: (connection, mailbox) => mailbox.uidnext,
    UIDVALIDITY: (connection, mailbox) => mailbox.uidvalidity,
    UNSEEN: (connection, mailbox, status) => status.unseen || 0,
    // RFC 9051 section 6.3.11. Not in RFC 3501, so only the plugins that add it (IMAP4rev2, QUOTA) list it in allowedStatus
    DELETED: (connection, mailbox, status) => status.flags['\\Deleted'] || 0
};

// RFC 3501 section 9 atom = 1*ATOM-CHAR

/**
 * Validates a list of STATUS data item names (RFC 3501 section 9, "(" status-att *(SP status-att) ")")
 *
 * @param {Object} server IMAPServer instance
 * @param {Array} list Parsed list of status items
 * @param {Object} [connection] IMAP connection, its `disabledStatusItems` set lists items the session can not use
 * @return {Array} upper case item names
 * @throws {Error} if the list is empty or has an invalid item, the message is for the BAD response
 */
function parseStatusItems(server, list, connection) {
    if (!Array.isArray(list) || !list.length) {
        throw new Error('Expecting a list of status items');
    }
    const disabled = connection && connection.disabledStatusItems;
    return list.map((item, i) => {
        const name = item && item.type === 'ATOM' && item.value.toUpperCase();
        if (!name || server.allowedStatus.indexOf(name) < 0 || (disabled && disabled.has(name))) {
            throw new Error('Invalid status element (' + (i + 1) + ')');
        }
        return name;
    });
}

/**
 * Sends an untagged STATUS response
 *
 * @param {Object} connection IMAPConnection instance
 * @param {String} path Storage name of the mailbox
 * @param {Object} mailbox Mailbox object
 * @param {Array} items Upper case item names from parseStatusItems
 * @param {Object} parsed Parsed command
 * @param {Object} data Command data
 */
function sendStatus(connection, path, mailbox, items, parsed, data) {
    connection.send(statusResponse(connection, path, mailbox, items), 'STATUS', parsed, data);
}

/**
 * Builds an untagged STATUS response
 *
 * @param {Object} connection IMAPConnection instance
 * @param {String} path Storage name of the mailbox
 * @param {Object} mailbox Mailbox object
 * @param {Array} items Upper case item names
 * @return {Object} STATUS response
 */
function statusResponse(connection, path, mailbox, items) {
    const server = connection.server;
    const status = server.getStatus(mailbox);
    const list = [];
    items.forEach(item => {
        list.push({ type: 'ATOM', value: item }, (server.statusHandlers[item] || statusHandlers[item])(connection, mailbox, status));
    });
    return {
        tag: '*',
        command: 'STATUS',
        // the mailbox name is converted for the session in IMAPConnection#send
        attributes: [{ type: 'MAILBOX', value: path }, list]
    };
}

module.exports = { parseStatusItems, sendStatus, statusResponse };
