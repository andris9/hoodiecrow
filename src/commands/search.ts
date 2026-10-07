import makeSearch from './handlers/search.js';
import { criteriaValues, sendSearchError } from './handlers/search.js';
import type { Callback, IMAPConnection, IMAPError, ParsedCommand } from '../types.js';

/**
 * Shared implementation of SEARCH and UID SEARCH
 *
 * @param {Boolean} isUid If true, the response lists UIDs instead of sequence numbers
 */
function processSearch(isUid: boolean, connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) {
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
        sendSearchError(connection, parsed, data, E as IMAPError, command + ' FAILED');
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

const searchCommand = (connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) =>
    processSearch(false, connection, parsed, data, callback);

export default searchCommand;

export { processSearch };
