'use strict';

const { isUtf8 } = require('buffer');
const { getMessageData, render } = require('../../mimeparser');
const { monthIndex, dateKey, parseDateTime, parseHeaderDate } = require('../../dates');
const { MAX_NUMBER, MAX_NUMBER64, isNumber } = require('../../numbers');
const { decodeHeader, decodeUtf8 } = require('../../encoded-words');

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
    LARGER: ['number64'],
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
    SMALLER: ['number64'],
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
 * Parses an RFC 3501 date argument (date-day "-" date-month "-" date-year) to a comparable YYYY-MM-DD string
 */
function parseQueryDate(value) {
    const match = (value || '').toString().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
    const date = match && dateKey(Number(match[1]), monthIndex(match[2]), Number(match[3]));
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
    const date = parseDateTime(dateTime);
    return date ? dateKey(date.day, date.month, date.year) : false;
}

/**
 * Date of the internal date of a message, disregarding time and timezone, or false when it can not be parsed
 */
function getInternalDate(message) {
    return getDateKey(message.internaldate);
}

/**
 * Date of the Date header of a message, disregarding time and timezone (RFC 3501 section 6.4.4, unlike the
 * sent date of SORT it is not adjusted to UTC). Falls back to the internal date
 */
function getSentDate(message) {
    const date = parseHeaderDate(getMessageData(message).tree.parsedHeader.date);
    return date ? dateKey(date.day, date.month, date.year) : getInternalDate(message);
}

/**
 * Converts the parsed search criteria of a command to the values the search takes, parenthesized lists stay nested
 *
 * @param {Array} attributes Parsed arguments
 * @return {Array} values
 * @throws {Error} BAD error for an argument that can not be a search key or its value
 */
function criteriaValues(attributes) {
    const convert = (argument, i) => {
        if (Array.isArray(argument)) {
            return argument.map(convert);
        }
        if (!argument || ['STRING', 'ATOM', 'LITERAL', 'SEQUENCE'].indexOf(argument.type) < 0) {
            throw badError('Invalid search criteria argument #' + (i + 1));
        }
        return argument.value;
    };
    return attributes.map(convert);
}

/**
 * Answers a failed search with NO, or BAD for `err.imapResponse` "BAD": the BADCHARSET response code with the
 * supported charsets (RFC 3501 section 7.1, RFC 5256 section 3), or the response code a search limit set
 * (`err.responseCode`), and the text
 *
 * @param {Object} connection IMAP connection
 * @param {Object} parsed Parsed command
 * @param {String} data Raw command
 * @param {Error} err Search error
 * @param {String} description Description for output handlers
 */
function sendSearchError(connection, parsed, data, err, description) {
    const attributes = [];
    if (err.code === 'BADCHARSET') {
        attributes.push({
            type: 'SECTION',
            section: [{ type: 'ATOM', value: 'BADCHARSET' }, err.charsets.map(value => ({ type: 'ATOM', value }))]
        });
    } else if (err.responseCode) {
        attributes.push({ type: 'SECTION', section: err.responseCode.map(value => ({ type: 'ATOM', value: String(value) })) });
    }
    attributes.push({ type: 'TEXT', value: err.message });
    connection.send({ tag: parsed.tag, command: err.imapResponse === 'BAD' ? 'BAD' : 'NO', attributes }, description, parsed, data);
}

/**
 * Lower cases ASCII letters only, so that 8-bit octets in binary strings stay intact. RFC 9051
 * section 6.4.4 asks for case insensitive matching only within the ASCII range
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
 * Searches messages. Errors thrown for the client are answered with BAD when `imapResponse` is "BAD",
 * otherwise NO. SORT and THREAD send `responseCode` (a list of atoms) as the response code
 *
 * @param {Object} connection IMAP connection
 * @param {Array} messageSource Messages of the selected mailbox, as the session sees them
 * @param {Array} params Search criteria: strings, and arrays for parenthesized lists
 * @param {Function} [getMessageRange] Resolves the sequence sets of the criteria, `(range, isUid)`, defaults to
 *        the selected mailbox of the connection. Used to search a mailbox that is not selected
 * @return {Object} `{ list, numbers, keys, matches }`, the matching messages, the sequence numbers by UID,
 *         the set of search keys used in the criteria and a `matches(message, index)` function that checks
 *         a message against the same criteria later. Sequence sets in the criteria stay as they were resolved
 *         now, they are not evaluated again
 */
module.exports = function (connection, messageSource, params, getMessageRange) {
    const resolveRange = getMessageRange || ((range, isUid) => connection.getMessageRange(range, isUid));
    const numbers = {};
    // search keys used in the criteria, other than sequence sets
    const usedKeys = new Set();
    const keys = getSearchKeys(connection.server);
    const pluginHandlers = connection.server.searchHandlers;

    params = [].concat(params || []);

    // IMAP4rev1 search strings are US-ASCII unless a CHARSET is given (RFC 3501 6.4.4). A plugin can
    // fix the charset of a session with connection.searchCharset, e.g. UTF-8 after ENABLE UTF8=ACCEPT,
    // or change the default with connection.defaultSearchCharset (IMAP4rev2 assumes UTF-8, RFC 9051 6.4.4)
    let searchCharset = connection.searchCharset || connection.defaultSearchCharset || 'US-ASCII';

    if (typeof params[0] === 'string' && params[0].toUpperCase() === 'CHARSET') {
        if (connection.searchCharset) {
            // RFC 9755 section 3: a CHARSET conflicts with the charset of the session
            throw badError('CHARSET is not allowed, search strings are always ' + connection.searchCharset + ' in this session');
        }
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

        // a plugin can remove keys from a session, e.g. NEW, OLD and RECENT are not in the IMAP4rev2 grammar
        if (!Object.prototype.hasOwnProperty.call(keys, key) || (connection.disabledSearchKeys && connection.disabledSearchKeys.has(key))) {
            // a sequence set, plugins may support other forms of it than numbers
            let range;
            try {
                range = resolveRange(param, false);
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
                case 'number64': {
                    // RFC 3501 section 9: number is 32-bit. LARGER and SMALLER take a number64 in IMAP4rev2 (RFC 9051
                    // section 9), so in a session with connection.number64 set
                    const number64 = type === 'number64' && connection.number64;
                    if (!isNumber(value, number64 ? MAX_NUMBER64 : MAX_NUMBER)) {
                        throw badError(key + ' expects a number' + (number64 ? '64' : ''));
                    }
                    return Number(value);
                }
                case 'sequence':
                    return resolveRange(value, true);
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
        // lower case the string to look for once, not for every message. Header values are compared
        // as Unicode text after decoding their encoded words, so the UTF-8 octets of the string are
        // decoded too (RFC 9051 section 6.4.4)
        if (['BODY', 'TEXT'].indexOf(node.key) >= 0) {
            node.needle = asciiLowerCase(node.args[0]);
        } else if (['BCC', 'CC', 'FROM', 'HEADER', 'SUBJECT', 'TO'].indexOf(node.key) >= 0) {
            node.needle = asciiLowerCase(decodeUtf8(node.args[node.key === 'HEADER' ? 1 : 0]));
        }
        node.args.forEach(arg => {
            if (arg && typeof arg === 'object' && arg.key) {
                prepare(arg);
            }
        });
    };
    prepare(query);

    const hasFlag = (message, flag) => message.flags.indexOf(flag) >= 0;

    // compares the unfolded values of the header lines with that name, after decoding their encoded
    // words. RFC 3501 and RFC 9051 section 6.4.4: [MIME-HDRS] strings in headers MUST be decoded before comparing text
    const matchHeader = (message, name, needle) => {
        name = name.toLowerCase();
        return (getMessageData(message).tree.header || []).some(line => {
            const colon = line.indexOf(':');
            const lineName = (colon < 0 ? line : line.substr(0, colon)).trim().toLowerCase();
            const value = colon < 0 ? '' : line.substr(colon + 1).replace(/\r?\n(?=[ \t])/g, '');
            return lineName === name && contains(decodeHeader(value), needle);
        });
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

    // plugins can narrow down the messages that are looked at (server.searchLimits), sequence numbers stay as they are
    const searched = connection.server.searchLimits.reduce((messages, limit) => limit(connection, messages, query) || messages, messageSource);
    const searchedSet = searched !== messageSource && new Set(searched);

    const list = [];
    messageSource.forEach((message, i) => {
        if (searchedSet && !searchedSet.has(message)) {
            return;
        }
        if (matches(query, message, i + 1)) {
            numbers[message.uid] = i + 1;
            list.push(message);
        }
    });

    return {
        list,
        numbers,
        keys: usedKeys,
        matches: (message, index) => matches(query, message, index)
    };
};

module.exports.hasSequenceSetKey = hasSequenceSetKey;
module.exports.getDateKey = getDateKey;
module.exports.badError = badError;
module.exports.criteriaValues = criteriaValues;
module.exports.sendSearchError = sendSearchError;
