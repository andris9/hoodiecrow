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
    // RFC 9051 section 6.3.11. IMAP4rev2 only, so it is not in the default allowedStatus list. An
    // IMAP4rev2 mode can turn it on with `server.allowedStatus.push('DELETED')`
    DELETED: (connection, mailbox, status) => status.flags['\\Deleted'] || 0
};

// RFC 3501 section 9 atom = 1*ATOM-CHAR

/**
 * Validates a list of STATUS data item names (RFC 3501 section 9, "(" status-att *(SP status-att) ")")
 *
 * @param {Object} server IMAPServer instance
 * @param {Array} list Parsed list of status items
 * @return {Array} upper case item names
 * @throws {Error} if the list is empty or has an invalid item, the message is for the BAD response
 */
function parseStatusItems(server, list) {
    if (!Array.isArray(list) || !list.length) {
        throw new Error('Expecting a list of status items');
    }
    return list.map((item, i) => {
        const name = item && item.type === 'ATOM' && item.value.toUpperCase();
        if (!name || server.allowedStatus.indexOf(name) < 0) {
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
    const server = connection.server;
    const status = server.getStatus(mailbox);
    const list = [];
    items.forEach(item => {
        list.push({ type: 'ATOM', value: item }, (server.statusHandlers[item] || statusHandlers[item])(connection, mailbox, status));
    });

    connection.send(
        {
            tag: '*',
            command: 'STATUS',
            // the mailbox name is converted for the session in IMAPConnection#send
            attributes: [{ type: 'MAILBOX', value: path }, list]
        },
        'STATUS',
        parsed,
        data
    );
}

module.exports = { parseStatusItems, sendStatus };
