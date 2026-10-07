'use strict';

// Connection states in which each command is valid (RFC 3501 sections 3 and 6, RFC 9051
// section 6). Commands valid in the authenticated state are also valid in the selected state.
const ANY = ['Not Authenticated', 'Authenticated', 'Selected'];
const NOT_AUTHENTICATED = ['Not Authenticated'];
const AUTHENTICATED = ['Authenticated', 'Selected'];
const SELECTED = ['Selected'];

const COMMAND_STATES = {
    CAPABILITY: ANY,
    NOOP: ANY,
    LOGOUT: ANY,
    ID: ANY,

    STARTTLS: NOT_AUTHENTICATED,
    LOGIN: NOT_AUTHENTICATED,

    SELECT: AUTHENTICATED,
    EXAMINE: AUTHENTICATED,
    CREATE: AUTHENTICATED,
    DELETE: AUTHENTICATED,
    RENAME: AUTHENTICATED,
    SUBSCRIBE: AUTHENTICATED,
    UNSUBSCRIBE: AUTHENTICATED,
    LIST: AUTHENTICATED,
    LSUB: AUTHENTICATED,
    STATUS: AUTHENTICATED,
    APPEND: AUTHENTICATED,
    NAMESPACE: AUTHENTICATED,
    ENABLE: AUTHENTICATED,
    IDLE: AUTHENTICATED,
    XTOYBIRD: AUTHENTICATED,

    CHECK: SELECTED,
    CLOSE: SELECTED,
    UNSELECT: SELECTED,
    EXPUNGE: SELECTED,
    SEARCH: SELECTED,
    FETCH: SELECTED,
    STORE: SELECTED,
    COPY: SELECTED,
    MOVE: SELECTED
};

// Commands that take no arguments ("Arguments: none" in RFC 3501, RFC 9051, RFC 2177,
// RFC 2342 and RFC 3691)
const NO_ARGUMENTS = new Set(['CAPABILITY', 'NOOP', 'LOGOUT', 'STARTTLS', 'CHECK', 'CLOSE', 'UNSELECT', 'EXPUNGE', 'NAMESPACE', 'IDLE']);

/**
 * Returns the states a command is valid in
 *
 * @param {String} command Upper case command name, e.g. "UID FETCH"
 * @return {Array|Boolean} List of states or false if the command is not known
 */
function getCommandStates(command) {
    if (Object.hasOwn(COMMAND_STATES, command)) {
        return COMMAND_STATES[command];
    }
    if (/^UID /.test(command)) {
        return SELECTED;
    }
    if (/^AUTHENTICATE /.test(command)) {
        return NOT_AUTHENTICATED;
    }
    return false;
}

// SEARCH keys and the number of arguments they take that are not sequence sets
const SEARCH_KEY_ARGUMENTS = {
    BCC: 1,
    BEFORE: 1,
    BODY: 1,
    CC: 1,
    CHARSET: 1,
    FROM: 1,
    HEADER: 2,
    KEYWORD: 1,
    LARGER: 1,
    ON: 1,
    SENTBEFORE: 1,
    SENTON: 1,
    SENTSINCE: 1,
    SINCE: 1,
    SMALLER: 1,
    SUBJECT: 1,
    TEXT: 1,
    TO: 1,
    UID: 1,
    UNKEYWORD: 1,
    MODSEQ: 1,
    'X-GM-MSGID': 1,
    'X-GM-THRID': 1,
    'X-GM-LABELS': 1,
    'X-GM-RAW': 1
};

/**
 * Checks if a command refers to messages by sequence number (RFC 3501 section 5.5)
 *
 * @param {Object} parsed Parsed command
 * @return {Boolean} true if the command uses message sequence numbers
 */
function usesSequenceNumbers(parsed) {
    const command = (parsed.command || '').toUpperCase();
    if (['FETCH', 'STORE', 'COPY', 'MOVE'].indexOf(command) >= 0) {
        return true;
    }
    if (['SEARCH', 'UID SEARCH'].indexOf(command) < 0) {
        return false;
    }

    let found = false;
    const walk = list => {
        let skip = 0;
        list.forEach(item => {
            if (found) {
                return;
            }
            if (Array.isArray(item)) {
                walk(item);
                return;
            }
            if (skip) {
                skip--;
                return;
            }
            const value = ((item && item.value) || '').toString();
            if (Object.hasOwn(SEARCH_KEY_ARGUMENTS, value.toUpperCase())) {
                skip = SEARCH_KEY_ARGUMENTS[value.toUpperCase()];
            } else if (/^[\d*][\d*,:]*$/.test(value)) {
                found = true;
            }
        });
    };
    walk([].concat(parsed.attributes || []));
    return found;
}

module.exports = { getCommandStates, usesSequenceNumbers, takesNoArguments: command => NO_ARGUMENTS.has(command) };
