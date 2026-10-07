'use strict';

/**
 * @help Adds PARTIAL [RFC9394] capability, loads ESEARCH as well
 * @help SEARCH RETURN (PARTIAL 1:100) or (PARTIAL -1:-100) returns a window of the results, FETCH and UID FETCH take a PARTIAL modifier
 */

const esearch = require('./esearch');
const { parsePartialRange, selectPartial, registerPartialOption } = require('../esearch');

const isPartial = item => !!item && item.type === 'ATOM' && String(item.value).toUpperCase() === 'PARTIAL';

module.exports = function (server) {
    // the PARTIAL search return option is returned in an ESEARCH response (RFC 9394 section 3.1)
    esearch(server);

    server.registerCapability('PARTIAL');
    server.partialRangeLast = true;
    registerPartialOption(server);

    // RFC 9394 section 3.3: fetch-modifier =/ modifier-partial. The grammar (RFC 4466 section 2.4) allows
    // the modifier for FETCH as well as for UID FETCH. The modifier is taken off the list, CHANGEDSINCE of
    // CONDSTORE then filters the messages in the range (RFC 9394 section 3.4)
    const fetchWrapper = (prevHandler, connection, parsed, data, callback) => {
        const modifiers = parsed.attributes && parsed.attributes[2];
        if (Array.isArray(modifiers)) {
            for (let i = 0; i < modifiers.length; i += 2) {
                if (!isPartial(modifiers[i])) {
                    continue;
                }
                try {
                    if (parsed.partialFetch) {
                        throw new Error('PARTIAL can be used only once');
                    }
                    parsed.partialFetch = parsePartialRange(modifiers[i + 1], true);
                } catch (E) {
                    connection.sendStatus(parsed, data, 'BAD', E.message, false, (parsed.command || '').toUpperCase() + ' FAILED');
                    return callback();
                }
                modifiers.splice(i, 2);
                i -= 2;
            }
            if (!modifiers.length) {
                parsed.attributes.splice(2, 1);
            }
        }
        prevHandler(connection, parsed, data, callback);
    };

    ['FETCH', 'UID FETCH'].forEach(command => {
        const prevHandler = server.getCommandHandler(command);
        server.setCommandHandler(command, (connection, parsed, data, callback) => fetchWrapper(prevHandler, connection, parsed, data, callback));
    });

    // only the messages in the PARTIAL range of the messages that the sequence set matched are returned,
    // checked before the other filters
    server.fetchFilters.unshift((connection, message, parsed) => {
        if (!parsed.partialFetch) {
            return true;
        }
        if (!parsed.partialFetchSet) {
            const isUid = (parsed.command || '').toUpperCase() === 'UID FETCH';
            const range = connection.getMessageRange(parsed.attributes[0].value, isUid).map(item => item[1]);
            parsed.partialFetchSet = new Set(selectPartial(range, parsed.partialFetch));
        }
        return parsed.partialFetchSet.has(message);
    });
};
