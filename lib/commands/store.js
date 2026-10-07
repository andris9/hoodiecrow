'use strict';

const storeHandlers = require('./handlers/store');

/**
 * Shared implementation of STORE and UID STORE
 *
 * @param {Boolean} isUid If true, the sequence set lists UIDs
 */
function processStore(isUid, connection, parsed, data, callback) {
    const command = isUid ? 'UID STORE' : 'STORE';

    if (
        !parsed.attributes ||
        parsed.attributes.length !== 3 ||
        !parsed.attributes[0] ||
        ['ATOM', 'SEQUENCE'].indexOf(parsed.attributes[0].type) < 0 ||
        !parsed.attributes[1] ||
        ['ATOM'].indexOf(parsed.attributes[1].type) < 0 ||
        !parsed.attributes[2] ||
        !(['ATOM', 'STRING'].indexOf(parsed.attributes[2].type) >= 0 || Array.isArray(parsed.attributes[2]))
    ) {
        connection.send(
            {
                tag: parsed.tag,
                command: 'BAD',
                attributes: [
                    {
                        type: 'TEXT',
                        value: command + ' expects sequence set, item name and item value'
                    }
                ]
            },
            'INVALID COMMAND',
            parsed,
            data
        );
        return callback();
    }

    // A mailbox opened with EXAMINE is read-only (RFC 3501 6.3.2), so its flags can not be changed
    if (connection.readOnly) {
        connection.sendStatus(parsed, data, 'NO', 'Mailbox is read-only', false, command + ' FAILED');
        return callback();
    }

    // Respond with NO if pending response messages exist. UID STORE may be answered with EXPUNGE
    // responses (RFC 3501 7.4.1), so this only applies to STORE
    if (!isUid && connection.hasPendingExpunge()) {
        connection.sendStatus(parsed, data, 'NO', 'Pending EXPUNGE messages, can not store', false, command + ' FAILED');
        return callback();
    }

    const range = connection.limitRange(parsed, connection.getMessageRange(parsed.attributes[0].value, isUid));
    const itemName = (parsed.attributes[1].value || '').toUpperCase();
    const itemValue = [].concat(parsed.attributes[2] || []);
    const affected = [];

    try {
        itemValue.forEach((item, i) => {
            if (!item || ['STRING', 'ATOM'].indexOf(item.type) < 0) {
                throw new Error('Invalid item value #' + (i + 1));
            }
        });

        range.forEach(rangeMessage => {
            for (let i = 0, len = connection.server.storeFilters.length; i < len; i++) {
                if (!connection.server.storeFilters[i](connection, rangeMessage[1], parsed, rangeMessage[0])) {
                    return;
                }
            }

            const handler = connection.server.storeHandlers[itemName] || storeHandlers[itemName];
            if (!handler) {
                throw new Error('Invalid STORE argument ' + itemName);
            }

            handler(connection, rangeMessage[1], itemValue, rangeMessage[0], parsed, data);

            affected.push(rangeMessage[1]);
        });
    } catch (E) {
        connection.send(
            {
                tag: parsed.tag,
                command: 'BAD',
                attributes: [
                    {
                        type: 'TEXT',
                        value: E.message
                    }
                ]
            },
            command + ' FAILED',
            parsed,
            data
        );
        return callback();
    }

    connection.send(
        {
            tag: parsed.tag,
            command: 'OK',
            attributes: [
                {
                    type: 'TEXT',
                    value: command + ' completed'
                }
            ]
        },
        command + ' COMPLETE',
        parsed,
        data,
        affected
    );

    // other sessions that have the mailbox selected learn about the new flags (RFC 3501 section 5.2)
    connection.notifyFlagChanges(affected);

    callback();
}

module.exports = (connection, parsed, data, callback) => processStore(false, connection, parsed, data, callback);
module.exports.processStore = processStore;
