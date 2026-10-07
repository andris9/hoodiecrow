'use strict';

const makeSearch = require('./handlers/search');
const { criteriaValues, searchErrorAttributes } = makeSearch;

/**
 * Shared implementation of SEARCH and UID SEARCH
 *
 * @param {Boolean} isUid If true, the response lists UIDs instead of sequence numbers
 */
function processSearch(isUid, connection, parsed, data, callback) {
    const command = isUid ? 'UID SEARCH' : 'SEARCH';

    if (!parsed.attributes || !parsed.attributes.length) {
        connection.send(
            {
                tag: parsed.tag,
                command: 'BAD',
                attributes: [
                    {
                        type: 'TEXT',
                        value: command + ' expects search criteria, empty query given'
                    }
                ]
            },
            command + ' FAILED',
            parsed,
            data
        );
        return callback();
    }

    let searchResult;
    try {
        searchResult = makeSearch(connection, connection.getSessionMessages(), criteriaValues(parsed.attributes));
    } catch (E) {
        connection.send(
            { tag: parsed.tag, command: E.imapResponse === 'BAD' ? 'BAD' : 'NO', attributes: searchErrorAttributes(E) },
            command + ' FAILED',
            parsed,
            data
        );
        return callback();
    }

    // RFC 3501 7.2.5: the SEARCH response is sent even when nothing matched. Plugins get the
    // search result, so they can extend the response or replace it (e.g. ESEARCH)
    connection.send(
        {
            tag: '*',
            command: 'SEARCH',
            attributes: searchResult.list.map(item => {
                return isUid ? item.uid : searchResult.numbers[item.uid];
            })
        },
        command,
        parsed,
        data,
        searchResult
    );

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
        command,
        parsed,
        data
    );
    return callback();
}

module.exports = (connection, parsed, data, callback) => processSearch(false, connection, parsed, data, callback);
module.exports.processSearch = processSearch;
