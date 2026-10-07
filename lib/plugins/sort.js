'use strict';

const { states } = require('../command-states');
const { getMessageData } = require('../mimeparser');
const { collationKey, baseSubject, arrivalTime, sentTime, addressMailbox, searchMessages } = require('../sorting');

/**
 * @help Adds SORT [RFC5256] capability
 *
 * SORT: https://tools.ietf.org/html/rfc5256
 *
 * Additional commands:
 * - SORT
 * - UID SORT
 */
module.exports = function (server) {
    if (server.sortKeys) {
        // already loaded, e.g. by the SORT=DISPLAY plugin
        return;
    }

    server.registerCapability('SORT');

    // RFC 5256 section 3: sort keys and the value of a message for each. A value is a number or the
    // collation key of a string, see sorting.collationKey. SORT=DISPLAY adds its keys here
    server.sortKeys = {
        ARRIVAL: message => arrivalTime(message),
        CC: message => collationKey(addressMailbox(message, 'cc')),
        DATE: message => sentTime(message),
        FROM: message => collationKey(addressMailbox(message, 'from')),
        SIZE: message => getMessageData(message).raw.length,
        SUBJECT: message => collationKey(baseSubject(getMessageData(message).tree.parsedHeader.subject).subject),
        TO: message => collationKey(addressMailbox(message, 'to'))
    };

    const compareValues = (a, b) => (Buffer.isBuffer(a) ? Buffer.compare(a, b) : a - b);

    /**
     * Returns a comparator of messages for parsed sort criteria: ascending order, REVERSE turns one
     * criterion around, and mailbox order (the sequence number) breaks ties (RFC 5256 section 3).
     * Every value is computed once per message. Plugins (ESORT, CONTEXT=SORT) use it to sort again later
     *
     * @param {Array} criteria List of `{ key, reverse }`
     * @return {Function} comparator for two messages of the same mailbox
     */
    server.sortComparator = criteria => {
        const cache = new WeakMap();
        const getValues = message => {
            if (!cache.has(message)) {
                cache.set(
                    message,
                    criteria.map(criterion => server.sortKeys[criterion.key](message))
                );
            }
            return cache.get(message);
        };
        return (a, b) => {
            const aValues = getValues(a);
            const bValues = getValues(b);
            for (let i = 0; i < criteria.length; i++) {
                const diff = compareValues(aValues[i], bValues[i]);
                if (diff) {
                    return criteria[i].reverse ? -diff : diff;
                }
            }
            // messages are kept in UID order, so this is the order of sequence numbers
            return a.uid - b.uid;
        };
    };

    const sortHandler = (isUid, connection, parsed, data, callback) => {
        const command = isUid ? 'UID SORT' : 'SORT';
        const attributes = parsed.attributes || [];

        const fail = text => {
            connection.sendStatus(parsed, data, 'BAD', text, false, command + ' FAILED');
            return callback();
        };

        // RFC 5256 section 5: sort-criteria = "(" sort-criterion *(SP sort-criterion) ")",
        // sort-criterion = ["REVERSE" SP] sort-key
        if (!Array.isArray(attributes[0]) || !attributes[0].length) {
            return fail(command + ' expects a list of sort criteria');
        }
        const criteria = [];
        let reverse = false;
        for (const item of attributes[0]) {
            const key = item && item.type === 'ATOM' ? item.value.toUpperCase() : '';
            if (key === 'REVERSE' && !reverse) {
                reverse = true;
                continue;
            }
            if (!Object.hasOwn(server.sortKeys, key)) {
                return fail('Invalid sort criterion ' + (item && typeof item.value === 'string' ? item.value : ''));
            }
            criteria.push({ key, reverse });
            reverse = false;
        }
        if (reverse) {
            return fail('REVERSE must be followed by a sort key');
        }

        const result = searchMessages(connection, parsed, data, attributes.slice(1));
        if (!result) {
            return callback();
        }

        const compare = server.sortComparator(criteria);
        const sorted = result.list.slice().sort(compare);

        connection.send(
            {
                tag: '*',
                command: 'SORT',
                attributes: sorted.map(message => (isUid ? message.uid : result.numbers[message.uid]))
            },
            command,
            parsed,
            data,
            // the search result, for CONDSTORE to append the highest mod-sequence (RFC 7162 section 3.1.9), with the
            // sorted messages and the comparator for ESORT and CONTEXT=SORT
            Object.assign(result, { sorted, compare })
        );
        connection.sendStatus(parsed, data, 'OK', command + ' completed', false, command);
        return callback();
    };

    // RFC 5256 section 3: EXPUNGE responses are not permitted while responding to SORT, but are during UID SORT.
    // The search criteria start after the sort criteria and the charset
    server.setCommandHandler('SORT', sortHandler.bind(null, false), { states: states.SELECTED, searchCriteria: 2, noExpunge: true });
    server.setCommandHandler('UID SORT', sortHandler.bind(null, true), { states: states.SELECTED, searchCriteria: 2 });
};
