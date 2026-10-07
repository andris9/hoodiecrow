/**
 * @help Adds MULTISEARCH [RFC7377] capability, loads ESEARCH as well
 * @help ESEARCH IN (mailboxes "a" subtree "b" personal ...) RETURN (...) searches several mailboxes, also in the authenticated state
 */

import esearch from './esearch.js';
import { buildEsearchResponse, selectReturned } from '../esearch.js';
import makeSearch from '../commands/handlers/search.js';
import { badError, criteriaValues, sendSearchError } from '../commands/handlers/search.js';
import { states } from '../command-states.js';
import { isAtom, isAstring } from '../arguments.js';
import type { SearchResult } from '../commands/handlers/search.js';
import type { Attribute, Callback, IMAPConnection, IMAPError, IMAPServer, Mailbox, ParsedCommand } from '../types.js';

/** A mailbox specifier of the source options: the filter and the storage names that follow it */
interface MailboxSource {
    filter: string;
    names: string[];
}

// RFC 5465 section 6 filter-mailboxes, as changed by RFC 7377 section 2.2. The value tells if a mailbox name
// or a list of names follows (one-or-more-mailbox)
const FILTERS: Record<string, boolean> = {
    SELECTED: false,
    INBOXES: false,
    PERSONAL: false,
    SUBSCRIBED: false,
    SUBTREE: true,
    'SUBTREE-ONE': true,
    MAILBOXES: true
};

/**
 * Parses the source options (RFC 7377 section 4): esearch-source-opts = "IN" SP "(" source-mbox [SP "(" scope-options ")"] ")",
 * source-mbox = filter-mailboxes *(SP filter-mailboxes)
 *
 * @param {Object} connection IMAP connection, converts the mailbox names to storage names
 * @param {Array} list Parsed list after IN
 * @return {Array} list of `{ filter, names }`
 */
function parseSources(connection: IMAPConnection, list: Attribute[]): MailboxSource[] {
    if (!Array.isArray(list) || !list.length) {
        throw badError('IN expects a parenthesized list of mailbox specifiers');
    }
    const sources: MailboxSource[] = [];
    for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (Array.isArray(item)) {
            // scope-options, RFC 7377 defines none
            throw badError('Unknown ESEARCH scope option');
        }
        const filter = item && item.type === 'ATOM' ? String(item.value).toUpperCase() : '';
        if (!Object.hasOwn(FILTERS, filter)) {
            // "selected-delayed" is not valid here (RFC 7377 section 2.2)
            throw badError('Invalid mailbox specifier' + (filter ? ' ' + item.value : ''));
        }
        const source: MailboxSource = { filter, names: [] };
        if (FILTERS[filter]) {
            const value = list[++i];
            const names = Array.isArray(value) ? value : [value];
            // RFC 5465 section 8: one-or-more-mailbox = mailbox / many-mailboxes, many-mailboxes = "(" mailbox *(SP mailbox) ")"
            if (!names.length || !names.every(isAstring)) {
                throw badError(filter.toLowerCase() + ' expects a mailbox name or a list of mailbox names');
            }
            names.forEach(name => source.names.push(connection.importMailboxName(name.value)));
        }
        sources.push(source);
    }
    return sources;
}

/**
 * Parses the arguments of ESEARCH (RFC 7377 section 4): esearch = "ESEARCH" [SP esearch-source-opts] [SP search-return-opts] SP search-program
 *
 * @return {Object} `{ sources, attributes }`, sources is null when IN was not used, attributes hold the result options and the search program
 */
function splitArguments(connection: IMAPConnection, attributes: Attribute[] | undefined) {
    const args = attributes || [];
    if (isAtom(args[0], 'IN')) {
        return { sources: parseSources(connection, args[1]), attributes: args.slice(2) };
    }
    return { sources: null, attributes: args };
}

export default function multisearchPlugin(server: IMAPServer) {
    // RFC 7377 section 2.1: the ESEARCH command answers with ESEARCH responses (RFC 4731)
    esearch(server);

    server.registerCapability('MULTISEARCH');

    const isSelectable = (mailbox: Mailbox | false | null | undefined) => !!mailbox && mailbox.flags.indexOf('\\Noselect') < 0;

    // every mailbox, INBOX first
    const allMailboxes = () => {
        const list = Object.keys(server.folderCache).map(path => server.folderCache[path]);
        return list.sort((a, b) => (a.path === 'INBOX' ? -1 : b.path === 'INBOX' ? 1 : 0));
    };

    // a mailbox and the mailboxes below it, `depth` levels down (RFC 7377 section 2.2). Visited
    // mailboxes are not walked again, which also defends against loops in the hierarchy
    const walkSubtree = (mailbox: Mailbox, depth: number, visit: (mailbox: Mailbox) => boolean) => {
        if (!visit(mailbox) || !depth || !mailbox.folders) {
            return;
        }
        const folders = mailbox.folders;
        Object.keys(folders).forEach(name => walkSubtree(folders[name], depth - 1, visit));
    };

    /**
     * Resolves the source options to the mailboxes to search, in the order they were given. Mailboxes
     * that do not exist, are not selectable or that the user may not search (server.searchAccessChecks, ACL)
     * are ignored (RFC 7377 section 2.2)
     */
    const resolveMailboxes = (connection: IMAPConnection, sources: MailboxSource[]) => {
        const result: Mailbox[] = [];
        const seen = new Set<Mailbox>();
        // `named` is true for a mailbox that the client gave the name of
        const add = (mailbox: Mailbox | false | null | undefined, named: boolean) => {
            // the client SHOULD NOT name a mailbox twice, the duplicates are removed (RFC 7377 section 2.2)
            if (!mailbox || seen.has(mailbox) || !isSelectable(mailbox)) {
                return;
            }
            if (server.searchAccessChecks.every(check => check(connection, mailbox, !!named))) {
                seen.add(mailbox);
                result.push(mailbox);
            }
        };
        sources.forEach(source => {
            switch (source.filter) {
                case 'SELECTED':
                    add(connection.selectedMailbox, true);
                    break;
                case 'INBOXES':
                    // RFC 5465 section 6.3: messages are only delivered to INBOX
                    add(server.getMailbox('INBOX'), false);
                    break;
                case 'PERSONAL':
                    allMailboxes()
                        .filter(mailbox => server.isPersonal(mailbox))
                        .forEach(mailbox => add(mailbox, false));
                    break;
                case 'SUBSCRIBED':
                    // RFC 5465 section 6.4
                    allMailboxes()
                        .filter(mailbox => mailbox.subscribed)
                        .forEach(mailbox => add(mailbox, false));
                    break;
                case 'MAILBOXES':
                    source.names.forEach((name: string) => add(server.getMailbox(name), true));
                    break;
                default: {
                    const depth = source.filter === 'SUBTREE' ? Infinity : 1;
                    const visited = new Set<Mailbox>();
                    source.names.forEach((name: string) => {
                        const mailbox = server.getMailbox(name);
                        if (mailbox) {
                            walkSubtree(mailbox, depth, child => {
                                if (visited.has(child)) {
                                    return false;
                                }
                                visited.add(child);
                                // the named mailbox itself, not the ones below it
                                add(child, child === mailbox);
                                return true;
                            });
                        }
                    });
                }
            }
        });
        return result;
    };

    const handler = (connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
        const fail = (status: string, text: string) => {
            connection.sendStatus(parsed, data, status, text, false, 'ESEARCH FAILED');
            return callback();
        };

        let sources: MailboxSource[];
        let options = new Map<string, any>();
        let params: any[];
        try {
            const split = splitArguments(connection, parsed.attributes);
            sources = split.sources || [{ filter: 'SELECTED', names: [] }];
            let attributes = split.attributes;
            if (isAtom(attributes[0], 'RETURN')) {
                options = parsed.searchReturn = server.parseSearchReturn(attributes[1], connection, parsed);
                attributes = attributes.slice(2);
            }
            if (!attributes.length) {
                throw badError('ESEARCH expects search criteria');
            }
            params = criteriaValues(attributes);
        } catch (E) {
            return fail('BAD', (E as IMAPError).message);
        }

        const onlySelected = sources.every(source => source.filter === 'SELECTED');
        // RFC 7377 section 2.2: "selected" needs the selected state
        if (sources.some(source => source.filter === 'SELECTED') && !connection.selectedMailbox) {
            return fail('BAD', 'No mailbox is selected');
        }
        // RFC 7377 section 2.2: SAVE is valid only if "selected" is the sole mailbox to search
        if (options.has('SAVE') && !onlySelected) {
            return fail('BAD', 'SAVE can only be used when searching the selected mailbox');
        }
        // RFC 7377 section 2.2: UPDATE applies to the selected mailbox only, and needs one
        if (options.has('UPDATE') && !connection.selectedMailbox) {
            return fail('BAD', 'UPDATE needs a selected mailbox');
        }

        const mailboxes = resolveMailboxes(connection, sources);
        const results: { mailbox: Mailbox; result: SearchResult }[] = [];
        try {
            // the criteria are checked even when no mailbox is searched
            const searchMailbox = (mailbox: Mailbox | null) => {
                if (mailbox && mailbox === connection.selectedMailbox) {
                    return makeSearch(connection, connection.getSessionMessages(), params);
                }
                const messages = mailbox ? mailbox.messages : [];
                return makeSearch(connection, messages, params, (range: string, isUid: boolean) => server.getMessageRange(messages, range, isUid));
            };
            if (!mailboxes.length) {
                searchMailbox(connection.selectedMailbox || null);
            }
            mailboxes.forEach(mailbox => results.push({ mailbox, result: searchMailbox(mailbox) }));
        } catch (E) {
            sendSearchError(connection, parsed, data, E as IMAPError, 'ESEARCH FAILED');
            return callback();
        }

        const silent = server.isSilentReturn(options);
        results.forEach(({ mailbox, result }) => {
            // RFC 7377 section 2.1: one ESEARCH response per mailbox with matches, always with UIDs and the
            // MAILBOX, TAG and UIDVALIDITY correlators, none for a mailbox without matches
            if (!result.list.length || silent) {
                return;
            }
            connection.send(
                buildEsearchResponse(parsed.tag, true, result, options, mailbox),
                'ESEARCH',
                parsed,
                data,
                Object.assign({}, result, { list: selectReturned(result.list, options) })
            );
        });

        const selected = results.find(entry => entry.mailbox === connection.selectedMailbox);
        if (options.has('SAVE')) {
            // SEARCHRES stores it once the tagged response tells if the command succeeded
            parsed.searchresFound = selected ? selectReturned(selected.result.list, options) : [];
        }
        if (options.has('UPDATE') && selected) {
            server.addSearchContext(connection, parsed, data, selected.result, true, selected.mailbox);
        }

        connection.sendStatus(parsed, data, 'OK', 'ESEARCH completed', false, 'ESEARCH');
        return callback();
    };

    // RFC 7377 section 4: command-auth =/ esearch, command-select =/ esearch
    server.setCommandHandler('ESEARCH', handler, { states: states.AUTHENTICATED, searchCriteria: 0 });

    // RFC 3501 section 5.5: sequence numbers can only be in the search program
    server.connectionHandlers.push((connection: IMAPConnection) => {
        // the source options are taken off here, the ESEARCH plugin takes off the result options
        const usesSequenceNumbers = connection.usesSequenceNumbers;
        connection.usesSequenceNumbers = function (parsed: ParsedCommand) {
            if ((parsed.command || '').toUpperCase() === 'ESEARCH' && isAtom((parsed.attributes || [])[0], 'IN')) {
                parsed = Object.assign({}, parsed, { attributes: parsed.attributes!.slice(2) });
            }
            return usesSequenceNumbers.call(this, parsed);
        };
    });
}
