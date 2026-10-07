'use strict';

const { states } = require('../command-states');

/**
 * @help Adds METADATA [RFC5464] capability (GETMETADATA and SETMETADATA)
 * @help for server and mailbox annotations. Mailboxes take initial entries
 * @help from a "metadata" object in storage, server entries come from the
 * @help "metadata" option. Limits: "metadataMaxSize" (octets per value,
 * @help default 65536), "metadataMaxEntries" (per mailbox and for the
 * @help server, default 100). "metadataPrivate": false turns /private
 * @help entries off. ENABLE METADATA turns on unsolicited METADATA responses
 */

// Default limits, RFC 5464 section 4.1 requires at least 1024 octets and 10 entries
const DEFAULT_MAX_SIZE = 64 * 1024;
const DEFAULT_MAX_ENTRIES = 100;

// RFC 3501 section 9: number is an unsigned 32-bit integer
const MAX_NUMBER = 4294967295;

// RFC 5464 section 3.2.1.1: /shared/admin is always read-only
const READ_ONLY_SERVER_ENTRIES = new Set(['/shared/admin']);

// RFC 6154 section 4: special-use attributes are tied to this mailbox entry
const SPECIAL_USE_ENTRY = '/private/specialuse';

/**
 * Checks an entry name against RFC 5464 section 3.2
 *
 * @param {String} name Entry name as a binary string
 * @param {Boolean} [isSet] If true, the name must be one that can hold a value (at least 2 components,
 *   at least 4 under /shared/vendor and /private/vendor). GETMETADATA also accepts the bare "/shared"
 *   and "/private" scopes, so a client can ask for everything with DEPTH infinity
 * @return {String|Boolean} Description of the problem, or false if the name is valid
 */
function checkEntryName(name, isSet) {
    if (typeof name !== 'string' || name.charAt(0) !== '/') {
        return 'Entry name must begin with "/"';
    }
    // "MUST NOT contain non-ASCII characters or characters with octet values in the range 0x00 to 0x19"
    if (/[^\x20-\x7f]/.test(name)) {
        return 'Entry name must not contain non-ASCII or control characters';
    }
    if (/[*%]/.test(name)) {
        return 'Entry name must not contain "*" or "%"';
    }
    if (name.indexOf('//') >= 0) {
        return 'Entry name must not contain consecutive "/" characters';
    }
    if (name.charAt(name.length - 1) === '/') {
        return 'Entry name must not end with "/"';
    }
    const components = name.toLowerCase().substr(1).split('/');
    if (components[0] !== 'private' && components[0] !== 'shared') {
        return 'Entry name must begin with /private or /shared';
    }
    if (isSet && components.length < 2) {
        return 'Entry name must have at least 2 components';
    }
    if (isSet && components[1] === 'vendor' && components.length < 4) {
        return 'Vendor entry names must have at least 4 components';
    }
    return false;
}

/**
 * Converts a value from storage or options to a binary string. A value with NUL is sent as a literal8
 *
 * @param {String} name Entry name, for error messages
 * @param {*} value Entry value
 * @return {String|null} Binary string, or null for no value
 */
function normalizeValue(name, value) {
    if (value === null || value === undefined) {
        return null;
    }
    if (value instanceof Uint8Array) {
        value = Buffer.from(value).toString('binary');
    } else if (typeof value === 'string') {
        if (/[Ā-￿]/.test(value)) {
            // characters outside Latin-1 can only come from a unicode string, so encode it as UTF-8
            value = Buffer.from(value, 'utf-8').toString('binary');
        }
    } else {
        throw new Error('Invalid value for metadata entry ' + name + ', expecting a string');
    }
    return value;
}

/**
 * Checks if a parsed argument is an astring
 *
 * @param {Object} attr Parsed argument
 * @return {Boolean} true for an atom, quoted string or literal
 */
function isAstring(attr) {
    return !!attr && !Array.isArray(attr) && ['ATOM', 'STRING', 'LITERAL'].indexOf(attr.type) >= 0;
}

/**
 * Formats a mailbox name for a METADATA response. IMAPConnection#send converts the storage name for
 * each session (UTF-8 with UTF8=ACCEPT) and quotes it when it is not an atom
 *
 * @param {String} name Mailbox name, "" for the server
 * @return {Object} Response attribute
 */
function mailboxAttribute(name) {
    return { type: 'MAILBOX', value: name };
}

/**
 * Sets up METADATA or METADATA-SERVER. With both plugins loaded, METADATA wins (RFC 5464 section 1:
 * a server with mailbox annotations advertises METADATA)
 *
 * @param {Object} server IMAPServer instance
 * @param {Boolean} mailboxes If true, mailbox annotations are supported, otherwise only server annotations
 */
function setup(server, mailboxes) {
    server.enableAvailable = server.enableAvailable || [];

    if (server.metadataState) {
        // the other variant is already loaded, upgrade it if needed
        if (mailboxes && !server.metadataState.mailboxes) {
            server.metadataState.mailboxes = true;
            delete server.capabilities['METADATA-SERVER'];
            server.registerCapability('METADATA');
            server.enableAvailable.splice(server.enableAvailable.indexOf('METADATA-SERVER'), 1, 'METADATA');
        }
        return;
    }

    // RFC 5464 section 5: SETMETADATA values can be literal8
    server.parserOptions.literal8 = true;

    const capability = mailboxes ? 'METADATA' : 'METADATA-SERVER';
    server.registerCapability(capability);
    // RFC 5464 section 4.1: unsolicited METADATA responses are only sent after ENABLE. Shared with the
    // ENABLE plugin, so the load order of these plugins does not matter
    server.enableAvailable.push(capability);

    const options = server.options;
    const state = (server.metadataState = {
        mailboxes,
        maxSize: Number(options.metadataMaxSize) || DEFAULT_MAX_SIZE,
        maxEntries: Number(options.metadataMaxEntries) || DEFAULT_MAX_ENTRIES,
        allowPrivate: options.metadataPrivate !== false,
        // server annotations, normalized on first use like mailbox annotations
        server: { path: '', metadata: options.metadata }
    });

    // metadata objects that are already normalized
    const normalized = new WeakSet();

    /**
     * Returns the stored entries of a mailbox or the server, as an object of lower case entry
     * names (entry names are case-insensitive, RFC 5464 section 3.2) and binary string values
     *
     * @param {Object} holder Mailbox object or state.server
     * @return {Object} Entries, replace them with setEntries instead of changing them
     */
    const getEntries = holder => {
        if (!holder.metadata) {
            return Object.create(null);
        }
        if (normalized.has(holder.metadata)) {
            return holder.metadata;
        }

        // initial values from storage or options, never modify the caller's objects
        const entries = Object.create(null);
        Object.keys(holder.metadata).forEach(name => {
            const error = checkEntryName(name, true);
            if (error) {
                throw new Error('Invalid metadata entry name ' + JSON.stringify(name) + ': ' + error);
            }
            const value = normalizeValue(name, holder.metadata[name]);
            if (value !== null) {
                entries[name.toLowerCase()] = value;
            }
        });
        return setEntries(holder, entries);
    };

    const setEntries = (holder, entries) => {
        normalized.add(entries);
        holder.metadata = entries;
        return entries;
    };

    /**
     * Returns entries that the server computes instead of storing them
     *
     * @param {Object} holder Mailbox object or state.server
     * @return {Object} Entries, a null value means no value
     */
    const getComputedEntries = holder => {
        const computed = Object.create(null);
        if (holder.path && server.capabilities['SPECIAL-USE']) {
            // RFC 6154 section 4: NIL or the special-use attributes separated by spaces, as in LIST responses
            const specialUse = [].concat(holder['special-use'] || []);
            computed[SPECIAL_USE_ENTRY] = specialUse.length ? specialUse.join(' ') : null;
        }
        return computed;
    };

    const isEnabled = connection => !!connection.enabled && connection.enabled.indexOf(state.mailboxes ? 'METADATA' : 'METADATA-SERVER') >= 0;

    /**
     * Finds the annotation holder for a mailbox name argument, sends a NO if there is none
     *
     * @return {Object|Boolean} Mailbox object, state.server or false
     */
    const getHolder = (connection, parsed, data, name) => {
        if (name === '') {
            return state.server;
        }
        if (!state.mailboxes) {
            connection.sendStatus(parsed, data, 'NO', 'Mailbox annotations are not supported, only server annotations');
            return false;
        }
        // RFC 5464 section 3.3: only mailboxes that exist and are returned by LIST. Annotations
        // on \Noselect mailboxes are allowed (section 4.1)
        const mailbox = connection.server.getMailbox(name);
        if (!mailbox || mailbox.flags.indexOf('\\NonExistent') >= 0) {
            connection.sendStatus(parsed, data, 'NO', 'Mailbox does not exist', 'NONEXISTENT');
            return false;
        }
        return mailbox;
    };

    const bad = (connection, parsed, data, text, callback) => {
        connection.sendStatus(parsed, data, 'BAD', text);
        return callback();
    };

    // RFC 5464 section 4.2, options before the mailbox name as corrected by errata 2785 and 2786:
    // getmetadata = "GETMETADATA" [SP getmetadata-options] SP mailbox SP entries
    server.setCommandHandler(
        'GETMETADATA',
        (connection, parsed, data, callback) => {
            const attrs = parsed.attributes || [];
            const offset = Array.isArray(attrs[0]) ? 1 : 0;
            let maxSize = false;
            let depth = 0;

            if (attrs.length !== offset + 2 || !isAstring(attrs[offset])) {
                return bad(connection, parsed, data, 'GETMETADATA expects options, a mailbox name and entries', callback);
            }

            if (offset) {
                // getmetadata-options = "(" getmetadata-option *(SP getmetadata-option) ")"
                const list = attrs[0];
                if (!list.length) {
                    return bad(connection, parsed, data, 'Empty option list', callback);
                }
                for (let i = 0; i < list.length; i += 2) {
                    const label = list[i] && list[i].type === 'ATOM' ? list[i].value.toUpperCase() : false;
                    const value = list[i + 1] && list[i + 1].type === 'ATOM' ? list[i + 1].value : false;
                    if (label === 'MAXSIZE') {
                        // maxsize-opt = "MAXSIZE" SP number
                        if (!value || !/^\d+$/.test(value) || Number(value) > MAX_NUMBER) {
                            return bad(connection, parsed, data, 'Invalid value for MAXSIZE', callback);
                        }
                        maxSize = Number(value);
                    } else if (label === 'DEPTH') {
                        // scope-opt = "DEPTH" SP ("0" / "1" / "infinity")
                        if (!value || !/^(0|1|infinity)$/i.test(value)) {
                            return bad(connection, parsed, data, 'Invalid value for DEPTH', callback);
                        }
                        depth = value.toLowerCase() === 'infinity' ? Infinity : Number(value);
                    } else {
                        return bad(connection, parsed, data, 'Unknown GETMETADATA option', callback);
                    }
                }
            }

            // the mailbox position depends on the options, so the name is converted here, not by mailboxArguments
            let mailboxName;
            try {
                mailboxName = connection.importMailboxName(attrs[offset].value);
            } catch (err) {
                return bad(connection, parsed, data, err.message, callback);
            }

            // entries = entry / "(" entry *(SP entry) ")"
            const entryAttrs = [].concat(attrs[offset + 1]);
            if (!entryAttrs.length || !entryAttrs.every(isAstring)) {
                return bad(connection, parsed, data, 'GETMETADATA expects an entry name or a list of entry names', callback);
            }
            for (const attr of entryAttrs) {
                const error = checkEntryName(attr.value);
                if (error) {
                    // RFC 5464 section 3.2: "Invalid entry names result in a BAD response"
                    return bad(connection, parsed, data, error, callback);
                }
            }

            const holder = getHolder(connection, parsed, data, mailboxName);
            if (!holder) {
                return callback();
            }

            const all = Object.assign(Object.create(null), getEntries(holder), getComputedEntries(holder));
            const names = depth
                ? Object.keys(all)
                      .filter(name => all[name] !== null)
                      .sort()
                : [];

            // RFC 5464 section 4.2.2: the entry itself and the entries below it up to DEPTH
            const found = new Map();
            for (const attr of entryAttrs) {
                const entry = attr.value.toLowerCase();
                const value = all[entry] ?? null;
                if (!depth || value !== null) {
                    // a requested entry without a value is returned as NIL
                    found.set(entry, value);
                }
                const prefix = entry + '/';
                names.forEach(name => {
                    if (name.startsWith(prefix) && (depth === Infinity || name.indexOf('/', prefix.length) < 0)) {
                        found.set(name, all[name]);
                    }
                });
            }

            // RFC 5464 section 4.2.1: larger values are left out, LONGENTRIES reports the biggest one
            let longest = -1;
            const pairs = [];
            found.forEach((value, name) => {
                if (maxSize !== false && value !== null && value.length > maxSize) {
                    longest = Math.max(longest, value.length);
                    return;
                }
                // RFC 5464 section 5: value = nstring / literal8, only binary data with NUL needs a literal8
                pairs.push({ type: 'ATOM', value: name }, value === null ? null : { type: value.indexOf('\x00') >= 0 ? 'LITERAL8' : 'STRING', value });
            });

            if (pairs.length) {
                connection.send(
                    {
                        tag: '*',
                        command: 'METADATA',
                        attributes: [mailboxAttribute(holder.path), pairs]
                    },
                    'METADATA',
                    parsed,
                    data,
                    holder
                );
            }

            connection.sendStatus(parsed, data, 'OK', 'GETMETADATA completed', longest >= 0 && ['METADATA', 'LONGENTRIES', longest]);
            return callback();
        },
        { states: states.AUTHENTICATED }
    );

    // RFC 5464 section 4.3: setmetadata = "SETMETADATA" SP mailbox SP entry-values
    server.setCommandHandler(
        'SETMETADATA',
        (connection, parsed, data, callback) => {
            const attrs = parsed.attributes || [];
            if (attrs.length !== 2 || !isAstring(attrs[0]) || !Array.isArray(attrs[1])) {
                return bad(connection, parsed, data, 'SETMETADATA expects a mailbox name and a list of entries and values', callback);
            }

            // entry-values = "(" entry-value *(SP entry-value) ")", entry-value = entry SP value
            const list = attrs[1];
            if (!list.length || list.length % 2) {
                return bad(connection, parsed, data, 'SETMETADATA expects entry and value pairs', callback);
            }

            const changes = new Map();
            for (let i = 0; i < list.length; i += 2) {
                if (!isAstring(list[i])) {
                    return bad(connection, parsed, data, 'Entry name must be a string', callback);
                }
                const error = checkEntryName(list[i].value, true);
                if (error) {
                    return bad(connection, parsed, data, error, callback);
                }
                // value = nstring / literal8, an atom is not a value
                const value = list[i + 1];
                if (value !== null && (!value || ['STRING', 'LITERAL', 'LITERAL8'].indexOf(value.type) < 0)) {
                    return bad(connection, parsed, data, 'Entry value must be a string, a literal, a literal8 or NIL', callback);
                }
                // RFC 5464 section 3.2: "Clients MUST use the CRLF (0x0D 0x0A) character octet sequence
                // to represent line ends in a multi-line string value", binary data in a literal8 is not a string
                if (value && value.type !== 'LITERAL8' && /\r(?!\n)|(?:^|[^\r])\n/.test(value.value)) {
                    return bad(connection, parsed, data, 'Line ends in a value must be CRLF', callback);
                }
                changes.set(list[i].value.toLowerCase(), value ? value.value : null);
            }

            const holder = getHolder(connection, parsed, data, attrs[0].value);
            if (!holder) {
                return callback();
            }

            const entries = getEntries(holder);
            const computed = getComputedEntries(holder);
            const fail = (text, code) => {
                // RFC 5464 section 4.3: when one entry fails, no entry is changed
                connection.sendStatus(parsed, data, 'NO', text, code);
                return callback();
            };

            // changes go to a copy that replaces the entries once every check passed
            const next = Object.assign(Object.create(null), entries);
            const changed = [];
            for (const [name, value] of changes) {
                if ((!holder.path && READ_ONLY_SERVER_ENTRIES.has(name)) || name in computed) {
                    return fail('The ' + name + ' entry is read-only', 'CANNOT');
                }
                if (!state.allowPrivate && name.startsWith('/private/')) {
                    return fail('Private annotations are not supported', ['METADATA', 'NOPRIVATE']);
                }
                if (value !== null && value.length > state.maxSize) {
                    return fail('Value of ' + name + ' is too large', ['METADATA', 'MAXSIZE', state.maxSize]);
                }
                if ((entries[name] ?? null) !== value) {
                    changed.push(name);
                }
                if (value === null) {
                    delete next[name];
                } else {
                    next[name] = value;
                }
            }
            // only adding entries can fail, even when the storage already holds more than the limit
            const count = Object.keys(next).length;
            if (count > state.maxEntries && count > Object.keys(entries).length) {
                return fail('Too many annotations', ['METADATA', 'TOOMANY']);
            }
            setEntries(holder, next);

            if (changed.length) {
                // RFC 5464 section 4.4.2: unsolicited responses only list the entry names. Section 4.1:
                // only sessions that used ENABLE METADATA (or METADATA-SERVER) get them
                server.notify(
                    {
                        tag: '*',
                        command: 'METADATA',
                        attributes: [mailboxAttribute(holder.path)].concat(changed.map(name => ({ type: 'ATOM', value: name })))
                    },
                    false,
                    connection,
                    isEnabled
                );
            }

            connection.sendStatus(parsed, data, 'OK', 'SETMETADATA completed');
            return callback();
        },
        // RFC 5464 section 5: values can be literal8, with or without BINARY
        { states: states.AUTHENTICATED, mailboxArguments: [0], literal8: true }
    );

    server.outputHandlers.push((connection, response, description, parsed, data, extra) => {
        if (response.command !== 'OK' || !parsed || !parsed.attributes) {
            return;
        }

        if (description === 'RENAME' && extra && extra.path === 'INBOX') {
            // RFC 5464 section 4.1: renaming INBOX copies its annotations, INBOX keeps them. Other
            // mailboxes are moved as objects, so their annotations follow without any help
            const target = connection.server.getMailbox(parsed.attributes[1].value);
            if (target && target !== extra && extra.metadata) {
                setEntries(target, Object.assign(Object.create(null), getEntries(extra)));
            }
        } else if (description === 'DELETE') {
            // RFC 5464 section 4.1: a mailbox created later with the same name must not inherit the
            // annotations. A mailbox with children stays as a \Noselect placeholder
            const placeholder = connection.server.getMailbox(parsed.attributes[0].value);
            if (placeholder) {
                delete placeholder.metadata;
            }
        }
    });
}

module.exports = function (server) {
    setup(server, true);
};

module.exports.setup = setup;
