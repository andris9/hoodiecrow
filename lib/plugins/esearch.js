'use strict';

/**
 * @help Adds ESEARCH [RFC4731] capability
 * @help SEARCH and UID SEARCH take the RETURN (MIN MAX ALL COUNT) result options and answer with ESEARCH
 */

const { buildEsearchResponse, selectReturned } = require('../esearch');

// RFC 4466 section 2.6.1: search = "SEARCH" [SP "RETURN" SP "(" [search-return-opt *(SP search-return-opt)] ")"] SP search-program
const hasReturnOptions = attributes => {
    const first = attributes && attributes[0];
    return !!first && first.type === 'ATOM' && String(first.value).toUpperCase() === 'RETURN';
};

module.exports = function (server) {
    // SEARCHRES loads ESEARCH as well, so the plugin may be called twice
    if (server.searchReturnOptions) {
        return;
    }

    server.registerCapability('ESEARCH');

    // RFC 4731 section 3.1 result options. Other plugins add their own (SAVE of SEARCHRES), with
    // `data: false` for an option that does not add data to the ESEARCH response
    server.searchReturnOptions = new Map(['MIN', 'MAX', 'ALL', 'COUNT'].map(name => [name, { data: true }]));

    const sendBad = (connection, parsed, data, callback, message) => {
        connection.sendStatus(parsed, data, 'BAD', message, false, (parsed.command || '').toUpperCase() + ' FAILED');
        return callback();
    };

    // The result options are taken off the arguments, so the SEARCH handler only sees the search program
    const searchWrapper = (prevHandler, connection, parsed, data, callback) => {
        if (!hasReturnOptions(parsed.attributes)) {
            return prevHandler(connection, parsed, data, callback);
        }

        const list = parsed.attributes[1];
        if (!Array.isArray(list)) {
            return sendBad(connection, parsed, data, callback, 'RETURN expects a parenthesized list of result options');
        }

        const options = new Set();
        for (const item of list) {
            const name = item && item.type === 'ATOM' ? String(item.value).toUpperCase() : '';
            // options that the server does not support must be rejected with BAD (RFC 4466 section 2.6.1)
            if (!server.searchReturnOptions.has(name)) {
                return sendBad(connection, parsed, data, callback, 'Unknown SEARCH result option' + (name ? ' ' + name : ''));
            }
            options.add(name);
        }

        parsed.attributes = parsed.attributes.slice(2);
        parsed.searchReturn = options;
        prevHandler(connection, parsed, data, callback);
    };

    ['SEARCH', 'UID SEARCH'].forEach(command => {
        const prevHandler = server.getCommandHandler(command);
        server.setCommandHandler(command, (connection, parsed, data, callback) => searchWrapper(prevHandler, connection, parsed, data, callback));
    });

    // RFC 3501 section 5.5: only the search program can hold sequence numbers, the result options do not
    server.connectionHandlers.push(connection => {
        const usesSequenceNumbers = connection.usesSequenceNumbers;
        connection.usesSequenceNumbers = function (parsed) {
            if (hasReturnOptions(parsed.attributes)) {
                parsed = Object.assign({}, parsed, { attributes: parsed.attributes.slice(2) });
            }
            return usesSequenceNumbers.call(this, parsed);
        };
    });

    // Replaces the SEARCH response of an extended SEARCH with a single ESEARCH response (RFC 4731 section 3.1)
    server.outputHandlers.push((connection, response, description, parsed, data, extra) => {
        if (
            !parsed ||
            !parsed.searchReturn ||
            response.tag !== '*' ||
            response.command !== 'SEARCH' ||
            (description !== 'SEARCH' && description !== 'UID SEARCH') ||
            !extra ||
            !Array.isArray(extra.list)
        ) {
            return;
        }
        response.skipResponse = true;

        const options = parsed.searchReturn;
        // only options without return data, like SAVE (RFC 5182 section 1), suppress the response
        if (options.size && ![...options].some(name => server.searchReturnOptions.get(name).data)) {
            return;
        }

        // like for SEARCH, the extra data is the search result, but `list` only holds the messages that the
        // result options return (RFC 4731 section 3.2), for the MODSEQ of CONDSTORE
        connection.send(
            buildEsearchResponse(parsed.tag, description === 'UID SEARCH', extra, options),
            'ESEARCH',
            parsed,
            data,
            Object.assign({}, extra, { list: selectReturned(extra.list, options) })
        );
    });
};
