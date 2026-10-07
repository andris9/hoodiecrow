'use strict';

const { isDeepStrictEqual } = require('util');
const { getListExtensions } = require('../list-extensions');

/**
 * @help Adds LIST-EXTENDED [RFC5258] capability: selection options
 * @help SUBSCRIBED, REMOTE and RECURSIVEMATCH, return options SUBSCRIBED
 * @help and CHILDREN, multiple mailbox patterns and CHILDINFO.
 * @help \Noselect mailboxes are listed as \NonExistent
 */

const STRING_TYPES = ['STRING', 'LITERAL', 'ATOM'];

const isString = value => !!value && !Array.isArray(value) && STRING_TYPES.indexOf(value.type) >= 0;

/**
 * Checks if a LIST command uses the extended syntax (RFC 5258 section 1): selection options before
 * the reference, a list of patterns, or more than 2 arguments (return options)
 *
 * @param {Array} args Command arguments
 * @return {Boolean} true for an extended LIST command
 */
const isExtended = args => Array.isArray(args[0]) || Array.isArray(args[1]) || args.length > 2;

module.exports = function (server) {
    const extensions = getListExtensions(server);
    if (extensions.enabled) {
        // already loaded by LIST-STATUS
        return;
    }
    extensions.enabled = true;

    server.registerCapability('LIST-EXTENDED');

    // RFC 5258 section 3.1. There are no remote mailboxes, so REMOTE changes nothing
    extensions.selectionOptions.SUBSCRIBED = {
        type: 'base',
        returnOption: 'SUBSCRIBED',
        includeNonExistent: true,
        match: folder => !!folder.subscribed
    };
    extensions.selectionOptions.REMOTE = { type: 'independent' };
    extensions.selectionOptions.RECURSIVEMATCH = { type: 'modifier' };

    // RFC 5258 section 3.2. Children attributes are always returned, so CHILDREN needs no handling
    extensions.returnOptions.SUBSCRIBED = {};
    extensions.returnOptions.CHILDREN = {};

    /**
     * Parses selection or return options (RFC 5258 section 6, option-extension = tag [SP option-value])
     *
     * @param {Array} list Parsed option list
     * @param {Object} registry Known options
     * @param {String} kind "selection" or "return", for error messages
     * @param {Object} connection IMAPConnection instance
     * @return {Map} option name to value (true for options without a value)
     */
    const parseOptions = (list, registry, kind, connection) => {
        const options = new Map();
        for (let i = 0; i < list.length; i++) {
            const item = list[i];
            if (!item || item.type !== 'ATOM') {
                throw new Error('Invalid ' + kind + ' option');
            }
            const name = item.value.toUpperCase();
            const option = registry[name];
            if (!option) {
                // RFC 5258 section 3: "A server MUST respond to options it does not recognize with a BAD response"
                throw new Error('Unknown ' + kind + ' option ' + name);
            }

            let value = true;
            if (option.parse) {
                if (!Array.isArray(list[i + 1])) {
                    throw new Error(name + ' ' + kind + ' option requires a value');
                }
                value = option.parse(list[++i], connection);
            } else if (Array.isArray(list[i + 1])) {
                throw new Error(name + ' ' + kind + ' option takes no value');
            }

            // RFC 5258 section 3: a repeated option counts once, so it can not have different values
            if (options.has(name) && !isDeepStrictEqual(options.get(name), value)) {
                throw new Error(name + ' ' + kind + ' option is repeated with a different value');
            }
            options.set(name, value);
        }
        return options;
    };

    /**
     * Parses the arguments of an extended LIST command:
     * list = "LIST" [SP list-select-opts] SP mailbox SP mbox-or-pat [SP list-return-opts]
     *
     * @param {Array} args Command arguments
     * @param {Object} connection IMAPConnection instance
     * @return {Object} `{ selection, reference, patterns, returns }`
     */
    const parseArguments = (args, connection) => {
        let selection = new Map();
        let returns = new Map();
        let pos = 0;

        if (Array.isArray(args[0])) {
            selection = parseOptions(args[0], extensions.selectionOptions, 'selection', connection);
            pos++;
        }

        const reference = args[pos];
        let patterns = args[pos + 1];
        const rest = args.slice(pos + 2);

        if (!isString(reference)) {
            throw new Error('LIST expects a reference name');
        }

        // patterns = "(" list-mailbox *(SP list-mailbox) ")"
        patterns = Array.isArray(patterns) ? patterns : [patterns];
        if (!patterns.length || !patterns.every(isString)) {
            throw new Error('LIST expects a mailbox pattern or a list of patterns');
        }

        // list-return-opts = "RETURN" SP "(" [return-option *(SP return-option)] ")"
        if (rest.length) {
            if (rest.length !== 2 || !rest[0] || rest[0].type !== 'ATOM' || rest[0].value.toUpperCase() !== 'RETURN' || !Array.isArray(rest[1])) {
                throw new Error('LIST expects RETURN and a list of return options after the patterns');
            }
            returns = parseOptions(rest[1], extensions.returnOptions, 'return', connection);
        }

        // RFC 5258 section 3.1: RECURSIVEMATCH (any list-select-mod-opt) needs a list-select-base-opt
        const types = [...selection.keys()].map(name => extensions.selectionOptions[name].type);
        if (types.includes('modifier') && !types.includes('base')) {
            throw new Error('RECURSIVEMATCH must be used together with a selection option like SUBSCRIBED');
        }

        // a selection option implies its return option, eg. SUBSCRIBED
        selection.forEach((value, name) => {
            const implied = extensions.selectionOptions[name].returnOption;
            if (implied && !returns.has(implied)) {
                returns.set(implied, true);
            }
        });

        return {
            selection,
            reference: reference.value,
            // RFC 5258 section 3: an empty pattern is ignored in an extended LIST command
            patterns: patterns.map(pattern => pattern.value).filter(pattern => pattern),
            returns
        };
    };

    const exists = folder => folder.flags.indexOf('\\Noselect') < 0;

    const getDescendants = folder => {
        const prefix = folder.path + server.storage[folder.namespace].separator;
        return Object.keys(server.folderCache)
            .filter(path => path.substr(0, prefix.length) === prefix)
            .map(path => server.folderCache[path]);
    };

    /**
     * Mailbox attributes for an extended LIST response. \NonExistent replaces \Noselect (RFC 5258
     * section 3, \NonExistent implies \Noselect), children attributes are computed (RFC 5258 section 4)
     */
    const getAttributes = (folder, isExisting, hasChildren, returns) => {
        const flags = folder.flags.filter(flag => !/^\\(HasChildren|HasNoChildren)$/i.test(flag) && (isExisting || flag !== '\\Noselect'));

        if (!isExisting) {
            flags.push('\\NonExistent');
        }

        // RFC 5258 section 3.2
        if (returns.has('SUBSCRIBED') && folder.subscribed) {
            flags.push('\\Subscribed');
        }

        // RFC 3348 section 3: \HasNoChildren is redundant with \Noinferiors and SHOULD be omitted
        if (!flags.some(flag => /^\\Noinferiors$/i.test(flag))) {
            flags.push(hasChildren ? '\\HasChildren' : '\\HasNoChildren');
        }

        return flags.map(flag => ({ type: 'ATOM', value: flag }));
    };

    const listHandler = server.getCommandHandler('LIST');

    server.setCommandHandler('LIST', (connection, parsed, data, callback) => {
        const args = parsed.attributes || [];
        if (!isExtended(args)) {
            // RFC 3501 LIST
            return listHandler(connection, parsed, data, callback);
        }

        let request;
        try {
            request = parseArguments(args, connection);
        } catch (err) {
            connection.sendStatus(parsed, data, 'BAD', err.message, false, 'INVALID COMMAND');
            return callback();
        }

        const selection = [...request.selection.keys()].map(name => ({ name, ...extensions.selectionOptions[name] }));
        const filters = selection.filter(option => option.match);
        const includeNonExistent = selection.some(option => option.includeNonExistent);
        const recursive = request.selection.has('RECURSIVEMATCH');
        // RFC 5258 section 6: CHILDINFO lists the list-select-base-opt options, always quoted
        const childInfo = selection.filter(option => option.type === 'base').map(option => ({ type: 'STRING', value: option.name }));

        // does a mailbox satisfy the selection criteria. Without options that means an existing mailbox
        const matches = folder => (includeNonExistent || exists(folder)) && filters.every(option => option.match(folder, connection));

        // RFC 5258 section 3: a mailbox that matches several patterns is listed once
        const candidates = new Set();
        request.patterns.forEach(pattern => {
            server.matchFolders(request.reference, pattern, path => connection.exportMailboxName(path)).forEach(folder => candidates.add(folder));
        });

        candidates.forEach(folder => {
            const isExisting = exists(folder);
            const isMatch = matches(folder);
            const descendants = getDescendants(folder);
            const hasChildren = descendants.some(exists);

            let hasChildInfo = false;
            if (recursive) {
                // RFC 5258 section 3.5: a matching mailbox gets CHILDINFO if a descendant matches as well.
                // A mailbox that does not match is only listed for a matching descendant that is not
                // listed itself (redundant CHILDINFO SHOULD be suppressed)
                hasChildInfo = descendants.some(descendant => matches(descendant) && (isMatch || !candidates.has(descendant)));
            }

            // RFC 5258 section 3.5: without selection filters a mailbox that does not exist but has
            // existing descendants is listed as "\NonExistent \HasChildren"
            const listed = isMatch || hasChildInfo || (!filters.length && !isExisting && hasChildren);
            if (!listed) {
                return;
            }

            const attributes = [
                getAttributes(folder, isExisting, hasChildren, request.returns),
                server.storage[folder.namespace].separator,
                connection.exportMailboxName(folder.path)
            ];
            if (hasChildInfo) {
                // mbox-list-extended = "(" mbox-list-extended-item *(SP mbox-list-extended-item) ")"
                attributes.push([{ type: 'STRING', value: 'CHILDINFO' }, childInfo]);
            }

            connection.send(
                {
                    tag: '*',
                    command: 'LIST',
                    attributes
                },
                'LIST ITEM',
                parsed,
                data,
                folder
            );

            request.returns.forEach((value, name) => {
                const option = extensions.returnOptions[name];
                if (option.onItem) {
                    option.onItem(connection, folder, value, { matched: isMatch, exists: isExisting }, parsed, data);
                }
            });
        });

        connection.sendStatus(parsed, data, 'OK', 'Completed', false, 'LIST');
        return callback();
    });
};
