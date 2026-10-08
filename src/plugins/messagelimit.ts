import { badError } from '../commands/handlers/search.js';
import { parsePartialRange } from '../esearch.js';
import { MAX_NUMBER, isNzNumber } from '../numbers.js';
import type {
    AppendCheckOptions,
    AppendMessage,
    Attribute,
    IMAPConnection,
    IMAPError,
    IMAPResponse,
    IMAPServer,
    Mailbox,
    Message,
    MessageRange,
    ParsedCommand
} from '../types.js';

/**
 * @help Adds MESSAGELIMIT [RFC9738] capability, advertised as MESSAGELIMIT=<n>
 * @help Server option "messageLimit" sets n (default 1000). FETCH, STORE, SEARCH, MOVE, UID EXPUNGE
 * @help and their UID variants only work on the n messages with the highest UIDs and add
 * @help [MESSAGELIMIT n uid] to the tagged OK. COPY, APPEND (MULTIAPPEND), SORT and THREAD of
 * @help more messages fail with NO [MESSAGELIMIT ...]. Adds the UIDAFTER and UIDBEFORE search keys.
 * @help Can not be loaded with SAVELIMIT
 *
 * MESSAGELIMIT: https://www.rfc-editor.org/rfc/rfc9738
 */

// RFC 9738 section 3: the advertised limit SHOULD NOT be lower than 1000
const DEFAULT_LIMIT = 1000;

// RFC 9738 section 3.1: commands that operate on the messages with the highest UIDs and return the MESSAGELIMIT response code.
// EXPUNGE, CLOSE and STATUS UNSEEN MUST NOT be limited
const PARTIAL_COMMANDS = new Set(['FETCH', 'UID FETCH', 'STORE', 'UID STORE', 'MOVE', 'UID MOVE', 'UID EXPUNGE']);
const SEARCH_COMMANDS = new Set(['SEARCH', 'UID SEARCH']);
// RFC 9738 section 3.3: SORT and THREAD can not be run on more messages than the limit
const SORT_COMMANDS = new Set(['SORT', 'UID SORT', 'THREAD', 'UID THREAD']);

/**
 * Reads the limit from the "messageLimit" server option
 *
 * @param {Object} server IMAPServer
 * @param {String} name Capability name for the error message
 * @return {Number} limit
 */
function getLimit(server: IMAPServer, name: string) {
    if (server.messageLimit) {
        // RFC 9738 section 3: SAVELIMIT is advertised instead of MESSAGELIMIT, never both
        throw new Error(name + ' can not be enabled together with ' + server.messageLimit.name);
    }
    const limit = 'messageLimit' in server.options ? server.options.messageLimit : DEFAULT_LIMIT;
    // message-limit = nz-number
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_NUMBER) {
        throw new TypeError('Invalid messageLimit option, expecting a positive integer');
    }
    server.messageLimit = { name, limit };
    return limit;
}

/**
 * Refuses COPY and APPEND of more messages than the limit, shared with the SAVELIMIT plugin. COPY and
 * MULTIAPPEND APPEND are atomic, so nothing is copied or appended (RFC 9738 section 3.1)
 *
 * @param {Object} server IMAPServer
 * @param {Number} limit Message limit
 */
function addSaveLimit(server: IMAPServer, limit: number) {
    server.appendChecks.push((connection: IMAPConnection | null, mailbox: Mailbox, messages: AppendMessage[], options: AppendCheckOptions) => {
        if (messages.length <= limit) {
            return false;
        }
        if (options.command) {
            return { code: ['MESSAGELIMIT', limit], text: options.command + ' exceeds the limit of ' + limit + ' messages, nothing was appended' };
        }
        // MOVE is not atomic, it is cut to the limit before it gets here
        if (!options.move) {
            // the lowest UID the command would have processed, the messages are in UID order
            const lastUid = messages[messages.length - limit].uid;
            return { code: ['MESSAGELIMIT', limit, lastUid], text: 'Too many messages to copy, try a smaller subset' };
        }
        return false;
    });
}

export default function messagelimitPlugin(server: IMAPServer) {
    const limit = getLimit(server, 'MESSAGELIMIT');
    server.registerCapability('MESSAGELIMIT=' + limit);
    addSaveLimit(server, limit);

    const commandName = (parsed: ParsedCommand) => String(parsed.command || '').toUpperCase();

    // FETCH, STORE, MOVE and UID EXPUNGE only operate on the messages with the highest UIDs, "the server is REQUIRED
    // to process messages from highest to lowest UID". COPY is refused by addSaveLimit instead
    server.rangeLimits.push((connection: IMAPConnection, parsed: ParsedCommand, range: MessageRange) => {
        const command = commandName(parsed);
        // a FETCH with the PARTIAL modifier was checked before it ran, its range is not cut
        if (!PARTIAL_COMMANDS.has(command) || parsed.partialFetch) {
            return false;
        }
        // UID EXPUNGE only operates on the \Deleted messages of the set
        const operated = command === 'UID EXPUNGE' ? range.filter(entry => entry[1].flags.indexOf('\\Deleted') >= 0) : range;
        if (operated.length <= limit) {
            return false;
        }
        const dropped = new Set(operated.slice(0, -limit));
        parsed.messageLimitUid = operated[operated.length - limit][1].uid;
        // section 3.1: "when the MESSAGELIMIT response code is returned, the server is REQUIRED to process messages
        // from highest to lowest UID", the FETCH, STORE, MOVE and UID EXPUNGE examples respond in that order
        parsed.highestFirst = true;
        return range.filter(entry => !dropped.has(entry)).reverse();
    });

    // RFC 9738 section 3.1: with the PARTIAL FETCH modifier (RFC 9394 section 3.3), the PARTIAL range is the message
    // count, a larger range is refused without doing any work. The PARTIAL plugin answers an invalid modifier with BAD
    server.commandChecks.push((connection: IMAPConnection, parsed: ParsedCommand) => {
        const modifiers = server.capabilities.PARTIAL && parsed.attributes && parsed.attributes[2];
        const command = commandName(parsed);
        if (!Array.isArray(modifiers) || (command !== 'FETCH' && command !== 'UID FETCH')) {
            return false;
        }
        const position = modifiers.findIndex((item, i) => !(i % 2) && item && item.type === 'ATOM' && String(item.value).toUpperCase() === 'PARTIAL');
        let range;
        try {
            range = position >= 0 && parsePartialRange(modifiers[position + 1], true);
        } catch {
            return false;
        }
        if (range && range.to - range.from + 1 > limit) {
            return { command: 'NO', code: ['MESSAGELIMIT', limit], text: command + ' exceeds the limit of ' + limit + ' messages' };
        }
        return false;
    });

    // RFC 9738 section 3.1: SEARCH counts the searched messages, not the matching ones. The messages a search
    // looks at are the ones its top level sequence set, UID, UIDAFTER and UIDBEFORE keys allow
    server.searchLimits.push((connection: IMAPConnection, messages: Message[], query: any) => {
        // the running command, SEARCH and SORT do not pass it to the search
        const parsed = connection._runningCommand && connection._runningCommand.parsed;
        const command = parsed ? commandName(parsed) : '';
        if (messages.length <= limit || (!SEARCH_COMMANDS.has(command) && !SORT_COMMANDS.has(command))) {
            return false;
        }
        const candidates = messages.filter(message => isCandidate(query, message));
        if (candidates.length <= limit) {
            return false;
        }
        if (SORT_COMMANDS.has(command)) {
            const err: IMAPError = new Error(command + ' exceeds the limit of ' + limit + ' messages, narrow it down with UIDAFTER or UIDBEFORE');
            err.imapResponse = 'NO';
            err.responseCode = ['MESSAGELIMIT', limit];
            throw err;
        }
        // with SEARCHRES, only these results are saved in "$" (RFC 9738 section 3.4)
        parsed!.messageLimitUid = candidates[candidates.length - limit].uid;
        return candidates.slice(-limit);
    });

    // RFC 9738 section 3.2: UIDAFTER <uid> is "UID <uid>+1:*", UIDBEFORE <uid> is "UID 1:<uid>-1"
    const parseUniqueId = (value: any) => {
        // uniqueid = nz-number
        if (!isNzNumber(value)) {
            throw badError('UIDAFTER and UIDBEFORE expect a UID');
        }
        return Number(value);
    };
    const uidAfter = (connection: IMAPConnection, message: Message, index: number, uid: number) => message.uid > uid;
    uidAfter.argumentTypes = () => [parseUniqueId];
    const uidBefore = (connection: IMAPConnection, message: Message, index: number, uid: number) => message.uid < uid;
    uidBefore.argumentTypes = () => [parseUniqueId];
    server.searchHandlers.UIDAFTER = uidAfter;
    server.searchHandlers.UIDBEFORE = uidBefore;

    const outputHandler = (connection: IMAPConnection, response: IMAPResponse, description: string, parsed: ParsedCommand, data: string) => {
        // section 3.1 UID SEARCH example: the results go from the highest UID down, (MODSEQ n) of CONDSTORE stays last
        if (parsed && parsed.messageLimitUid && response.tag === '*' && response.command === 'SEARCH' && Array.isArray(response.attributes)) {
            const modseq = response.attributes.filter(Array.isArray);
            response.attributes = response.attributes
                .filter(attr => !Array.isArray(attr))
                .reverse()
                .concat(modseq);
            return;
        }
        if (!parsed || !parsed.messageLimitUid || response.tag !== parsed.tag) {
            return;
        }
        const lastUid = parsed.messageLimitUid;
        parsed.messageLimitUid = false;
        if (response.command !== 'OK') {
            return;
        }

        // resp-text-code =/ "MESSAGELIMIT" SP message-limit [SP uniqueid]
        const code = { type: 'SECTION', section: [{ type: 'ATOM', value: 'MESSAGELIMIT' }, limit, lastUid] };
        const attributes = response.attributes || [];
        if (attributes[0] && attributes[0].type === 'SECTION') {
            // RFC 9738 section 3.1: when the tagged OK carries another response code (EXPUNGEISSUED there, and here
            // also HIGHESTMODSEQ, MODIFIED), MESSAGELIMIT is sent in an untagged NO
            connection.send(
                {
                    tag: '*',
                    command: 'NO',
                    attributes: [code, { type: 'TEXT', value: 'Only the last ' + limit + ' messages were processed' }]
                },
                'MESSAGELIMIT',
                parsed,
                data
            );
            return;
        }
        response.attributes = [code].concat(attributes);
    };

    // registered once every plugin is loaded, so that the response codes other plugins add to the tagged OK
    // are already there
    server.once('pluginsLoaded', () => server.outputHandlers.push(outputHandler));
}

/**
 * Checks if a message passes the keys of a search query that every match must pass: sequence sets,
 * UID, UIDAFTER and UIDBEFORE at the top level, or in parenthesized lists at the top level
 *
 * @param {Object} node AND node of the query tree, see commands/handlers/search.ts
 * @param {Object} message Message
 * @return {Boolean} true if the message has to be searched
 */
function isCandidate(node: Attribute, message: Message) {
    return node.args.every((arg: any) => {
        switch (arg.key) {
            case 'AND':
                return isCandidate(arg, message);
            case '_SEQ':
            case 'UID':
                return arg.set.has(message);
            case 'UIDAFTER':
                return message.uid > arg.args[0];
            case 'UIDBEFORE':
                return message.uid < arg.args[0];
            default:
                return true;
        }
    });
}

export { getLimit, addSaveLimit };
