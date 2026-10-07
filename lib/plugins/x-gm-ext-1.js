'use strict';

const search = require('../commands/handlers/search');
const { MONTHS, isRealDate } = require('../dates');

const { badError } = search;

// X-GM-MSGID is a 64 bit unsigned number, so it is tracked as a BigInt

// Sample value from Gmail IMAP extensions API page
// https://developers.google.com/workspace/gmail/imap/imap-extensions
// Used as default, if server.options["HIGHESTX-GM-MSGID"]
// is missing
const SEED = '1278455344230334865';

const MAX_UINT64 = 2n ** 64n - 1n;

// X-GM-RAW mailbox shortcuts of in: and is: (Gmail search operators), as hoodiecrow criteria
const RAW_SHORTCUTS = {
    'in:inbox': ['X-GM-LABELS', '\\Inbox'],
    'in:sent': ['X-GM-LABELS', '\\Sent'],
    'in:drafts': ['X-GM-LABELS', '\\Drafts'],
    'in:trash': ['X-GM-LABELS', '\\Trash'],
    'in:spam': ['X-GM-LABELS', '\\Junk'],
    'in:anywhere': ['ALL'],
    'is:unread': ['UNSEEN'],
    'is:read': ['SEEN'],
    'is:starred': ['FLAGGED'],
    'is:important': ['X-GM-LABELS', '\\Important']
};

// X-GM-RAW operators that take a value, as the search key the value is given to
const RAW_OPERATORS = {
    from: 'FROM',
    to: 'TO',
    cc: 'CC',
    bcc: 'BCC',
    subject: 'SUBJECT',
    label: 'X-GM-LABELS',
    larger: 'LARGER',
    smaller: 'SMALLER',
    after: 'SINCE',
    before: 'BEFORE',
    rfc822msgid: 'HEADER'
};

// Gmail operators that hoodiecrow does not implement, answered with NO instead of a wrong result
const RAW_UNSUPPORTED = ['is', 'has', 'list', 'filename', 'around', 'size', 'older', 'newer', 'older_than', 'newer_than', 'deliveredto', 'category'];

/**
 * @help Adds Gmail specific X-GM-EXT-1 capability
 * @help (https://developers.google.com/workspace/gmail/imap/imap-extensions)
 * @help   X-GM-MSGID and X-GM-THRID: FETCH and SEARCH. X-GM-THRID is the
 * @help       X-GM-MSGID of the message unless storage sets an X-GM-THRID
 * @help       value, so every message is its own thread unless the
 * @help       fixture groups messages
 * @help   X-GM-LABELS: FETCH, STORE (+/-, .SILENT) and SEARCH. System
 * @help       labels are atoms that start with "\" (\Inbox for INBOX, the
 * @help       special-use attribute for special-use mailboxes), other labels
 * @help       are mailbox names, sent like mailbox names (modified UTF-7, or
 * @help       UTF-8 after ENABLE UTF8=ACCEPT, quoted when not atoms). Labels
 * @help       have no side effects: the message is not copied to or removed
 * @help       from other mailboxes. In SEARCH a label that starts with "\"
 * @help       is a system label
 * @help   X-GM-RAW: a subset of the Gmail search syntax. Words and "quoted
 * @help       phrases" (TEXT), -term, OR, (groups), {any of}, from: to: cc:
 * @help       bcc: subject: label: in: (inbox sent drafts trash spam
 * @help       anywhere, or a label) is: (read unread starred important)
 * @help       larger: smaller: (k and m suffixes) after: before:
 * @help       (YYYY/MM/DD) and rfc822msgid:. Other Gmail operators are
 * @help       answered with NO
 */

module.exports = function (server) {
    server.registerCapability('X-GM-EXT-1');

    server['HIGHESTX-GM-MSGID'] = BigInt(server.options['HIGHESTX-GM-MSGID'] || SEED);

    // set X-GM-MSGID values when message is created / initialized
    server.messageHandlers.push((connection, message, mailbox) => {
        let labels;

        if (!message['X-GM-MSGID']) {
            server['HIGHESTX-GM-MSGID'] += 1n;
            message['X-GM-MSGID'] = server['HIGHESTX-GM-MSGID'].toString();
        } else if (/^\d+$/.test(message['X-GM-MSGID']) && BigInt(message['X-GM-MSGID']) > server['HIGHESTX-GM-MSGID']) {
            // Storage might be shared with another server instance, do not reuse existing values
            server['HIGHESTX-GM-MSGID'] = BigInt(message['X-GM-MSGID']);
        }

        // A message starts its own thread unless storage puts it into one
        if (!message['X-GM-THRID']) {
            message['X-GM-THRID'] = message['X-GM-MSGID'];
        }

        // Ensure message has an array of labels
        message['X-GM-LABELS'] = [].concat(message['X-GM-LABELS'] || []);

        if (mailbox.path.toUpperCase() === 'INBOX') {
            labels = ['\\Inbox'];
        } else if (mailbox['special-use'] && mailbox['special-use'].length) {
            labels = [].concat(mailbox['special-use']);
        } else {
            labels = [userLabel(mailbox.path)];
        }

        labels.forEach(label => {
            server.ensureFlag(message['X-GM-LABELS'], label);
        });
    });

    // Retrieve X-GM-MSGID values with FETCH
    server.fetchHandlers['X-GM-MSGID'] = function (connection, message) {
        return {
            type: 'ATOM',
            value: message['X-GM-MSGID']
        };
    };

    // Retrieve X-GM-LABELS values with FETCH
    server.fetchHandlers['X-GM-LABELS'] = function (connection, message) {
        return formatLabels(message);
    };

    // X-GM-MSGID and X-GM-THRID are 64 bit unsigned numbers
    const idArgument = () => [
        value => {
            if (!/^\d{1,20}$/.test(value) || BigInt(value) > MAX_UINT64) {
                throw badError('Expected a 64 bit unsigned number');
            }
            return BigInt(value).toString();
        }
    ];

    server.searchHandlers['X-GM-MSGID'] = function (connection, message, sequence, xGmMsgid) {
        return message['X-GM-MSGID'] === xGmMsgid;
    };
    server.searchHandlers['X-GM-MSGID'].argumentTypes = idArgument;

    // Retrieve X-GM-THRID values with FETCH
    server.fetchHandlers['X-GM-THRID'] = function (connection, message) {
        return {
            type: 'ATOM',
            value: message['X-GM-THRID']
        };
    };

    server.searchHandlers['X-GM-THRID'] = function (connection, message, sequence, xGmThrid) {
        return message['X-GM-THRID'] === xGmThrid;
    };
    server.searchHandlers['X-GM-THRID'].argumentTypes = idArgument;

    // SEARCH X-GM-LABELS label, the label is given in the form the session uses for mailbox names
    server.searchHandlers['X-GM-LABELS'] = function (connection, message, sequence, label) {
        return message['X-GM-LABELS'].some(stored => {
            if (isSystemLabel(stored)) {
                // system labels are matched without case, like flags
                return stored.toLowerCase() === label.toLowerCase();
            }
            return connection.exportMailboxName(labelName(stored)) === label;
        });
    };

    // SEARCH X-GM-RAW query, a subset of the Gmail search syntax
    server.searchHandlers['X-GM-RAW'] = function (connection, message, sequence, criteria) {
        // without UTF8=ACCEPT the translated criteria take a CHARSET, Gmail queries are UTF-8
        const params = connection.searchCharset ? criteria : ['CHARSET', 'UTF-8'].concat(criteria);
        return search(connection, [message], params, () => []).matches(message, sequence);
    };
    server.searchHandlers['X-GM-RAW'].argumentTypes = () => [parseRawQuery];

    const setLabels = (message, labels) => {
        message['X-GM-LABELS'] = [];
        addLabels(message, labels);
    };

    const addLabels = (message, labels) => {
        labels.forEach(label => server.ensureFlag(message['X-GM-LABELS'], label));
    };

    const removeLabels = (message, labels) => {
        labels.forEach(label => server.removeFlag(message['X-GM-LABELS'], label));
    };

    [
        ['X-GM-LABELS', setLabels],
        ['+X-GM-LABELS', addLabels],
        ['-X-GM-LABELS', removeLabels]
    ].forEach(([name, update]) => {
        // all labels are parsed before any message changes, an invalid one fails the whole STORE
        server.storeHandlers[name] = function (connection, message, flags, index, parsed, data) {
            update(
                message,
                flags.map(flag => parseLabel(connection, flag))
            );
            sendLabelUpdate(connection, parsed, data, index, message);
        };

        server.storeHandlers[name + '.SILENT'] = function (connection, message, flags) {
            update(
                message,
                flags.map(flag => parseLabel(connection, flag))
            );
        };
    });

    // Gmail keeps the same X-GM-MSGID for a message in every mailbox, so copies get the value of the source message
    server.copyHandlers.push((server, source, copy) => {
        if (source['X-GM-MSGID']) {
            copy['X-GM-MSGID'] = source['X-GM-MSGID'];
            copy['X-GM-THRID'] = source['X-GM-THRID'];
        }
    });
};

/**
 * Labels are kept as strings in message["X-GM-LABELS"]. A system label like \Inbox starts with "\",
 * any other label is a mailbox name in storage form. A mailbox name that itself starts with "\" is
 * kept with one more "\" in front, so it can not be mistaken for a system label
 */
const isSystemLabel = label => label.charAt(0) === '\\' && label.charAt(1) !== '\\';
const userLabel = name => (name.charAt(0) === '\\' ? '\\' + name : name);
const labelName = label => (label.charAt(0) === '\\' ? label.substr(1) : label);

/**
 * Converts a STORE X-GM-LABELS value to a stored label. An atom that starts with "\" is a system
 * label, anything else is a label name: an astring in the form the session uses for mailbox names
 *
 * @param {Object} connection IMAP connection
 * @param {Object} attr Parsed value
 * @return {String} Stored label
 */
function parseLabel(connection, attr) {
    const value = String((attr && attr.value) || '');
    if (attr.type === 'ATOM' && value.charAt(0) === '\\') {
        return value;
    }
    return userLabel(connection.importMailboxName(value));
}

/**
 * Formats the labels of a message for a FETCH response. Label names are MAILBOX attributes, so the
 * session gets them in its own form and quoted when they are not atoms
 */
function formatLabels(message) {
    return message['X-GM-LABELS'].map(label => (isSystemLabel(label) ? { type: 'ATOM', value: label } : { type: 'MAILBOX', value: labelName(label) }));
}

/**
 * Translates an X-GM-RAW query (Gmail search syntax) to hoodiecrow search criteria. Terms are
 * ANDed, OR binds tighter than that ("a b OR c" is a AND (b OR c)), "-" negates a term, ( ) groups
 * terms and { } matches any of its terms.
 *
 * @param {String} query Query as a binary string, UTF-8
 * @return {Array} Search criteria
 * @throws {Error} BAD for a query that can not be parsed, NO for an unsupported operator
 */
function parseRawQuery(query) {
    const tokens = [];
    const re = /\s*(?:([(){}])|"([^"]*)"|([^\s(){}"]+?:)"([^"]*)"|([^\s(){}"]+))/gy;
    let match;
    while (re.lastIndex < query.length && (match = re.exec(query))) {
        if (match[1]) {
            tokens.push({ type: match[1] });
        } else if (typeof match[2] === 'string') {
            tokens.push({ type: 'word', value: match[2] });
        } else if (match[3]) {
            tokens.push({ type: 'word', value: match[3] + match[4], operator: match[3].slice(0, -1), operand: match[4] });
        } else {
            tokens.push({ type: 'word', value: match[5] });
        }
    }
    if (re.lastIndex < query.length && query.slice(re.lastIndex).trim()) {
        throw badError('X-GM-RAW query has an unterminated quoted string');
    }

    let pos = 0;
    const peek = () => tokens[pos];

    // expression = 1*term, until the end or a closing bracket
    const expression = end => {
        const terms = [];
        while (pos < tokens.length && (!peek() || peek().type !== end)) {
            terms.push(term());
        }
        if (end) {
            if (!peek() || peek().type !== end) {
                throw badError('X-GM-RAW query is missing "' + end + '"');
            }
            pos++;
        }
        if (!terms.length) {
            throw badError('X-GM-RAW query is empty');
        }
        return terms.length === 1 ? terms[0] : terms;
    };

    // term = unary *("OR" unary)
    const term = () => {
        let result = unary();
        while (peek() && peek().type === 'word' && peek().value === 'OR' && tokens[pos + 1]) {
            pos++;
            result = ['OR', result, unary()];
        }
        return result;
    };

    const unary = () => {
        const token = tokens[pos++];
        if (!token || token.type === ')' || token.type === '}') {
            throw badError('Unexpected end of X-GM-RAW query');
        }
        if (token.type === '(') {
            return expression(')');
        }
        if (token.type === '{') {
            const options = [];
            while (peek() && peek().type !== '}') {
                options.push(unary());
            }
            if (!peek() || !options.length) {
                throw badError('X-GM-RAW query has an empty or unterminated { } group');
            }
            pos++;
            return options.reduce((any, option) => ['OR', any, option]);
        }
        if (token.value === '-' && peek() && (peek().type === '(' || peek().type === '{')) {
            return ['NOT', unary()];
        }
        if (token.value.charAt(0) === '-' && token.value.length > 1) {
            tokens[--pos] = Object.assign({}, token, rawWord(token.value.substr(1)));
            return ['NOT', unary()];
        }
        return rawTerm(token);
    };

    return [expression()];
}

// splits "name:value" into an operator and an operand
function rawWord(value) {
    const match = value.match(/^([a-z_0-9]+):(.+)$/i);
    return match ? { value, operator: match[1], operand: match[2] } : { value, operator: false, operand: false };
}

function rawTerm(token) {
    const { operator, operand } = token.operator ? token : rawWord(token.value);
    if (!operator) {
        return ['TEXT', token.value];
    }

    const name = operator.toLowerCase();
    const shortcut = RAW_SHORTCUTS[name + ':' + operand.toLowerCase()];
    if (shortcut) {
        return shortcut;
    }

    const key = RAW_OPERATORS[name];
    if (key) {
        switch (key) {
            case 'LARGER':
            case 'SMALLER': {
                const size = operand.match(/^(\d+)([km]?)$/i);
                if (!size) {
                    throw badError('X-GM-RAW ' + name + ': expects a size');
                }
                return [key, String(Number(size[1]) * { '': 1, k: 1024, m: 1024 * 1024 }[size[2].toLowerCase()])];
            }
            case 'SINCE':
            case 'BEFORE': {
                const date = operand.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
                if (!date || !isRealDate(Number(date[3]), Number(date[2]) - 1, Number(date[1]))) {
                    throw badError('X-GM-RAW ' + name + ': expects a date as YYYY/MM/DD');
                }
                return [key, Number(date[3]) + '-' + MONTHS[Number(date[2]) - 1] + '-' + date[1]];
            }
            case 'HEADER':
                return [key, 'Message-ID', operand];
            default:
                return [key, operand];
        }
    }

    if (name === 'in') {
        // any other mailbox is a label
        return ['X-GM-LABELS', operand];
    }

    if (RAW_UNSUPPORTED.indexOf(name) >= 0) {
        const err = new Error('X-GM-RAW operator ' + name + ':' + operand + ' is not supported by hoodiecrow');
        err.imapResponse = 'NO';
        throw err;
    }

    // not an operator, like "http://example.com"
    return ['TEXT', token.value];
}

function sendLabelUpdate(connection, parsed, data, index, message) {
    const resp = [
        {
            type: 'ATOM',
            value: 'X-GM-LABELS'
        },
        formatLabels(message)
    ];

    if ((parsed.command || '').toUpperCase() === 'UID STORE') {
        resp.push({
            type: 'ATOM',
            value: 'UID'
        });
        resp.push(message.uid);
    }

    connection.send(
        {
            tag: '*',
            attributes: [
                index,
                {
                    type: 'ATOM',
                    value: 'FETCH'
                },
                resp
            ]
        },
        'FLAG UPDATE',
        parsed,
        data,
        message
    );
}
