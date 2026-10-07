'use strict';

/**
 * @help Adds ESEARCH [RFC4731] capability
 * @help SEARCH and UID SEARCH take the RETURN (MIN MAX ALL COUNT) result options and answer with ESEARCH
 */

const { buildEsearchResponse, selectReturned } = require('../esearch');
const { badError } = require('../commands/handlers/search');

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

    // RFC 4731 section 3.1 result options. Other plugins add their own: `data: false` for an option that
    // does not add data to the ESEARCH response (SAVE of SEARCHRES), `response: true` if the ESEARCH
    // response is sent even then (UPDATE of CONTEXT=SEARCH), `hint: true` for an option that is accepted
    // and ignored (CONTEXT), `parse(item)` for an option with an argument and `once: true` if the option
    // must not be repeated
    server.searchReturnOptions = new Map(['MIN', 'MAX', 'ALL', 'COUNT'].map(name => [name, { data: true }]));

    // Checks of the whole list of result options, `(options, connection, parsed, names)` returns an error message
    // for an invalid combination. `names` also holds the hint options
    server.searchReturnChecks = [];

    /**
     * Parses a list of result options (RFC 4466 section 2.6.1: search-return-opts)
     *
     * @param {Array} list Parsed list of result options
     * @param {Object} connection IMAP connection
     * @param {Object} parsed Parsed command
     * @return {Map} upper case option names to their parsed arguments (true for options without one)
     * @throws {Error} BAD error for an invalid list
     */
    server.parseSearchReturn = (list, connection, parsed) => {
        if (!Array.isArray(list)) {
            throw badError('RETURN expects a parenthesized list of result options');
        }

        const options = new Map();
        // every option name, also the hints that are left out of `options`
        const names = new Set();
        for (let i = 0; i < list.length; i++) {
            const item = list[i];
            const name = item && item.type === 'ATOM' ? String(item.value).toUpperCase() : '';
            const spec = server.searchReturnOptions.get(name);
            // options that the server does not support must be rejected with BAD (RFC 4466 section 2.6.1)
            if (!spec) {
                throw badError('Unknown SEARCH result option' + (name ? ' ' + name : ''));
            }
            if (spec.once && options.has(name)) {
                throw badError('SEARCH result option ' + name + ' can be used only once');
            }
            names.add(name);
            const value = spec.parse ? spec.parse(list[++i]) : true;
            if (!spec.hint) {
                options.set(name, value);
            }
        }

        for (const check of server.searchReturnChecks) {
            const error = check(options, connection, parsed, names);
            if (error) {
                throw badError(error);
            }
        }
        return options;
    };

    // only result options without return data, like SAVE (RFC 5182 section 1), suppress the ESEARCH response
    server.isSilentReturn = options =>
        options.size > 0 &&
        ![...options.keys()].some(name => {
            const spec = server.searchReturnOptions.get(name);
            return spec.data || spec.response;
        });

    // The result options are taken off the arguments, so the SEARCH handler only sees the search program
    const searchWrapper = (prevHandler, connection, parsed, data, callback) => {
        if (!hasReturnOptions(parsed.attributes)) {
            return prevHandler(connection, parsed, data, callback);
        }

        try {
            parsed.searchReturn = server.parseSearchReturn(parsed.attributes[1], connection, parsed);
        } catch (E) {
            connection.sendStatus(parsed, data, 'BAD', E.message, false, (parsed.command || '').toUpperCase() + ' FAILED');
            return callback();
        }

        parsed.attributes = parsed.attributes.slice(2);
        prevHandler(connection, parsed, data, callback);
    };

    // Lets a command take result options before its other arguments, parsed into `parsed.searchReturn`.
    // ESORT uses it for SORT and UID SORT (RFC 5267 section 3)
    server.acceptSearchReturn = command => {
        const prevHandler = server.getCommandHandler(command);
        server.setCommandHandler(command, (connection, parsed, data, callback) => searchWrapper(prevHandler, connection, parsed, data, callback));
    };

    server.acceptSearchReturn('SEARCH');
    server.acceptSearchReturn('UID SEARCH');

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
        if (server.isSilentReturn(options)) {
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
