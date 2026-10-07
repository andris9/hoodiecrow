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

module.exports = { getCommandStates, takesNoArguments: command => NO_ARGUMENTS.has(command) };
