'use strict';

const storeHandlers = require('./handlers/store');
const { restoreNilAtoms, isAtom } = require('../arguments');

/**
 * Returns the handler of a STORE data item, plugins first
 *
 * @param {Object} connection IMAP connection
 * @param {String} name Data item name, e.g. "+FLAGS.SILENT"
 * @return {Function|undefined} handler
 */
function getStoreHandler(connection, name) {
    name = String(name).toUpperCase();
    return connection.server.storeHandlers[name] || storeHandlers[name];
}

/**
 * Shared implementation of STORE and UID STORE
 *
 * @param {Boolean} isUid If true, the sequence set lists UIDs
 */
function processStore(isUid, connection, parsed, data, callback) {
    const command = isUid ? 'UID STORE' : 'STORE';

    // a store handler with `astringValues` takes astrings, like the labels of X-GM-LABELS: these can be literals,
    // and NIL is a name there. Flags are atoms (RFC 3501 section 9: flag-list)
    const itemArgument = parsed.attributes && parsed.attributes[1];
    const itemHandler = isAtom(itemArgument) && getStoreHandler(connection, itemArgument.value);
    const astringValues = !!(itemHandler && itemHandler.astringValues);
    const valueTypes = astringValues ? ['ATOM', 'STRING', 'LITERAL'] : ['ATOM', 'STRING'];
    if (astringValues) {
        restoreNilAtoms(parsed, data, path => path[0] === 2);
    }

    if (
        !parsed.attributes ||
        parsed.attributes.length !== 3 ||
        !parsed.attributes[0] ||
        ['ATOM', 'SEQUENCE'].indexOf(parsed.attributes[0].type) < 0 ||
        !parsed.attributes[1] ||
        ['ATOM'].indexOf(parsed.attributes[1].type) < 0 ||
        !parsed.attributes[2] ||
        !(valueTypes.indexOf(parsed.attributes[2].type) >= 0 || Array.isArray(parsed.attributes[2]))
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
    if (connection.refuseReadOnly(parsed, data, command + ' FAILED')) {
        return callback();
    }

    // Respond with NO if pending response messages exist. UID STORE may be answered with EXPUNGE
    // responses (RFC 3501 7.4.1), so this only applies to STORE
    if (!isUid && connection.hasPendingExpunge()) {
        // RFC 5530 section 3: EXPUNGEISSUED, someone else has issued an EXPUNGE for the same mailbox
        connection.sendStatus(parsed, data, 'NO', 'Pending EXPUNGE messages, can not store', 'EXPUNGEISSUED', command + ' FAILED');
        return callback();
    }

    const range = connection.limitRange(parsed, connection.getCommandRange(parsed.attributes[0].value, isUid));
    const itemName = (parsed.attributes[1].value || '').toUpperCase();
    const itemValue = [].concat(parsed.attributes[2] || []);
    const affected = [];

    try {
        itemValue.forEach((item, i) => {
            if (!item || valueTypes.indexOf(item.type) < 0) {
                throw new Error('Invalid item value #' + (i + 1));
            }
        });

        range.forEach(rangeMessage => {
            for (let i = 0, len = connection.server.storeFilters.length; i < len; i++) {
                if (!connection.server.storeFilters[i](connection, rangeMessage[1], parsed, rangeMessage[0])) {
                    return;
                }
            }

            const handler = getStoreHandler(connection, itemName);
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
