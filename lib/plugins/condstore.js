'use strict';

/**
 * @help Adds CONDSTORE [RFC7162] capability
 */

const { macros: FETCH_MACROS } = require('../commands/fetch');
const { badError } = require('../commands/handlers/search');
const { INVALID_KEYWORD_CHAR } = require('../commands/handlers/flags');

// RFC 7162 section 7: mod-sequence-value is a positive unsigned 63-bit integer
const MAX_MODSEQ = 9223372036854775807n;

module.exports = function (server) {
    // Register capability, always usable
    server.registerCapability('CONDSTORE');

    // Shared with the ENABLE plugin, so the load order of these plugins does not matter
    server.enableAvailable = server.enableAvailable || [];
    if (server.enableAvailable.indexOf('CONDSTORE') < 0) {
        server.enableAvailable.push('CONDSTORE');
    }

    // HIGHESTMODSEQ must be a positive number, even for an empty mailbox
    const getHighestModseq = mailbox => Math.max(Number(mailbox.HIGHESTMODSEQ) || 0, 1);

    const bumpModseq = mailbox => {
        mailbox.HIGHESTMODSEQ = getHighestModseq(mailbox) + 1;
        return mailbox.HIGHESTMODSEQ;
    };

    // RFC 8437 section 4.1: after UNAUTHENTICATE the session behaves as if no CONDSTORE enabling command was issued
    server.resetHandlers.push(connection => {
        connection.condstoreEnabled = false;
    });

    // ENABLE QRESYNC is a CONDSTORE enabling command as well (RFC 7162 section 3.2.3)
    const isEnabled = connection =>
        !!(connection.condstoreEnabled || (connection.enabled && (connection.enabled.indexOf('CONDSTORE') >= 0 || connection.enabled.indexOf('QRESYNC') >= 0)));

    // shared with QRESYNC, which builds on CONDSTORE
    server.condstore = { isEnabled, getHighestModseq };

    const sendHighestModseq = (connection, mailbox, parsed, data) => {
        connection.send(
            {
                tag: '*',
                command: 'OK',
                attributes: [
                    {
                        type: 'SECTION',
                        section: [
                            {
                                type: 'ATOM',
                                value: 'HIGHESTMODSEQ'
                            },
                            getHighestModseq(mailbox)
                        ]
                    },
                    {
                        type: 'TEXT',
                        value: 'Highest'
                    }
                ]
            },
            'CONDSTORE INFO',
            parsed,
            data
        );
    };

    // Marks the session as CONDSTORE aware. The first CONDSTORE enabling command
    // issued with a mailbox selected reports HIGHESTMODSEQ for that mailbox
    const enableCondstore = (connection, parsed, data) => {
        if (isEnabled(connection)) {
            connection.condstoreEnabled = true;
            return;
        }
        connection.condstoreEnabled = true;
        if (connection.state === 'Selected' && connection.selectedMailbox) {
            sendHighestModseq(connection, connection.selectedMailbox, parsed, data);
        }
    };

    // Set modseq values when a message is created or initialized
    server.messageHandlers.push((server, message, mailbox) => {
        const modseq = Number(message.MODSEQ);
        if (modseq > 0 && Number.isSafeInteger(modseq)) {
            // keep the value from storage
            message.MODSEQ = modseq;
            mailbox.HIGHESTMODSEQ = Math.max(getHighestModseq(mailbox), modseq);
        } else {
            message.MODSEQ = bumpModseq(mailbox);
        }
    });

    // Expunging messages (EXPUNGE, UID EXPUNGE, CLOSE, MOVE) changes the mailbox, all messages removed
    // at once share the incremented mod-sequence (RFC 7162 section 3.2)
    server.on('expunge', mailbox => {
        bumpModseq(mailbox);
    });

    // RFC 7162 section 3.2.11: SELECT or EXAMINE closes the selected mailbox, a CONDSTORE server marks
    // where the responses for the new mailbox start
    server.closedChecks.push(() => true);

    server.allowedStatus.push('HIGHESTMODSEQ');
    server.statusHandlers.HIGHESTMODSEQ = (connection, mailbox) => getHighestModseq(mailbox);

    // Wraps an existing command handler. Commands that are not available are left alone
    const wrapHandler = (command, wrapper) => {
        const prevHandler = server.getCommandHandler(command);
        if (!prevHandler) {
            return;
        }
        server.setCommandHandler(command, (connection, parsed, data, callback) => wrapper(prevHandler, connection, parsed, data, callback));
    };

    const sendBad = (connection, parsed, data, callback, message) => {
        connection.sendStatus(parsed, data, 'BAD', message, false, 'CONDSTORE FAILED');
        return callback();
    };

    const isValidModseq = value =>
        value && ['ATOM', 'STRING'].indexOf(value.type) >= 0 && /^\d+$/.test(value.value) && Number.isSafeInteger(Number(value.value));

    const selectWrapper = (prevHandler, connection, parsed, data, callback) => {
        if (hasCondstoreOption(parsed.attributes && parsed.attributes[1], parsed.attributes, 1)) {
            // SELECT and EXAMINE always report HIGHESTMODSEQ, so no need to send it here
            connection.condstoreEnabled = true;
            parsed.condstoreOption = true;
        }
        prevHandler(connection, parsed, data, callback);
    };

    wrapHandler('SELECT', selectWrapper);
    wrapHandler('EXAMINE', selectWrapper);

    wrapHandler('STATUS', (prevHandler, connection, parsed, data, callback) => {
        const items = parsed.attributes && parsed.attributes[1];
        if (Array.isArray(items) && items.some(item => item && item.type === 'ATOM' && String(item.value).toUpperCase() === 'HIGHESTMODSEQ')) {
            enableCondstore(connection, parsed, data);
        }
        prevHandler(connection, parsed, data, callback);
    });

    const fetchWrapper = (prevHandler, connection, parsed, data, callback) => {
        // RFC 4466 2.4: fetch-modifiers are the last argument, a single fetch-att may take arguments of its own
        const attributes = parsed.attributes || [];
        const index = Math.max(attributes.length - 1, 2);
        const changedsince = getCondstoreValue(attributes[index], 'CHANGEDSINCE', attributes, index);

        if (changedsince) {
            if (!isValidModseq(changedsince)) {
                return sendBad(connection, parsed, data, callback, 'Invalid syntax for CHANGEDSINCE, number expected');
            }
            parsed.changedsince = Number(changedsince.value);
            // CHANGEDSINCE implicitly adds the MODSEQ data item
            addModseqItem(parsed);
        }

        if (changedsince || hasModseqItem(parsed)) {
            enableCondstore(connection, parsed, data);
        }

        prevHandler(connection, parsed, data, callback);
    };

    wrapHandler('FETCH', fetchWrapper);
    wrapHandler('UID FETCH', fetchWrapper);

    const storeWrapper = (prevHandler, connection, parsed, data, callback) => {
        const unchangedsince = getCondstoreValue(parsed.attributes && parsed.attributes[1], 'UNCHANGEDSINCE', parsed.attributes, 1);

        if (unchangedsince) {
            if (!isValidModseq(unchangedsince)) {
                return sendBad(connection, parsed, data, callback, 'Invalid syntax for UNCHANGEDSINCE, number expected');
            }
            parsed.unchangedsince = Number(unchangedsince.value);
            enableCondstore(connection, parsed, data);
        }

        // Per command state for tracking changed messages
        parsed.condstoreStore = {
            isUid: (parsed.command || '').toUpperCase() === 'UID STORE',
            messages: new Map(),
            modified: [],
            done: false
        };

        prevHandler(connection, parsed, data, callback);
    };

    wrapHandler('STORE', storeWrapper);
    wrapHandler('UID STORE', storeWrapper);

    // RFC 7162 section 3.1.5: MODSEQ [<entry-name> <entry-type-req>] <mod-sequence-valzer>. Mod-sequences
    // are not stored per flag, so the entry name and type are checked but otherwise ignored
    const searchModseq = (connection, message, index, ...args) => message.MODSEQ >= args[args.length - 1];
    searchModseq.argumentTypes = list =>
        typeof list[0] === 'string' && /^\d+$/.test(list[0]) ? [parseModseqValzer] : [parseEntryName, parseEntryType, parseModseqValzer];
    server.searchHandlers.MODSEQ = searchModseq;

    // highest mod-sequence of a list of messages
    const highestModseq = messages => messages.reduce((highest, message) => Math.max(highest, message.MODSEQ), 0);

    server.fetchHandlers.MODSEQ = function (connection, message) {
        return [message.MODSEQ]; // Must be a list
    };

    server.fetchFilters.push((connection, message, parsed, index) => {
        if ('changedsince' in parsed && !(parsed.changedsince < message.MODSEQ)) {
            return false;
        }

        // remember \Seen state, FETCH might set it implicitly
        if (!parsed.condstoreFetch) {
            parsed.condstoreFetch = new Map();
        }
        parsed.condstoreFetch.set(index, {
            message,
            seen: message.flags.indexOf('\\Seen') >= 0
        });

        return true;
    });

    server.storeFilters.push((connection, message, parsed, index) => {
        const state = parsed.condstoreStore;
        if (!state) {
            return true;
        }

        if ('unchangedsince' in parsed && message.MODSEQ > parsed.unchangedsince) {
            // failed the UNCHANGEDSINCE test, reported with the MODIFIED response code
            state.modified.push(state.isUid ? message.uid : index);
            return false;
        }

        state.messages.set(message, {
            index,
            before: snapshot(message),
            bumped: false,
            reported: false
        });

        return true;
    });

    // Bumps MODSEQ if the message metadata was changed by the current STORE
    const checkStored = (connection, message, entry) => {
        if (!entry.bumped && snapshot(message) !== entry.before) {
            entry.bumped = true;
            message.MODSEQ = bumpModseq(connection.selectedMailbox);
        }
    };

    server.outputHandlers.push((connection, response, description, parsed, data, extra) => {
        // Flag changes made by another session (RFC 7162 section 3.1), these are not responses to a command
        if (description === 'FLAG NOTIFICATION' && response && extra && isEnabled(connection)) {
            setModseqValue(response.attributes[2], extra.MODSEQ);
            return;
        }

        if (!parsed || !response) {
            return;
        }

        // Untagged FETCH responses caused by STORE
        if (description === 'FLAG UPDATE' && parsed.condstoreStore && extra && parsed.condstoreStore.messages.has(extra)) {
            const entry = parsed.condstoreStore.messages.get(extra);
            checkStored(connection, extra, entry);
            entry.reported = true;
            if (isEnabled(connection)) {
                setModseqValue(response.attributes[2], extra.MODSEQ);
                setUidValue(response.attributes[2], extra.uid);
            }
            return;
        }

        // SEARCH, ESEARCH, SORT or THREAD with the MODSEQ search key, a CONDSTORE enabling command (RFC 7162 section 3.1).
        // `extra.list` holds the messages the response is about
        const isSearch = ['SEARCH', 'SORT', 'THREAD'].includes(response.command) && [response.command, 'UID ' + response.command].includes(description);
        if ((isSearch || description === 'ESEARCH') && response.tag === '*' && extra && extra.keys && extra.keys.has('MODSEQ')) {
            enableCondstore(connection, parsed, data);
            // RFC 7162 section 3.1.9: THREAD responses are unchanged
            if (extra.list.length && response.command !== 'THREAD') {
                const modseq = [{ type: 'ATOM', value: 'MODSEQ' }, highestModseq(extra.list)];
                // RFC 7162 sections 3.1.6 and 3.1.9 append "(MODSEQ n)" to SEARCH and SORT, RFC 4731 section 3.2 (and RFC 7162 section 3.1.10)
                // adds "MODSEQ n" to ESEARCH
                response.attributes.push(...(isSearch ? [modseq] : modseq));
            }
            return;
        }

        // Untagged FETCH responses of FETCH, check for implicitly set \Seen
        if (
            response.tag === '*' &&
            parsed.condstoreFetch &&
            response.attributes &&
            response.attributes[1] &&
            response.attributes[1].value === 'FETCH' &&
            parsed.condstoreFetch.has(response.attributes[0])
        ) {
            const entry = parsed.condstoreFetch.get(response.attributes[0]);
            const message = entry.message;
            let changed = false;
            if (!entry.seen && message.flags.indexOf('\\Seen') >= 0 && connection.selectedMailbox) {
                entry.seen = true;
                message.MODSEQ = bumpModseq(connection.selectedMailbox);
                changed = true;
            }
            const list = response.attributes[2];
            if (Array.isArray(list) && (findItem(list, 'MODSEQ') >= 0 || (changed && isEnabled(connection)))) {
                setModseqValue(list, message.MODSEQ);
            }
            // RFC 7162 section 3.1: a FETCH that implicitly set \Seen includes UID and MODSEQ
            if (Array.isArray(list) && changed && isEnabled(connection)) {
                setUidValue(list, message.uid);
            }
            return;
        }

        // Tagged response of STORE
        if (response.tag === parsed.tag && parsed.condstoreStore && !parsed.condstoreStore.done) {
            const state = parsed.condstoreStore;
            state.done = true;

            state.messages.forEach((entry, message) => {
                checkStored(connection, message, entry);
                // .SILENT stores send no FETCH responses, CONDSTORE aware clients still need the new MODSEQ values
                if (!entry.reported && isEnabled(connection) && (entry.bumped || 'unchangedsince' in parsed)) {
                    const attributes = [
                        {
                            type: 'ATOM',
                            value: 'MODSEQ'
                        },
                        [message.MODSEQ]
                    ];
                    // RFC 7162 section 3.1: UID and MODSEQ in every untagged FETCH caused by STORE
                    attributes.unshift({ type: 'ATOM', value: 'UID' }, message.uid);
                    connection.send(
                        {
                            tag: '*',
                            attributes: [
                                entry.index,
                                {
                                    type: 'ATOM',
                                    value: 'FETCH'
                                },
                                attributes
                            ]
                        },
                        'CONDSTORE MODSEQ UPDATE',
                        parsed,
                        data,
                        message
                    );
                }
            });

            if (response.command === 'OK' && state.modified.length) {
                response.attributes = [
                    {
                        type: 'SECTION',
                        section: [
                            {
                                type: 'ATOM',
                                value: 'MODIFIED'
                            },
                            {
                                type: 'SEQUENCE',
                                value: state.modified.sort((a, b) => a - b).join(',')
                            }
                        ]
                    }
                ].concat(response.attributes || []);
            }
            return;
        }

        if (description === 'ENABLED' && Array.isArray(extra) && extra.indexOf('CONDSTORE') >= 0) {
            // ENABLE CONDSTORE was issued
            if (!connection.condstoreEnabled) {
                connection.condstoreEnabled = true;
                if (connection.state === 'Selected' && connection.selectedMailbox) {
                    parsed.condstoreReportHighest = true;
                }
            }
            return;
        }

        if (description === 'ENABLE' && parsed.condstoreReportHighest && connection.selectedMailbox) {
            parsed.condstoreReportHighest = false;
            sendHighestModseq(connection, connection.selectedMailbox, parsed, data);
            return;
        }

        // Add CONDSTORE info to SELECT and EXAMINE
        if ((description === 'EXAMINE' || description === 'SELECT') && response.tag === parsed.tag && connection.selectedMailbox) {
            // (CONDSTORE) option was used, show notice
            if (parsed.condstoreOption) {
                const last = response.attributes && response.attributes.slice(-1)[0];
                if (!last || last.type !== 'TEXT') {
                    response.attributes = (response.attributes || []).concat({
                        type: 'TEXT',
                        value: 'CONDSTORE is now enabled'
                    });
                } else {
                    last.value += ', CONDSTORE is now enabled';
                }
            }

            // Send untagged info about highest modseq
            sendHighestModseq(connection, connection.selectedMailbox, parsed, data);
        }
    });
};

// RFC 7162 section 7: mod-sequence-valzer = "0" / mod-sequence-value. Dovecot also accepts values above 63 bits
function parseModseqValzer(value) {
    if (!/^\d+$/.test(value) || BigInt(value) > MAX_MODSEQ) {
        throw badError('MODSEQ expects a mod-sequence value');
    }
    return Number(value);
}

// RFC 7162 section 7: entry-flag-name = DQUOTE "/flags/" attr-flag DQUOTE, attr-flag is a flag without "\Recent"
function parseEntryName(value) {
    const match = value.match(/^\/flags\/(\\?)(.+)$/i);
    if (!match || INVALID_KEYWORD_CHAR.test(match[2]) || (match[1] && match[2].toUpperCase() === 'RECENT')) {
        throw badError('MODSEQ expects an entry name like "/flags/\\\\seen"');
    }
    return value;
}

// RFC 7162 section 7: entry-type-req = "priv" / "shared" / "all"
function parseEntryType(value) {
    if (!['PRIV', 'SHARED', 'ALL'].includes(value.toUpperCase())) {
        throw badError('MODSEQ expects entry type priv, shared or all');
    }
    return value;
}

// Serialized message metadata, used to detect changes
function snapshot(message) {
    return JSON.stringify([message.flags || [], message['X-GM-LABELS'] || []]);
}

function findItem(list, name) {
    if (!Array.isArray(list)) {
        return -1;
    }
    for (let i = 0; i < list.length; i += 2) {
        if (list[i] && list[i].type === 'ATOM' && String(list[i].value).toUpperCase() === name) {
            return i;
        }
    }
    return -1;
}

// Sets or adds the MODSEQ value in a FETCH response attribute list
function setModseqValue(list, modseq) {
    if (!Array.isArray(list)) {
        return;
    }
    const pos = findItem(list, 'MODSEQ');
    if (pos >= 0) {
        list[pos + 1] = [modseq];
    } else {
        list.push(
            {
                type: 'ATOM',
                value: 'MODSEQ'
            },
            [modseq]
        );
    }
}

// Adds the UID to a FETCH response attribute list unless it is there already
function setUidValue(list, uid) {
    if (Array.isArray(list) && findItem(list, 'UID') < 0) {
        list.push(
            {
                type: 'ATOM',
                value: 'UID'
            },
            uid
        );
    }
}

function isModseqAtom(item) {
    return !!item && item.type === 'ATOM' && String(item.value).toUpperCase() === 'MODSEQ';
}

function hasModseqItem(parsed) {
    const items = parsed.attributes && parsed.attributes[1];
    return Array.isArray(items) ? items.some(isModseqAtom) : isModseqAtom(items);
}

// Adds MODSEQ to the list of FETCH data items, unless it is already there
function addModseqItem(parsed) {
    if (!parsed.attributes || !parsed.attributes[1] || hasModseqItem(parsed)) {
        return;
    }
    let items = parsed.attributes[1];
    if (!Array.isArray(items)) {
        const name = String(items.value).toUpperCase();
        const macro = items.type === 'ATOM' && Object.hasOwn(FETCH_MACROS, name) && FETCH_MACROS[name];
        // a single fetch-att keeps the arguments that follow it, eg. RFC 8970 PREVIEW (LAZY)
        items = macro ? macro.map(value => ({ type: 'ATOM', value })) : [items].concat(parsed.attributes.splice(2));
    }
    parsed.attributes[1] = items.concat({
        type: 'ATOM',
        value: 'MODSEQ'
    });
}

function hasCondstoreOption(attributes, parent, index) {
    if (!attributes) {
        return false;
    }
    let condstoreOption = false;
    if (Array.isArray(attributes)) {
        for (let i = attributes.length - 1; i >= 0; i--) {
            if (attributes[i] && attributes[i].type === 'ATOM' && attributes[i].value.toUpperCase() === 'CONDSTORE') {
                attributes.splice(i, 1);
                condstoreOption = true;
                break;
            }
        }

        // remove parameter if no other memebers were left
        if (!attributes.length) {
            parent.splice(index, 1);
        }
    }
    return !!condstoreOption;
}

function getCondstoreValue(attributes, name, parent, index) {
    if (!attributes) {
        return false;
    }
    let condstoreValue = false;
    if (Array.isArray(attributes)) {
        for (let i = 0; i < attributes.length; i += 2) {
            if (attributes[i] && attributes[i].type === 'ATOM' && attributes[i].value.toUpperCase() === name.toUpperCase()) {
                // a missing value is reported as a syntax error
                condstoreValue = attributes[i + 1] || { type: 'NIL' };
                attributes.splice(i, 2);
                break;
            }
        }

        // remove parameter if no other memebers were left
        if (!attributes.length) {
            parent.splice(index, 1);
        }
    }

    return condstoreValue;
}
