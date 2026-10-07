'use strict';

/**
 * @help Adds SEARCHRES [RFC5182] capability, loads ESEARCH as well
 * @help SEARCH RETURN (SAVE) stores the result, "$" refers to it in place of a sequence set
 */

const esearch = require('./esearch');
const { selectReturned } = require('../esearch');

// Commands after which the search result variable is empty (RFC 5182 section 2.1). After CLOSE and
// UNSELECT no mailbox is selected, so "$" can not be used until the next SELECT or EXAMINE anyway
const RESET_COMMANDS = new Set(['SELECT', 'EXAMINE', 'CLOSE', 'UNSELECT']);

const isSearch = command => command === 'SEARCH' || command === 'UID SEARCH';

module.exports = function (server) {
    // a SEARCHRES server MUST also implement ESEARCH (RFC 5182 section 2.1)
    esearch(server);

    server.registerCapability('SEARCHRES');
    // SAVE adds no data to the ESEARCH response
    server.searchReturnOptions.set('SAVE', { data: false });

    server.connectionHandlers.push(connection => {
        // RFC 5182 section 3: sequence-set =/ seq-last-command, seq-last-command = "$". Dovecot only accepts
        // "$" as the whole sequence set, not combined with numbers like "1,$", and neither does hoodiecrow
        const getMessageRange = connection.getMessageRange;
        connection.getMessageRange = function (range, isUid) {
            if (range !== '$') {
                return getMessageRange.call(this, range, isUid);
            }
            // The search result variable holds message objects, so expunged messages drop out of it without
            // renumbering, and it is the same set for UID and sequence number commands (RFC 5182 section 2.1).
            // As "$" holds no sequence numbers, core lets it be pipelined (RFC 5182 section 2.3)
            const saved = this.searchResult || new Set();
            const result = [];
            this.getSessionMessages().forEach((message, i) => {
                if (saved.has(message)) {
                    result.push([i + 1, message]);
                }
            });
            return result;
        };
    });

    server.outputHandlers.push((connection, response, description, parsed, data, extra) => {
        if (!parsed || !response || (response.tag !== parsed.tag && response.command !== 'SEARCH')) {
            return;
        }
        const command = (parsed.command || '').toUpperCase();
        const save = isSearch(command) && parsed.searchReturn && parsed.searchReturn.has('SAVE');

        // the result of SEARCH, with MIN and/or MAX only these messages are saved (RFC 5182 section 2.4).
        // It is stored once the tagged response tells if the command succeeded
        if (save && response.tag === '*' && response.command === 'SEARCH' && description === command && extra && Array.isArray(extra.list)) {
            parsed.searchresFound = selectReturned(extra.list, parsed.searchReturn);
            return;
        }

        if (response.tag !== parsed.tag) {
            return;
        }

        if (RESET_COMMANDS.has(command)) {
            connection.searchResult = null;
            return;
        }

        // RFC 5182 section 2.1: an OK sets the variable, a NO empties it and a BAD leaves it as it was
        if (save && response.command !== 'BAD') {
            connection.searchResult = new Set(response.command === 'OK' ? parsed.searchresFound : []);
        }
    });
};
