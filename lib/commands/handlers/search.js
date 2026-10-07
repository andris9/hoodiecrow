'use strict';

const { isUtf8 } = require('buffer');
const { getMessageData, render } = require('../../mimeparser');
const { monthIndex, isRealDate } = require('../../dates');

// RFC 3501 6.4.4 search keys and their arguments
const searchKeys = {
    ALL: [],
    ANSWERED: [],
    BCC: ['string'],
    BEFORE: ['date'],
    BODY: ['string'],
    CC: ['string'],
    DELETED: [],
    DRAFT: [],
    FLAGGED: [],
    FROM: ['string'],
    HEADER: ['string', 'string'],
    KEYWORD: ['string'],
    LARGER: ['number'],
    NEW: [],
    NOT: ['key'],
    OLD: [],
    ON: ['date'],
    OR: ['key', 'key'],
    RECENT: [],
    SEEN: [],
    SENTBEFORE: ['date'],
    SENTON: ['date'],
    SENTSINCE: ['date'],
    SINCE: ['date'],
    SMALLER: ['number'],
    SUBJECT: ['string'],
    TEXT: ['string'],
    TO: ['string'],
    UID: ['sequence'],
    UNANSWERED: [],
    UNDELETED: [],
    UNDRAFT: [],
    UNFLAGGED: [],
    UNKEYWORD: ['string'],
    UNSEEN: []
};

// Charsets accepted for the CHARSET argument (RFC 3501 6.4.4: US-ASCII must be supported)
const charsets = ['US-ASCII', 'UTF-8'];

/**
 * Creates an error that is reported to the client as BAD
 */
function badError(message) {
    const err = new Error(message);
    err.imapResponse = 'BAD';
    return err;
}

/**
 * Converts day, month name and year to a comparable YYYY-MM-DD string, or false for an impossible date
 */
function toDateKey(day, month, year) {
    day = Number(day);
    month = monthIndex(month);
    year = Number(year);
    if (!isRealDate(day, month, year)) {
        return false;
    }
    return String(year).padStart(4, '0') + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

/**
 * Parses an RFC 3501 date argument (date-day "-" date-month "-" date-year)
 */
function parseQueryDate(value) {
    const match = (value || '').toString().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
    const date = match && toDateKey(match[1], match[2], match[3]);
    if (!date) {
        throw badError('Invalid date argument ' + value);
    }
    return date;
}

/**
 * Date of a date-time value, disregarding time and timezone, as a comparable YYYY-MM-DD string,
 * or false when it can not be parsed
 *
 * @param {String} dateTime Date-time value, e.g. "14-Sep-2013 21:22:28 -0300"
 * @return {String|Boolean} date or false
 */
function getDateKey(dateTime) {
    const match = (dateTime || '').toString().match(/^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
    return (match && toDateKey(match[1], match[2], match[3])) || false;
}

/**
 * Date of the internal date of a message, disregarding time and timezone, or false when it can not be parsed
 */
function getInternalDate(message) {
    return getDateKey(message.internaldate);
}

/**
 * Date of the Date header of a message, disregarding time and timezone. Falls back to the internal date
 */
function getSentDate(message) {
    const header = getMessageData(message).tree.parsedHeader.date;
    // RFC 5322 3.3: [day-of-week ","] day month year, with the obsolete two digit years
    const match = (header || '').toString().match(/(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{2,4})\b/);
    if (match) {
        let year = Number(match[3]);
        if (match[3].length === 2) {
            year += year < 50 ? 2000 : 1900;
        } else if (match[3].length === 3) {
            year += 1900;
        }
        const date = toDateKey(match[1], match[2], year);
        if (date) {
            return date;
        }
    }
    return getInternalDate(message);
}

/**
 * Lower cases ASCII letters only, so that 8-bit octets in binary strings stay intact
 */
function asciiLowerCase(str) {
    return str.replace(/[A-Z]+/g, chars => chars.toLowerCase());
}

/**
 * Checks if a string contains another one, ignoring ASCII case
 *
 * @param {String} haystack String to search in
 * @param {String} needle String to look for, already lower cased with asciiLowerCase
 */
function contains(haystack, needle) {
    return asciiLowerCase(haystack).indexOf(needle) >= 0;
}

/**
 * Returns the search keys with the types of their arguments, including the keys that plugins
 * define in `server.searchHandlers`. If a plugin handler takes more than 3 params
 * (connection, message, index), the remaining ones are its arguments. A plugin handler can
 * describe its arguments instead with an `argumentTypes(list)` method, that gets the criteria
 * following the key and returns the list of types. A type can also be a function that gets the
 * argument value and returns the parsed value, or throws for an invalid one.
 *
 * @param {Object} server IMAP server
 * @return {Object} search key to list of argument types, or to a function that returns the list
 */
function getSearchKeys(server) {
    const keys = Object.assign({}, searchKeys);
    const pluginHandlers = server.searchHandlers;
    Object.keys(pluginHandlers).forEach(key => {
        if (!(key in keys)) {
            const handler = pluginHandlers[key];
            keys[key] = typeof handler.argumentTypes === 'function' ? handler.argumentTypes : new Array(Math.max(handler.length - 3, 0)).fill('string');
        }
    });
    return keys;
}

/**
 * Checks if SEARCH criteria refer to messages by sequence number (RFC 3501 section 5.5), that is,
 * if a sequence set is used as a search key. Arguments of search keys, like the UID set of UID
 * or a string that looks like a number, are not search keys.
 *
 * @param {Object} server IMAP server
 * @param {Array} attributes Parsed SEARCH arguments, nested lists are arrays
 * @return {Boolean} true if a sequence set key occurs
 */
function hasSequenceSetKey(server, attributes) {
    const keys = getSearchKeys(server);
    const walk = list => {
        // arguments of the previous key that are values, not keys
        let skip = 0;
        return list.some((item, i) => {
            if (Array.isArray(item)) {
                return walk(item);
            }
            if (skip) {
                skip--;
                return false;
            }
            const value = ((item && item.value) || '').toString();
            const key = value.toUpperCase();
            if (key === 'CHARSET' && i === 0) {
                skip = 1;
            } else if (Object.hasOwn(keys, key)) {
                // NOT and OR take keys as arguments, these are checked as keys
                let types = keys[key];
                if (typeof types === 'function') {
                    types = types(list.slice(i + 1).map(next => (Array.isArray(next) ? next : ((next && next.value) || '').toString())));
                }
                skip = types.filter(type => type !== 'key').length;
            } else if (/^[\d*][\d*,:]*$/.test(value)) {
                return true;
            }
            return false;
        });
    };
    return walk([].concat(attributes || []));
}

/**
 * Searches messages
 *
 * @param {Object} connection IMAP connection
 * @param {Array} messageSource Messages of the selected mailbox, as the session sees them
 * @param {Array} params Search criteria: strings, and arrays for parenthesized lists
 * @return {Object} `{ list, numbers, keys }`, the matching messages, the sequence numbers by UID
 *         and the set of search keys used in the criteria
 */
module.exports = function (connection, messageSource, params) {
    const numbers = {};
    // search keys used in the criteria, other than sequence sets
    const usedKeys = new Set();
    const keys = getSearchKeys(connection.server);
    const pluginHandlers = connection.server.searchHandlers;

    params = [].concat(params || []);

    // IMAP4rev1 search strings are US-ASCII unless a CHARSET is given (RFC 3501 6.4.4)
    let searchCharset = 'US-ASCII';

    if (typeof params[0] === 'string' && params[0].toUpperCase() === 'CHARSET') {
        params.shift();
        const charset = params.shift();
        if (typeof charset !== 'string') {
            throw badError('CHARSET expects a charset name');
        }
        if (charsets.indexOf(charset.toUpperCase()) < 0) {
            const err = new Error('Unsupported charset ' + charset);
            err.imapResponse = 'NO';
            err.code = 'BADCHARSET';
            err.charsets = charsets;
            throw err;
        }
        searchCharset = charset.toUpperCase();
    }

    // strings must be valid in the declared charset, a client must not send 8-bit text as US-ASCII
    const checkString = (key, value) => {
        if (searchCharset === 'US-ASCII' && /[\u0080-\u00ff]/.test(value)) {
            throw badError(key + ' argument has 8-bit characters, use CHARSET UTF-8');
        }
        if (searchCharset === 'UTF-8' && !isUtf8(Buffer.from(value, 'binary'))) {
            throw badError(key + ' argument is not valid UTF-8');
        }
        return value;
    };

    if (!params.length) {
        throw badError('SEARCH expects search criteria, empty query given');
    }

    // Parses one search key and its arguments from a list of criteria into a node of the query tree
    const parseKey = list => {
        if (!list.length) {
            throw badError('Unexpected end of search criteria');
        }

        const param = list.shift();

        if (Array.isArray(param)) {
            // a parenthesized list of keys that all must match
            return { key: 'AND', args: parseList([].concat(param)) };
        }

        const key = param.toUpperCase();

        if (!Object.prototype.hasOwnProperty.call(keys, key)) {
            // a sequence set, plugins may support other forms of it than numbers
            let range;
            try {
                range = connection.getMessageRange(param, false);
            } catch (E) {
                throw /^[\d,:*]+$/.test(param) ? E : badError('Invalid search key ' + param);
            }
            return { key: '_SEQ', args: [range] };
        }

        usedKeys.add(key);
        const types = typeof keys[key] === 'function' ? keys[key](list) : keys[key];
        const args = types.map(type => {
            if (type === 'key') {
                return parseKey(list);
            }

            if (!list.length || typeof list[0] !== 'string') {
                throw badError(key + ' expects ' + types.length + ' argument' + (types.length > 1 ? 's' : ''));
            }

            const value = list.shift();
            if (typeof type === 'function') {
                return type(value);
            }
            switch (type) {
                case 'date':
                    return parseQueryDate(value);
                case 'number':
                    if (!/^\d+$/.test(value)) {
                        throw badError(key + ' expects a number');
                    }
                    return Number(value);
                case 'sequence':
                    return connection.getMessageRange(value, true);
                default:
                    return checkString(key, value);
            }
        });

        return { key, args };
    };

    const parseList = list => {
        if (!list.length) {
            throw badError('Empty search criteria list');
        }
        const nodes = [];
        while (list.length) {
            nodes.push(parseKey(list));
        }
        return nodes;
    };

    const query = { key: 'AND', args: parseList(params) };

    // a sequence set argument resolves to [number, message] pairs, turn these into a lookup set
    const toMessageSet = range => new Set(range.map(item => item[1]));
    const prepare = node => {
        if (node.key === '_SEQ' || node.key === 'UID') {
            node.set = toMessageSet(node.args[0]);
        }
        // lower case the string to look for once, not for every message
        if (['BCC', 'BODY', 'CC', 'FROM', 'SUBJECT', 'TEXT', 'TO'].indexOf(node.key) >= 0) {
            node.needle = asciiLowerCase(node.args[0]);
        } else if (node.key === 'HEADER') {
            node.needle = asciiLowerCase(node.args[1]);
        }
        node.args.forEach(arg => {
            if (arg && typeof arg === 'object' && arg.key) {
                prepare(arg);
            }
        });
    };
    prepare(query);

    const hasFlag = (message, flag) => message.flags.indexOf(flag) >= 0;

    // header lines as [lowercase name, unfolded value]
    const getHeaders = message =>
        (getMessageData(message).tree.header || []).map(line => {
            const parts = line.split(':');
            return [(parts.shift() || '').trim().toLowerCase(), parts.join(':').replace(/\r?\n(?=[ \t])/g, '')];
        });

    const matchHeader = (message, name, needle) => {
        name = name.toLowerCase();
        return getHeaders(message).some(header => header[0] === name && contains(header[1], needle));
    };

    const matches = (node, message, index) => {
        const args = node.args;
        if (Object.prototype.hasOwnProperty.call(pluginHandlers, node.key)) {
            // plugin defined search key, which may also override a built-in one
            return !!pluginHandlers[node.key].apply(null, [connection, message, index].concat(args));
        }
        switch (node.key) {
            case 'AND':
                return args.every(arg => matches(arg, message, index));
            case '_SEQ':
            case 'UID':
                return node.set.has(message);
            case 'ALL':
                return true;
            case 'ANSWERED':
                return hasFlag(message, '\\Answered');
            case 'BCC':
            case 'CC':
            case 'FROM':
            case 'SUBJECT':
            case 'TO':
                return matchHeader(message, node.key, node.needle);
            case 'HEADER':
                return matchHeader(message, args[0], node.needle);
            case 'BEFORE': {
                const date = getInternalDate(message);
                return !!date && date < args[0];
            }
            case 'ON':
                return getInternalDate(message) === args[0];
            case 'SINCE': {
                const date = getInternalDate(message);
                return !!date && date >= args[0];
            }
            case 'SENTBEFORE': {
                const date = getSentDate(message);
                return !!date && date < args[0];
            }
            case 'SENTON':
                return getSentDate(message) === args[0];
            case 'SENTSINCE': {
                const date = getSentDate(message);
                return !!date && date >= args[0];
            }
            case 'BODY':
                return contains(render(getMessageData(message).tree, true), node.needle);
            case 'TEXT':
                return contains(getMessageData(message).raw, node.needle);
            case 'DELETED':
                return hasFlag(message, '\\Deleted');
            case 'DRAFT':
                return hasFlag(message, '\\Draft');
            case 'FLAGGED':
                return hasFlag(message, '\\Flagged');
            case 'KEYWORD':
                return hasFlag(message, args[0]);
            case 'LARGER':
                return getMessageData(message).raw.length > args[0];
            case 'SMALLER':
                return getMessageData(message).raw.length < args[0];
            // \Recent is a session flag, see IMAPConnection#isRecent
            case 'NEW':
                return connection.isRecent(message) && !hasFlag(message, '\\Seen');
            case 'OLD':
                return !connection.isRecent(message);
            case 'RECENT':
                return connection.isRecent(message);
            case 'SEEN':
                return hasFlag(message, '\\Seen');
            case 'NOT':
                return !matches(args[0], message, index);
            case 'OR':
                return matches(args[0], message, index) || matches(args[1], message, index);
            case 'UNANSWERED':
                return !hasFlag(message, '\\Answered');
            case 'UNDELETED':
                return !hasFlag(message, '\\Deleted');
            case 'UNDRAFT':
                return !hasFlag(message, '\\Draft');
            case 'UNFLAGGED':
                return !hasFlag(message, '\\Flagged');
            case 'UNKEYWORD':
                return !hasFlag(message, args[0]);
            case 'UNSEEN':
                return !hasFlag(message, '\\Seen');
            default:
                return false;
        }
    };

    const list = [];
    messageSource.forEach((message, i) => {
        if (matches(query, message, i + 1)) {
            numbers[message.uid] = i + 1;
            list.push(message);
        }
    });

    return {
        list,
        numbers,
        keys: usedKeys
    };
};

module.exports.hasSequenceSetKey = hasSequenceSetKey;
module.exports.getDateKey = getDateKey;
module.exports.badError = badError;
