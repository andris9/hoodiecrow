'use strict';

// Connection states in which each command is valid (RFC 3501 sections 3 and 6). Commands valid
// in the authenticated state are also valid in the selected state.
const ANY = ['Not Authenticated', 'Authenticated', 'Selected'];
const NOT_AUTHENTICATED = ['Not Authenticated'];
const AUTHENTICATED = ['Authenticated', 'Selected'];
const SELECTED = ['Selected'];

/**
 * Normalizes command options
 *
 * @param {Object|Array} options `{ states, noArguments, mailboxArguments, searchCriteria, noExpunge }`, or just the list of states
 * @return {Object} options with all keys set
 */
function commandOptions(options) {
    if (Array.isArray(options)) {
        options = { states: options };
    }
    options = options || {};
    return {
        // false means any state
        states: options.states ? [].concat(options.states) : false,
        // "Arguments: none" in the command description
        noArguments: !!options.noArguments,
        // positions of the arguments that are mailbox names, checked against RFC 3501 section 5.1.3
        mailboxArguments: [].concat(options.mailboxArguments || []),
        // position of the first search key argument, for commands that take search criteria (RFC 3501 section 6.4.4)
        searchCriteria: typeof options.searchCriteria === 'number' ? options.searchCriteria : false,
        // EXPUNGE responses must not be sent while the command runs, so a client does not have to wait for its
        // completion before sending a command with sequence numbers (RFC 3501 sections 5.5 and 7.4.1)
        noExpunge: !!options.noExpunge
    };
}

// RFC 3501 core commands. Plugins pass the options of their commands to setCommandHandler
const CORE_COMMANDS = {
    CAPABILITY: commandOptions({ states: ANY, noArguments: true }),
    NOOP: commandOptions({ states: ANY, noArguments: true }),
    LOGOUT: commandOptions({ states: ANY, noArguments: true }),

    STARTTLS: commandOptions({ states: NOT_AUTHENTICATED, noArguments: true }),
    LOGIN: commandOptions({ states: NOT_AUTHENTICATED }),

    SELECT: commandOptions({ states: AUTHENTICATED, mailboxArguments: [0] }),
    EXAMINE: commandOptions({ states: AUTHENTICATED, mailboxArguments: [0] }),
    CREATE: commandOptions({ states: AUTHENTICATED, mailboxArguments: [0] }),
    DELETE: commandOptions({ states: AUTHENTICATED, mailboxArguments: [0] }),
    RENAME: commandOptions({ states: AUTHENTICATED, mailboxArguments: [0, 1] }),
    SUBSCRIBE: commandOptions({ states: AUTHENTICATED, mailboxArguments: [0] }),
    UNSUBSCRIBE: commandOptions({ states: AUTHENTICATED, mailboxArguments: [0] }),
    LIST: commandOptions({ states: AUTHENTICATED }),
    LSUB: commandOptions({ states: AUTHENTICATED }),
    STATUS: commandOptions({ states: AUTHENTICATED, mailboxArguments: [0] }),
    APPEND: commandOptions({ states: AUTHENTICATED, mailboxArguments: [0] }),

    CHECK: commandOptions({ states: SELECTED, noArguments: true }),
    CLOSE: commandOptions({ states: SELECTED, noArguments: true }),
    EXPUNGE: commandOptions({ states: SELECTED, noArguments: true }),
    SEARCH: commandOptions({ states: SELECTED, searchCriteria: 0, noExpunge: true }),
    FETCH: commandOptions({ states: SELECTED, noExpunge: true }),
    STORE: commandOptions({ states: SELECTED, noExpunge: true }),
    COPY: commandOptions({ states: SELECTED, mailboxArguments: [1] }),
    'UID COPY': commandOptions({ states: SELECTED, mailboxArguments: [1] }),
    'UID SEARCH': commandOptions({ states: SELECTED, searchCriteria: 0 })
};

const UID_COMMAND = commandOptions({ states: SELECTED });
const AUTHENTICATE_COMMAND = commandOptions({ states: NOT_AUTHENTICATED });

/**
 * Returns the options of a core command
 *
 * @param {String} command Upper case command name, e.g. "UID FETCH"
 * @return {Object|Boolean} `{ states, noArguments, mailboxArguments, searchCriteria, noExpunge }` or false if the command is not a core command
 */
function getCommandOptions(command) {
    if (Object.hasOwn(CORE_COMMANDS, command)) {
        return CORE_COMMANDS[command];
    }
    if (/^UID /.test(command)) {
        return UID_COMMAND;
    }
    if (/^AUTHENTICATE /.test(command)) {
        return AUTHENTICATE_COMMAND;
    }
    return false;
}

module.exports = { getCommandOptions, commandOptions, states: { ANY, NOT_AUTHENTICATED, AUTHENTICATED, SELECTED } };
