'use strict';

const { badError } = require('./commands/handlers/search');

/**
 * ESEARCH response helpers (RFC 4731, RFC 4466 section 2.6.2). Used by the ESEARCH, SEARCHRES, PARTIAL,
 * CONTEXT=SEARCH and MULTISEARCH plugins, and meant to be reused where SEARCH always answers with ESEARCH (IMAP4rev2, RFC 9051).
 */

/**
 * Formats a list of numbers as a compact sequence-set, e.g. [1, 2, 3, 5] becomes "1:3,5"
 *
 * @param {Array} numbers List of nz-numbers, in any order
 * @return {String} sequence-set, empty for an empty list
 */
function toSequenceSet(numbers) {
    return toOrderedSet(Array.from(new Set(numbers)).sort((a, b) => a - b));
}

/**
 * Formats a list of numbers as a sequence-set that keeps their order, for SORT results (RFC 5267
 * section 3.2): only runs of ascending consecutive numbers become ranges, e.g. [5, 3, 4, 2] becomes "5,3:4,2"
 *
 * @param {Array} numbers List of nz-numbers in the requested order
 * @return {String} sequence-set, empty for an empty list
 */
function toOrderedSet(numbers) {
    const ranges = [];
    numbers.forEach(nr => {
        const last = ranges[ranges.length - 1];
        if (last && last[1] + 1 === nr) {
            last[1] = nr;
        } else {
            ranges.push([nr, nr]);
        }
    });
    return ranges.map(range => (range[0] === range[1] ? String(range[0]) : range[0] + ':' + range[1])).join(',');
}

// RFC 3501 section 9 (and RFC 9051): nz-number is a 32-bit unsigned value
const MAX_NZ_NUMBER = 4294967295;

/**
 * Parses the argument of the PARTIAL search return option (RFC 5267 section 4.4, RFC 9394 section 4):
 * partial-range-first = nz-number ":" nz-number, partial-range-last = "-" nz-number ":" "-" nz-number.
 * "*" is not allowed, and 500:400 is the same as 400:500
 *
 * @param {Object} item Parsed argument
 * @param {Boolean} allowLast If true, the partial-range-last form of RFC 9394 is accepted
 * @return {Object} `{ range, from, to, fromEnd }`, `range` is the argument as the client sent it
 */
function parsePartialRange(item, allowLast) {
    const value = item && ['ATOM', 'SEQUENCE'].includes(item.type) ? String(item.value) : '';
    const match = value.match(/^(-?)([1-9][0-9]*):(-?)([1-9][0-9]*)$/);
    if (!match || match[1] !== match[3] || (match[1] && !allowLast)) {
        throw badError('PARTIAL expects a range like 1:100' + (allowLast ? ' or -1:-100' : ''));
    }
    const first = Number(match[2]);
    const last = Number(match[4]);
    if (first > MAX_NZ_NUMBER || last > MAX_NZ_NUMBER) {
        throw badError('PARTIAL range is out of bounds');
    }
    return { range: value, from: Math.min(first, last), to: Math.max(first, last), fromEnd: !!match[1] };
}

/**
 * Picks the results that a PARTIAL range refers to. The first result is 1, and -1 is the last one
 * (RFC 9394 section 3.1). Results outside the list are left out
 *
 * @param {Array} list Results in mailbox order
 * @param {Object} partial Parsed range, see parsePartialRange
 * @return {Array} results in the range, in mailbox order
 */
function selectPartial(list, partial) {
    if (!partial.fromEnd) {
        return list.slice(partial.from - 1, partial.to);
    }
    return list.slice(Math.max(list.length - partial.to, 0), Math.max(list.length - partial.from + 1, 0));
}

/**
 * Registers the PARTIAL search return option, shared by the PARTIAL and CONTEXT=SEARCH plugins. The
 * partial-range-last form (-1:-100) is only valid with the PARTIAL capability (RFC 9394 section 4)
 *
 * @param {Object} server IMAP server, with the ESEARCH plugin loaded
 */
function registerPartialOption(server) {
    if (server.searchReturnOptions.has('PARTIAL')) {
        return;
    }
    server.searchReturnOptions.set('PARTIAL', { data: true, once: true, parse: item => parsePartialRange(item, !!server.partialRangeLast) });
    // RFC 5267 section 4.4 and RFC 9394 section 3.1: a command MUST NOT contain more than one PARTIAL or ALL
    server.searchReturnOptions.set('ALL', Object.assign({}, server.searchReturnOptions.get('ALL'), { once: true }));
    server.searchReturnChecks.push(options => options.has('PARTIAL') && options.has('ALL') && 'PARTIAL and ALL can not be used together');
}

/**
 * Picks the messages that the requested result options return. With COUNT or ALL, or without
 * MIN, MAX and PARTIAL, these are all matching messages, otherwise the lowest and/or the highest
 * matching message and the ones in the PARTIAL range. This is the set that the MODSEQ result
 * option describes (RFC 4731 section 3.2) and that SAVE stores (RFC 5182 section 2.4, RFC 9394
 * section 3.2)
 *
 * @param {Array} list Matching messages, in mailbox order
 * @param {Map} options Upper case result option names to their arguments, an empty map stands for ALL
 * @return {Array} returned messages, in mailbox order
 */
function selectReturned(list, options) {
    const partial = options.get('PARTIAL');
    if (!list.length || options.has('ALL') || options.has('COUNT') || (!partial && !options.has('MIN') && !options.has('MAX'))) {
        return list;
    }
    const returned = new Set(partial ? selectPartial(list, partial) : []);
    if (options.has('MIN')) {
        returned.add(list[0]);
    }
    if (options.has('MAX')) {
        returned.add(list[list.length - 1]);
    }
    return list.filter(message => returned.has(message));
}

/**
 * Builds the search correlator (RFC 4466 section 2.6.2), with the MAILBOX and UIDVALIDITY
 * correlators of RFC 7377 section 4 if a mailbox is given
 *
 * @param {String} tag Tag of the command
 * @param {Object} [mailbox] Mailbox the response is about
 * @return {Array} correlator list
 */
function buildCorrelator(tag, mailbox) {
    const correlator = [
        { type: 'ATOM', value: 'TAG' },
        { type: 'STRING', value: tag }
    ];
    if (mailbox) {
        correlator.push(
            { type: 'ATOM', value: 'MAILBOX' },
            // send() puts in the form of the name that the session uses
            { type: 'MAILBOX', value: mailbox.path },
            { type: 'ATOM', value: 'UIDVALIDITY' },
            mailbox.uidvalidity
        );
    }
    return correlator;
}

/**
 * Builds an ESEARCH response (RFC 4466 section 2.6.2) with the RFC 4731 section 3.1 return data
 * and PARTIAL (RFC 5267 section 4.4, RFC 9394 section 3.1)
 *
 * @param {String} tag Tag of the command, for the search correlator
 * @param {Boolean} isUid If true, the response lists UIDs and has the UID indicator
 * @param {Object} result Search result, `{ list, numbers }` (see lib/commands/handlers/search.js)
 * @param {Map} options Upper case result option names to their arguments, an empty map stands for ALL (RFC 4731 section 3.1)
 * @param {Object} [mailbox] Adds the MAILBOX and UIDVALIDITY correlators of RFC 7377 for this mailbox
 * @param {Array} [sorted] The matching messages in sort order, for an extended SORT (RFC 5267 section 3.1): MIN and MAX are
 *        the first and the last sorted message, ALL and PARTIAL list the results in sort order
 * @return {Object} response for connection.send()
 */
function buildEsearchResponse(tag, isUid, result, options, mailbox, sorted) {
    const values = (sorted || result.list).map(message => (isUid ? message.uid : result.numbers[message.uid]));
    if (!sorted) {
        values.sort((a, b) => a - b);
    }
    const toSet = sorted ? toOrderedSet : toSequenceSet;

    const attributes = [buildCorrelator(tag, mailbox)];
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
        add('ALL', { type: 'SEQUENCE', value: toSet(values) });
    }
    if (options.has('PARTIAL')) {
        // the requested range, and NIL when no results fall in it (RFC 9394 section 3.1)
        const partial = options.get('PARTIAL');
        const selected = selectPartial(values, partial);
        add('PARTIAL', [{ type: 'ATOM', value: partial.range }, selected.length ? { type: 'SEQUENCE', value: toSet(selected) } : null]);
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

module.exports = {
    MAX_NZ_NUMBER,
    toSequenceSet,
    toOrderedSet,
    selectReturned,
    selectPartial,
    parsePartialRange,
    registerPartialOption,
    buildCorrelator,
    buildEsearchResponse
};
