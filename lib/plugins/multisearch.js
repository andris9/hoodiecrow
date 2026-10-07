'use strict';

/**
 * @help Adds MULTISEARCH [RFC7377] capability, loads ESEARCH as well
 * @help ESEARCH IN (mailboxes "a" subtree "b" personal ...) RETURN (...) searches several mailboxes, also in the authenticated state
 */

const esearch = require('./esearch');
const { buildEsearchResponse, selectReturned } = require('../esearch');
const makeSearch = require('../commands/handlers/search');
const { badError } = makeSearch;
const { states } = require('../command-states');

const isAtom = (item, name) => !!item && item.type === 'ATOM' && String(item.value).toUpperCase() === name;
const isAstring = item => !!item && ['ATOM', 'STRING', 'LITERAL'].includes(item.type);

// RFC 5465 section 6 filter-mailboxes, as changed by RFC 7377 section 2.2. The value tells if a mailbox name
// or a list of names follows (one-or-more-mailbox)
const FILTERS = {
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
function parseSources(connection, list) {
    if (!Array.isArray(list) || !list.length) {
        throw badError('IN expects a parenthesized list of mailbox specifiers');
    }
    const sources = [];
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
        const source = { filter, names: [] };
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
function splitArguments(connection, attributes) {
    attributes = attributes || [];
    if (isAtom(attributes[0], 'IN')) {
        return { sources: parseSources(connection, attributes[1]), attributes: attributes.slice(2) };
    }
    return { sources: null, attributes };
}

module.exports = function (server) {
    // RFC 7377 section 2.1: the ESEARCH command answers with ESEARCH responses (RFC 4731)
    esearch(server);

    server.registerCapability('MULTISEARCH');

    const isSelectable = mailbox => !!mailbox && mailbox.flags.indexOf('\\Noselect') < 0;

    // every mailbox, INBOX first
    const allMailboxes = () => {
        const list = Object.keys(server.folderCache).map(path => server.folderCache[path]);
        return list.sort((a, b) => (a.path === 'INBOX' ? -1 : b.path === 'INBOX' ? 1 : 0));
    };

    // RFC 5465 section 6.2: the mailboxes in the personal namespaces
    const isPersonal = mailbox => mailbox.namespace === 'INBOX' || (server.storage[mailbox.namespace] || {}).type === 'personal';

    // a mailbox and the mailboxes below it, `depth` levels down (RFC 7377 section 2.2). Visited
    // mailboxes are not walked again, which also defends against loops in the hierarchy
    const walkSubtree = (mailbox, depth, visit) => {
        if (!visit(mailbox) || !depth || !mailbox.folders) {
            return;
        }
        Object.keys(mailbox.folders).forEach(name => walkSubtree(mailbox.folders[name], depth - 1, visit));
    };

    /**
     * Resolves the source options to the mailboxes to search, in the order they were given. Mailboxes
     * that do not exist, are not selectable or that the user may not search (server.searchAccessChecks, ACL)
     * are ignored (RFC 7377 section 2.2)
     */
    const resolveMailboxes = (connection, sources) => {
        const result = [];
        const seen = new Set();
        // `named` is true for a mailbox that the client gave the name of
        const add = (mailbox, named) => {
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
                        .filter(isPersonal)
                        .forEach(mailbox => add(mailbox, false));
                    break;
                case 'SUBSCRIBED':
                    // RFC 5465 section 6.4
                    allMailboxes()
                        .filter(mailbox => mailbox.subscribed)
                        .forEach(mailbox => add(mailbox, false));
                    break;
                case 'MAILBOXES':
                    source.names.forEach(name => add(server.getMailbox(name), true));
                    break;
                default: {
                    const depth = source.filter === 'SUBTREE' ? Infinity : 1;
                    const visited = new Set();
                    source.names.forEach(name => {
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

    const handler = (connection, parsed, data, callback) => {
        const fail = (status, text, code) => {
            const attributes = [];
            if (code) {
                attributes.push({ type: 'SECTION', section: code });
            }
            attributes.push({ type: 'TEXT', value: text });
            connection.send({ tag: parsed.tag, command: status, attributes }, 'ESEARCH FAILED', parsed, data);
            return callback();
        };

        let sources;
        let options = new Map();
        let params;
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
            const convert = argument => {
                if (Array.isArray(argument)) {
                    return argument.map(convert);
                }
                if (!argument || ['STRING', 'ATOM', 'LITERAL', 'SEQUENCE'].indexOf(argument.type) < 0) {
                    throw badError('Invalid search criteria argument');
                }
                return argument.value;
            };
            params = attributes.map(convert);
        } catch (E) {
            return fail('BAD', E.message);
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
        const results = [];
        try {
            // the criteria are checked even when no mailbox is searched
            const searchMailbox = mailbox => {
                if (mailbox && mailbox === connection.selectedMailbox) {
                    return makeSearch(connection, connection.getSessionMessages(), params);
                }
                const messages = mailbox ? mailbox.messages : [];
                return makeSearch(connection, messages, params, (range, isUid) => server.getMessageRange(messages, range, isUid));
            };
            if (!mailboxes.length) {
                searchMailbox(connection.selectedMailbox || null);
            }
            mailboxes.forEach(mailbox => results.push({ mailbox, result: searchMailbox(mailbox) }));
        } catch (E) {
            const code = E.code === 'BADCHARSET' ? [{ type: 'ATOM', value: 'BADCHARSET' }, E.charsets.map(value => ({ type: 'ATOM', value }))] : false;
            return fail(E.imapResponse === 'BAD' ? 'BAD' : 'NO', E.message, code);
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
    server.connectionHandlers.push(connection => {
        // the source options are taken off here, the ESEARCH plugin takes off the result options
        const usesSequenceNumbers = connection.usesSequenceNumbers;
        connection.usesSequenceNumbers = function (parsed) {
            if ((parsed.command || '').toUpperCase() === 'ESEARCH' && isAtom((parsed.attributes || [])[0], 'IN')) {
                parsed = Object.assign({}, parsed, { attributes: parsed.attributes.slice(2) });
            }
            return usesSequenceNumbers.call(this, parsed);
        };
    });
};
