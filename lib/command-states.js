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
 * @param {Object|Array} options `{ states, noArguments, mailboxArguments, astringArguments, searchCriteria, sequenceSet, noExpunge,
 *   literal8, noPipelining }`, or just the list of states
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
        // positions of other arguments that are astrings (RFC 3501 section 9), like user names. In these, in the mailbox
        // name arguments and in search criteria a NIL atom is a string, not the nil of an nstring
        astringArguments: [].concat(options.astringArguments || []),
        // position of the first search key argument, for commands that take search criteria (RFC 3501 section 6.4.4)
        searchCriteria: typeof options.searchCriteria === 'number' ? options.searchCriteria : false,
        // position of the argument that holds message sequence numbers (a sequence set or a seq-number, not UIDs), for
        // the RFC 3501 section 5.5 ambiguity check and for UIDONLY (RFC 9586 section 3)
        sequenceSet: typeof options.sequenceSet === 'number' ? options.sequenceSet : false,
        // EXPUNGE responses must not be sent while the command runs, so a client does not have to wait for its
        // completion before sending a command with sequence numbers (RFC 3501 sections 5.5 and 7.4.1)
        noExpunge: !!options.noExpunge,
        // if the command accepts literal8 arguments `~{n}`: true, or the capability that allows them, like
        // "BINARY" for the APPEND message (RFC 3516 section 4.4)
        literal8: options.literal8 === true || typeof options.literal8 === 'string' ? options.literal8 : false,
        // the client must not send anything after the command before it has seen the result, because the command changes
        // the layers below the protocol (STARTTLS, RFC 9051 section 6.2.1, COMPRESS, RFC 4978 section 3). The command is
        // refused with BAD if more input is waiting
        noPipelining: !!options.noPipelining,
        // the command takes a message after its mailbox argument like APPEND does (REPLACE, RFC 8508 section 3.4), so a
        // message literal to a missing mailbox is refused before it is sent
        appendMessage: !!options.appendMessage
    };
}

// RFC 3501 core commands. Plugins pass the options of their commands to setCommandHandler
const CORE_COMMANDS = {
    CAPABILITY: commandOptions({ states: ANY, noArguments: true }),
    NOOP: commandOptions({ states: ANY, noArguments: true }),
    LOGOUT: commandOptions({ states: ANY, noArguments: true }),

    STARTTLS: commandOptions({ states: NOT_AUTHENTICATED, noArguments: true, noPipelining: true }),
    // login = "LOGIN" SP userid SP password, both astrings
    LOGIN: commandOptions({ states: NOT_AUTHENTICATED, astringArguments: [0, 1] }),

    SELECT: commandOptions({ states: AUTHENTICATED, mailboxArguments: [0] }),
    EXAMINE: commandOptions({ states: AUTHENTICATED, mailboxArguments: [0] }),
    CREATE: commandOptions({ states: AUTHENTICATED, mailboxArguments: [0] }),
    DELETE: commandOptions({ states: AUTHENTICATED, mailboxArguments: [0] }),
    RENAME: commandOptions({ states: AUTHENTICATED, mailboxArguments: [0, 1] }),
    SUBSCRIBE: commandOptions({ states: AUTHENTICATED, mailboxArguments: [0] }),
    UNSUBSCRIBE: commandOptions({ states: AUTHENTICATED, mailboxArguments: [0] }),
    // the reference is a mailbox name, the pattern a list-mailbox, an atom NIL is a valid name for both
    LIST: commandOptions({ states: AUTHENTICATED, astringArguments: [0, 1] }),
    LSUB: commandOptions({ states: AUTHENTICATED, astringArguments: [0, 1] }),
    STATUS: commandOptions({ states: AUTHENTICATED, mailboxArguments: [0] }),
    APPEND: commandOptions({ states: AUTHENTICATED, mailboxArguments: [0], literal8: 'BINARY', appendMessage: true }),

    CHECK: commandOptions({ states: SELECTED, noArguments: true }),
    CLOSE: commandOptions({ states: SELECTED, noArguments: true }),
    EXPUNGE: commandOptions({ states: SELECTED, noArguments: true }),
    SEARCH: commandOptions({ states: SELECTED, searchCriteria: 0, noExpunge: true }),
    FETCH: commandOptions({ states: SELECTED, sequenceSet: 0, noExpunge: true }),
    STORE: commandOptions({ states: SELECTED, sequenceSet: 0, noExpunge: true }),
    COPY: commandOptions({ states: SELECTED, sequenceSet: 0, mailboxArguments: [1] }),
    'UID COPY': commandOptions({ states: SELECTED, mailboxArguments: [1] }),
    'UID SEARCH': commandOptions({ states: SELECTED, searchCriteria: 0 })
};

const UID_COMMAND = commandOptions({ states: SELECTED });
const AUTHENTICATE_COMMAND = commandOptions({ states: NOT_AUTHENTICATED });

/**
 * Returns the options of a core command
 *
 * @param {String} command Upper case command name, e.g. "UID FETCH"
 * @return {Object|Boolean} command options (see commandOptions) or false if the command is not a core command
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
