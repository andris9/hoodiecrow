'use strict';

/**
 * ESEARCH response helpers (RFC 4731, RFC 4466 section 2.6.2). Used by the ESEARCH and SEARCHRES
 * plugins, and meant to be reused where SEARCH always answers with ESEARCH (IMAP4rev2, RFC 9051).
 */

/**
 * Formats a list of numbers as a compact sequence-set, e.g. [1, 2, 3, 5] becomes "1:3,5"
 *
 * @param {Array} numbers List of nz-numbers, in any order
 * @return {String} sequence-set, empty for an empty list
 */
function toSequenceSet(numbers) {
    const sorted = Array.from(new Set(numbers)).sort((a, b) => a - b);
    const ranges = [];
    sorted.forEach(nr => {
        const last = ranges[ranges.length - 1];
        if (last && last[1] + 1 === nr) {
            last[1] = nr;
        } else {
            ranges.push([nr, nr]);
        }
    });
    return ranges.map(range => (range[0] === range[1] ? String(range[0]) : range[0] + ':' + range[1])).join(',');
}

/**
 * Picks the messages that the requested result options return. With MIN and/or MAX but neither
 * ALL nor COUNT, these are the lowest and/or the highest matching message, otherwise all matching
 * messages. This is the set that the MODSEQ result option describes (RFC 4731 section 3.2) and
 * that SAVE stores (RFC 5182 section 2.4)
 *
 * @param {Array} list Matching messages, in mailbox order
 * @param {Set} options Upper case result option names, an empty set stands for ALL
 * @return {Array} returned messages
 */
function selectReturned(list, options) {
    if (!list.length || options.has('ALL') || options.has('COUNT') || (!options.has('MIN') && !options.has('MAX'))) {
        return list;
    }
    const returned = new Set();
    if (options.has('MIN')) {
        returned.add(list[0]);
    }
    if (options.has('MAX')) {
        returned.add(list[list.length - 1]);
    }
    return Array.from(returned);
}

/**
 * Builds an ESEARCH response (RFC 4466 section 2.6.2) with the RFC 4731 section 3.1 return data
 *
 * @param {String} tag Tag of the command, for the search correlator
 * @param {Boolean} isUid If true, the response lists UIDs and has the UID indicator
 * @param {Object} result Search result, `{ list, numbers }` (see lib/commands/handlers/search.js)
 * @param {Set} options Upper case result option names, an empty set stands for ALL (RFC 4731 section 3.1)
 * @return {Object} response for connection.send()
 */
function buildEsearchResponse(tag, isUid, result, options) {
    const values = result.list.map(message => (isUid ? message.uid : result.numbers[message.uid])).sort((a, b) => a - b);

    const attributes = [
        [
            { type: 'ATOM', value: 'TAG' },
            { type: 'STRING', value: tag }
        ]
    ];
    if (isUid) {
        attributes.push({ type: 'ATOM', value: 'UID' });
    }

    const add = (name, value) => attributes.push({ type: 'ATOM', value: name }, value);
    // MIN, MAX and ALL are left out when nothing matched, COUNT is always included (RFC 4731 section 3.1)
    if (values.length && options.has('MIN')) {
        add('MIN', values[0]);
    }
    if (values.length && options.has('MAX')) {
        add('MAX', values[values.length - 1]);
    }
    if (values.length && (options.has('ALL') || !options.size)) {
        add('ALL', { type: 'SEQUENCE', value: toSequenceSet(values) });
    }
    if (options.has('COUNT')) {
        add('COUNT', values.length);
    }

    return {
        tag: '*',
        command: 'ESEARCH',
        attributes
    };
}

module.exports = { toSequenceSet, selectReturned, buildEsearchResponse };
