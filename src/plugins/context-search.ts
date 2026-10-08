/**
 * @help Adds CONTEXT=SEARCH [RFC5267] capability, loads ESEARCH as well
 * @help SEARCH RETURN (UPDATE) sends ADDTO and REMOVEFROM updates as the result changes, until CANCELUPDATE or the mailbox is closed
 * @help SEARCH RETURN (PARTIAL 1:100) returns a window of the results, the CONTEXT hint is accepted and ignored
 * @help Server option "maxSearchContexts" (default 10) limits the updating contexts of a session, above it NOUPDATE is sent
 */

import esearch from './esearch.js';
import { buildCorrelator, registerPartialOption, toSequenceSet, toOrderedSet } from '../esearch.js';
import { states } from '../command-states.js';
import type { SearchResult } from '../commands/handlers/search.js';
import type { Attribute, Callback, CommandContext, IMAPConnection, IMAPResponse, IMAPServer, Mailbox, Message, ParsedCommand } from '../types.js';

/** Compares two messages by the sort criteria of a sorting command */
type MessageComparator = (a: Message, b: Message) => number;

/** An updating context of a searching command (RFC 5267 section 4.3) */
interface SearchContext {
    tag: string;
    isUid: boolean;
    /** checks a message against the search criteria */
    matches: (message: Message, index: number) => boolean;
    /** the messages in the result */
    results: Set<Message>;
    /** the comparator of a sorting command, null for a searching command */
    compare: MessageComparator | null;
    /** the results in sort order, null for a searching command */
    order: Message[] | null;
    mailbox: Mailbox | false | undefined;
    correlatorMailbox: Mailbox | null;
}

/** A `[context position, value]` pair of an ADDTO or REMOVEFROM update */
type Update = [number, number];

const DEFAULT_MAX_CONTEXTS = 10;

// commands that close the selected mailbox, updates cease with them (RFC 5267 section 4.3)
const CLOSING_COMMANDS = new Set(['SELECT', 'EXAMINE', 'CLOSE', 'UNSELECT']);

// searching commands that can create updating contexts, SORT and UID SORT only with CONTEXT=SORT (see the ESORT plugin)
const SEARCHING_COMMANDS = new Set(['SEARCH', 'UID SEARCH', 'SORT', 'UID SORT']);

const getContexts = (connection: IMAPConnection): Map<string, SearchContext> => {
    if (!connection.searchContexts) {
        connection.searchContexts = new Map();
    }
    return connection.searchContexts;
};

/**
 * Groups updates of one kind into context position and result set pairs (RFC 5267 sections 4.3.3 and
 * 4.3.4). Updates of a searching command all use position 0 and form one set in mailbox order. Updates of
 * a sorting command are merged while they continue each other: an insertion right after the previous
 * inserted results, or a removal at the same position where the previous result was removed
 *
 * @param {Array} updates `[position, value]` pairs in the order they are applied
 * @param {Boolean} isRemoval If true, the updates are REMOVEFROM updates
 * @return {Array} payload of the ADDTO or REMOVEFROM return data item
 */
const groupUpdates = (updates: Update[], isRemoval: boolean) => {
    const groups: { position: number; values: number[] }[] = [];
    updates.forEach(([position, value]) => {
        const last = groups[groups.length - 1];
        const next = last && (isRemoval || !position ? last.position : last.position + last.values.length);
        if (last && position === next) {
            last.values.push(value);
        } else {
            groups.push({ position, values: [value] });
        }
    });
    const payload: Attribute[] = [];
    groups.forEach(group => {
        const set = group.position ? toOrderedSet(group.values) : toSequenceSet(group.values);
        payload.push(group.position, { type: 'SEQUENCE', value: set });
    });
    return payload;
};

/**
 * Sends ADDTO and REMOVEFROM updates of a context (RFC 5267 sections 4.3.3 and 4.3.4)
 *
 * @param {Object} connection IMAP connection
 * @param {Object} context Updating context
 * @param {Array} removed `[position, value]` pairs of removed results, applied first
 * @param {Array} added `[position, value]` pairs of added results
 */
const sendUpdate = (connection: IMAPConnection, context: SearchContext, removed: Update[], added: Update[]) => {
    const attributes: Attribute[] = [buildCorrelator(context.tag, context.correlatorMailbox)];
    if (context.isUid) {
        attributes.push({ type: 'ATOM', value: 'UID' });
    }
    if (removed.length) {
        attributes.push({ type: 'ATOM', value: 'REMOVEFROM' }, groupUpdates(removed, true));
    }
    if (added.length) {
        attributes.push({ type: 'ATOM', value: 'ADDTO' }, groupUpdates(added, false));
    }
    connection.send({ tag: '*', command: 'ESEARCH', attributes }, 'ESEARCH UPDATE', null, null, context);
};

/**
 * Checks every updating context against the selected mailbox as the session sees it, and sends the
 * changes. Expunged messages are handled when their EXPUNGE response is sent
 */
const checkContexts = (connection: IMAPConnection) => {
    const contexts: Map<string, SearchContext> = connection.searchContexts;
    const mailbox = connection.selectedMailbox;
    const messages = mailbox ? mailbox.messages : [];
    const numbers = new Map(messages.map((message: Message, i: number) => [message, i + 1]));
    contexts.forEach((context, tag) => {
        if (context.mailbox !== mailbox) {
            contexts.delete(tag);
            return;
        }
        const matching = messages.filter((message: Message, i: number) => context.matches(message, i + 1));
        // only messages of the mailbox get a value
        const getValue = (message: Message) => (context.isUid ? message.uid : numbers.get(message)!);
        const current = new Set(matching);
        const removed: Update[] = [];
        const added: Update[] = [];

        if (!context.compare) {
            // a searching command, positions are 0 (RFC 5267 section 4.3.3)
            context.results.forEach((message: Message) => {
                // a message that is gone without an EXPUNGE response for this session is just dropped
                if (!current.has(message) && numbers.has(message)) {
                    removed.push([0, getValue(message)]);
                }
            });
            matching.forEach((message: Message) => {
                if (!context.results.has(message)) {
                    added.push([0, getValue(message)]);
                }
            });
        } else {
            // a sorting command. The sort values of a message do not change, so the results that stay keep their order.
            // Removals are counted on the list as it shrinks, insertions in ascending order of their final position
            let kept = 0;
            context.order!.forEach((message: Message) => {
                if (current.has(message)) {
                    kept++;
                } else if (numbers.has(message)) {
                    removed.push([kept + 1, getValue(message)]);
                }
            });
            context.order = matching.sort(context.compare);
            context.order.forEach((message: Message, i: number) => {
                if (!context.results.has(message)) {
                    added.push([i + 1, getValue(message)]);
                }
            });
        }

        context.results = current;
        if (removed.length || added.length) {
            sendUpdate(connection, context, removed, added);
        }
    });
};

/**
 * Removes expunged messages from the contexts that hold them, with one REMOVEFROM update per context
 *
 * @param {Object} connection IMAP connection
 * @param {Array} messages The expunged messages
 * @param {Number} seq Sequence number of the EXPUNGE response for a single message, null when there is none (VANISHED)
 */
const removeExpunged = (connection: IMAPConnection, messages: Message[], seq: number | null) => {
    connection.searchContexts.forEach((context: SearchContext) => {
        if (context.mailbox !== connection.selectedMailbox) {
            return;
        }
        const removed: Update[] = [];
        messages.forEach(message => {
            if (!context.results.delete(message)) {
                return;
            }
            let position = 0;
            if (context.order) {
                position = context.order.indexOf(message) + 1;
                context.order.splice(position - 1, 1);
            }
            if (context.isUid || seq) {
                removed.push([position, context.isUid ? message.uid : (seq as number)]);
            }
        });
        if (removed.length) {
            sendUpdate(connection, context, removed, []);
        }
    });
};

export default function contextSearchPlugin(server: IMAPServer) {
    // CONTEXT=SORT loads this plugin as well, so it may be called twice
    if (server.addSearchContext) {
        return;
    }

    // the result options of CONTEXT=SEARCH extend the extended SEARCH command (RFC 5267 section 4.1)
    esearch(server);

    server.registerCapability('CONTEXT=SEARCH');

    const maxContexts = Math.max(Number(server.options.maxSearchContexts) || DEFAULT_MAX_CONTEXTS, 1);

    // RFC 5267 section 4.2: the server MAY ignore the CONTEXT hint
    server.searchReturnOptions.set('CONTEXT', { hint: true });
    // RFC 5267 section 4.3: UPDATE has no data of its own, but the ESEARCH response is still sent
    server.searchReturnOptions.set('UPDATE', { data: false, response: true, once: true });
    // RFC 5267 section 4.4
    registerPartialOption(server);

    // RFC 5267 section 4.3: UPDATE with the tag of an earlier searching command that still has an updating
    // context SHALL be rejected with BAD
    server.searchReturnChecks.push(
        (options: Map<string, any>, connection: IMAPConnection, parsed: ParsedCommand) =>
            options.has('UPDATE') && getContexts(connection).has(parsed.tag) && 'Tag ' + parsed.tag + ' is already in use by an updating search'
    );

    /**
     * Creates an updating context once a searching command with UPDATE has completed. Also used by
     * CONTEXT=SORT and by the ESEARCH command of MULTISEARCH
     *
     * @param {Object} connection IMAP connection
     * @param {Object} parsed Parsed searching command
     * @param {String} data Raw command
     * @param {Object} result Search result of the selected mailbox, with the `matches` function, and for a
     *        sorting command the `sorted` list and the `compare` function
     * @param {Boolean} isUid If true, the updates list UIDs
     * @param {Object} [correlatorMailbox] Mailbox for the MAILBOX and UIDVALIDITY correlators (RFC 7377)
     */
    server.addSearchContext = (
        connection: IMAPConnection,
        parsed: ParsedCommand,
        data: string,
        result: SearchResult & { sorted?: Message[] | undefined; compare?: MessageComparator | undefined },
        isUid: boolean,
        correlatorMailbox?: Mailbox | null
    ) => {
        const contexts = getContexts(connection);
        if (contexts.size >= maxContexts) {
            // RFC 5267 section 4.3.1: an untagged NO with NOUPDATE, the other result options are still honoured
            connection.send(
                {
                    tag: '*',
                    command: 'NO',
                    attributes: [
                        {
                            type: 'SECTION',
                            section: [
                                { type: 'ATOM', value: 'NOUPDATE' },
                                { type: 'STRING', value: parsed.tag }
                            ]
                        },
                        { type: 'TEXT', value: 'Too many updating contexts' }
                    ]
                },
                'NOUPDATE',
                parsed,
                data
            );
            return;
        }
        contexts.set(parsed.tag, {
            tag: parsed.tag,
            isUid,
            matches: result.matches,
            results: new Set(result.list),
            compare: result.compare || null,
            order: result.compare ? result.sorted!.slice() : null,
            mailbox: connection.selectedMailbox,
            correlatorMailbox: correlatorMailbox || null
        });
    };

    // RFC 5267 section 4.3.5: command-select =/ "CANCELUPDATE" 1*(SP quoted)
    server.setCommandHandler(
        'CANCELUPDATE',
        (connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
            const tags = parsed.attributes || [];
            if (!tags.length || tags.some(tag => !tag || tag.type !== 'STRING')) {
                connection.sendStatus(parsed, data, 'BAD', 'CANCELUPDATE expects one or more quoted tags', false, 'CANCELUPDATE FAILED');
                return callback();
            }
            const contexts = getContexts(connection);
            const unknown = tags.find(tag => !contexts.has(tag.value));
            if (unknown) {
                // nothing is cancelled when a tag has no updating context
                connection.sendStatus(parsed, data, 'NO', 'Unknown tag', false, 'CANCELUPDATE FAILED');
                return callback();
            }
            tags.forEach(tag => contexts.delete(tag.value));
            connection.sendStatus(parsed, data, 'OK', 'Updates cancelled', false, 'CANCELUPDATE');
            return callback();
        },
        { states: states.SELECTED }
    );

    // UNAUTHENTICATE (RFC 8437) closes the mailbox, so the updates end
    server.resetHandlers.push((connection: IMAPConnection) => {
        connection.searchContexts = null;
    });

    server.connectionHandlers.push((connection: IMAPConnection) => {
        // Notifications from other sessions (and this one) are flushed here. Once none are pending, the session
        // knows the current message list, so new matches can be reported after their EXISTS and FETCH responses
        // (RFC 5267 section 4.3.2). A command that closes the mailbox gets no updates, its tagged response ends them
        const processNotifications = connection.processNotifications;
        connection.processNotifications = function (this: IMAPConnection, data?: CommandContext | null, beforeCommand?: boolean) {
            processNotifications.call(this, data, beforeCommand);
            const command = ((data && data.command) || '').toUpperCase();
            if (this.searchContexts && this.searchContexts.size && !this.notificationQueue.length && !CLOSING_COMMANDS.has(command)) {
                checkContexts(this);
            }
        };
    });

    server.outputHandlers.push((connection: IMAPConnection, response: IMAPResponse, description: string, parsed: ParsedCommand, data: string, extra: any) => {
        // RFC 5267 section 4.3.4: REMOVEFROM for an expunged message MUST be sent before the EXPUNGE response. After
        // ENABLE QRESYNC a VANISHED response reports the expunged messages (RFC 7162 section 3.2.10), it has no sequence
        // numbers, so contexts with sequence numbers drop those messages without an update
        const expunged = response.tag === '*' && (response.message ? [response.message] : response.command === 'VANISHED' && response.messages);
        if (expunged && connection.searchContexts) {
            removeExpunged(connection, expunged, response.message ? response.attributes[0] : null);
            return;
        }

        if (!parsed) {
            return;
        }
        const command = (parsed.command || '').toUpperCase();

        if (response.tag === parsed.tag && CLOSING_COMMANDS.has(command)) {
            connection.searchContexts = null;
            return;
        }

        if (!SEARCHING_COMMANDS.has(command) || !parsed.searchReturn || !parsed.searchReturn.has('UPDATE')) {
            return;
        }
        // the full search result, the context is created when the command succeeded
        if (response.tag === '*' && command.endsWith(String(response.command)) && description === command && extra && Array.isArray(extra.list)) {
            parsed.contextResult = extra;
            return;
        }
        if (response.tag === parsed.tag && response.command === 'OK' && parsed.contextResult) {
            server.addSearchContext(connection, parsed, data, parsed.contextResult, command.startsWith('UID '));
        }
    });
}
