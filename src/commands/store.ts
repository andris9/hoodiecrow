import storeHandlers from './handlers/store.js';
import { restoreNilAtoms, isAtom } from '../arguments.js';
import type { ArgumentPath } from '../arguments.js';
import type { Attribute, Callback, IMAPConnection, IMAPError, Message, ParsedCommand, StoreHandler } from '../types.js';

/**
 * Returns the handler of a STORE data item, plugins first
 *
 * @param {Object} connection IMAP connection
 * @param {String} name Data item name, e.g. "+FLAGS.SILENT"
 * @return {Function|undefined} handler
 */
function getStoreHandler(connection: IMAPConnection, name: string): StoreHandler | undefined {
    name = String(name).toUpperCase();
    return connection.server.storeHandlers[name] || storeHandlers[name];
}

/**
 * Shared implementation of STORE and UID STORE
 *
 * @param {Boolean} isUid If true, the sequence set lists UIDs
 */
function processStore(isUid: boolean, connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) {
    const command = isUid ? 'UID STORE' : 'STORE';

    // a store handler with `astringValues` takes astrings, like the labels of X-GM-LABELS: these can be literals,
    // and NIL is a name there. Flags are atoms (RFC 3501 section 9: flag-list)
    const itemArgument = parsed.attributes && parsed.attributes[1];
    const itemHandler = isAtom(itemArgument) && getStoreHandler(connection, itemArgument.value);
    const astringValues = !!(itemHandler && itemHandler.astringValues);
    const valueTypes = astringValues ? ['ATOM', 'STRING', 'LITERAL'] : ['ATOM', 'STRING'];
    if (astringValues) {
        restoreNilAtoms(parsed, data, (path: ArgumentPath) => path[0] === 2);
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

    const range = connection.limitRange(parsed, connection.getCommandRange(parsed.attributes[0].value, isUid));
    const itemName = (parsed.attributes[1].value || '').toUpperCase();
    const itemValue = ([] as Attribute[]).concat(parsed.attributes[2] || []);
    const affected: Message[] = [];
    // if the sequence set includes a message that another session expunged without this session being told yet
    let hasExpunged = false;

    try {
        itemValue.forEach((item, i) => {
            if (!item || valueTypes.indexOf(item.type) < 0) {
                throw new Error('Invalid item value #' + (i + 1));
            }
        });

        const handler = itemHandler || getStoreHandler(connection, itemName);
        if (!handler) {
            throw new Error('Invalid STORE argument ' + itemName);
        }

        range.forEach(rangeMessage => {
            if (rangeMessage[1].ghost) {
                // RFC 2180 section 4.2: the flags of an expunged message are not stored
                hasExpunged = true;
                return;
            }

            for (let i = 0, len = connection.server.storeFilters.length; i < len; i++) {
                if (!connection.server.storeFilters[i](connection, rangeMessage[1], parsed, rangeMessage[0])) {
                    return;
                }
            }

            handler(connection, rangeMessage[1], itemValue, rangeMessage[0], parsed, data);

            affected.push(rangeMessage[1]);
        });
    } catch (err) {
        const E = err as IMAPError;
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

    // RFC 2180 sections 4.2.2 and 4.2.3: when the set includes expunged messages, the others are stored and get
    // their FETCH responses, and the tagged NO tells the client to issue NOOP. With .SILENT the result is OK as
    // long as the other messages were stored (section 4.2.1)
    const failed = hasExpunged && !/\.SILENT$/.test(itemName);

    connection.send(
        {
            tag: parsed.tag,
            command: failed ? 'NO' : 'OK',
            attributes: ([] as Attribute[]).concat(failed ? { type: 'SECTION', section: [{ type: 'ATOM', value: 'EXPUNGEISSUED' }] } : [], {
                type: 'TEXT',
                value: failed ? 'Some of the messages no longer exist' : command + ' completed'
            })
        },
        command + (failed ? ' FAILED' : ' COMPLETE'),
        parsed,
        data,
        affected
    );

    // other sessions that have the mailbox selected learn about the new flags (RFC 3501 section 5.2)
    connection.notifyFlagChanges(affected);

    callback();
}

const storeCommand = (connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) =>
    processStore(false, connection, parsed, data, callback);

export default storeCommand;

export { processStore };
