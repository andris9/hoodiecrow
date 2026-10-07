'use strict';

const { states } = require('../command-states');
const { fetchResponse } = require('../commands/fetch');
const builtinFetchHandlers = require('../commands/handlers/fetch');
const { statusResponse } = require('../commands/handlers/status');
const { badError } = require('../commands/handlers/search');
const { isAtom, isAstring } = require('../arguments');

/**
 * @help Adds NOTIFY [RFC5465] capability. Events: MessageNew (with
 * @help fetch attributes for the selected mailbox), MessageExpunge,
 * @help FlagChange, MailboxName, SubscriptionChange, and with METADATA
 * @help MailboxMetadataChange and ServerMetadataChange.
 * @help server.notifyOverflow([connection]) sends
 * @help "* OK [NOTIFICATIONOVERFLOW]" and turns NOTIFY off
 *
 * NOTIFY: https://www.rfc-editor.org/rfc/rfc5465
 *
 * Additional commands:
 * - NOTIFY SET [STATUS] event-groups, NOTIFY NONE
 *
 * After the first NOTIFY command the session gets only the events it asked for (RFC 5465 section 3.1),
 * also between commands. Events caused by the session itself are not reported (section 5), the
 * responses of its own commands are sent as usual. Fetch attributes of MessageNew never set \Seen,
 * clients SHOULD NOT use such attributes anyway (section 5.2).
 */

// RFC 5465 section 8, canonical names by upper case name
const MESSAGE_EVENTS = ['MessageNew', 'MessageExpunge', 'FlagChange', 'AnnotationChange'];
const EVENT_NAMES = new Map(
    MESSAGE_EVENTS.concat(['MailboxName', 'SubscriptionChange', 'MailboxMetadataChange', 'ServerMetadataChange']).map(name => [name.toUpperCase(), name])
);
const SELECTED_FILTERS = ['SELECTED', 'SELECTED-DELAYED'];
const OTHER_FILTERS = ['INBOXES', 'PERSONAL', 'SUBSCRIBED', 'SUBTREE', 'MAILBOXES'];
// fetch items whose arguments are checked with a dry run when NOTIFY SET is parsed
const SECTION_ITEMS = ['BODY', 'BODY.PEEK', 'BINARY', 'BINARY.PEEK', 'BINARY.SIZE'];

module.exports = function (server) {
    server.registerCapability('NOTIFY');

    // NOTIFY needs the authenticated state, UNAUTHENTICATE clears the settings
    const isActive = connection => !!connection.notifyState;

    // RFC 5465 sections 5.6 and 5.7: the metadata events are supported (and REQUIRED) with METADATA or METADATA-SERVER
    const getSupportedEvents = () => {
        const supported = ['MessageNew', 'MessageExpunge', 'FlagChange', 'MailboxName', 'SubscriptionChange'];
        if (server.capabilities.METADATA) {
            supported.push('MailboxMetadataChange');
        }
        if (server.capabilities.METADATA || server.capabilities['METADATA-SERVER']) {
            supported.push('ServerMetadataChange');
        }
        return supported;
    };

    // Access checks, RFC 5465 section 3.1 and section 5: every event needs the "l" and "r" rights
    const hasRights = (connection, mailbox, letters, acl) => {
        const rights = server.acl && server.acl.getRights(connection, mailbox, acl);
        return !rights || [...letters].every(letter => rights.has(letter));
    };
    const canList = (connection, mailbox, acl) => hasRights(connection, mailbox, 'l', acl);
    const canRead = (connection, mailbox, acl) => hasRights(connection, mailbox, 'lr', acl);

    const normalizePath = path => (path.toUpperCase() === 'INBOX' ? 'INBOX' : path);

    /**
     * Checks if an event group of NOTIFY SET covers a mailbox name (RFC 5465 section 6)
     *
     * @param {Object} group Parsed event group
     * @param {String} path Storage name
     * @param {Object} [mailbox] Mailbox object, if the mailbox exists
     * @param {Boolean} [subscription] true for a subscription change, the subscribed filter covers both states
     */
    const covers = (group, path, mailbox, subscription) => {
        switch (group.filter) {
            case 'INBOXES':
            // RFC 5465 section 6.3: a server that can not tell which mailboxes get mail treats it as "personal"
            // falls through
            case 'PERSONAL':
                return server.isPersonal(path);
            case 'SUBSCRIBED':
                // RFC 5465 section 6.4: the list is reevaluated when subscriptions change
                return !!subscription || !!(mailbox && mailbox.subscribed);
            case 'SUBTREE':
                return group.paths.indexOf(path) >= 0 || group.prefixes.some(prefix => path.substr(0, prefix.length) === prefix);
            case 'MAILBOXES':
                // RFC 5465 section 6.6: no wildcard expansion
                return group.paths.indexOf(path) >= 0;
        }
        return false;
    };

    /**
     * Lists the events a session asked for on a mailbox other than the selected one. Several groups
     * can cover the same mailbox (RFC 5465 section 6), message events for the selected mailbox only
     * come from SELECTED or SELECTED-DELAYED (section 3.1)
     *
     * @return {Set} event names
     */
    const getEvents = (connection, path, mailbox, subscription) => {
        const events = new Set();
        connection.notifyState.groups.forEach(group => {
            if (covers(group, path, mailbox, subscription)) {
                group.events.forEach(event => events.add(event));
            }
        });
        if (mailbox && mailbox === connection.selectedMailbox) {
            MESSAGE_EVENTS.forEach(event => events.delete(event));
        }
        return events;
    };

    // RFC 5465 section 6.1.2: with SELECTED-DELAYED an expunge waits for a command that allows it
    const isHeld = connection =>
        !!(connection.notifyState.selected && connection.notifyState.selected.delayed) && !connection.directNotifications && connection.hasPendingExpunge();

    /**
     * Sends the queued notifications of a session that is between commands (RFC 5465 section 3.1: the
     * client listens all the time). During a command they wait for its tagged response
     */
    const flush = connection => {
        if (!connection.socket || !connection.notificationQueue.length || connection._runningCommand || !isActive(connection) || isHeld(connection)) {
            return;
        }
        connection.processNotifications();
    };

    // the events of one command go out together, e.g. several expunges as one VANISHED response (QRESYNC)
    const scheduleFlush = connection => {
        if (!connection.notifyFlushPending) {
            connection.notifyFlushPending = true;
            setImmediate(() => {
                connection.notifyFlushPending = false;
                flush(connection);
            });
        }
    };

    /**
     * Sends an event response about another mailbox or about the server
     *
     * @param {Object} connection IMAP connection
     * @param {Object} response Untagged response
     */
    const deliver = (connection, response) => {
        response.tag = '*';
        response.notification = true;
        if (!connection._runningCommand && isHeld(connection)) {
            // this does not change message sequence numbers, so it does not have to wait for the expunge
            connection.send(response, 'NOTIFY EVENT');
            return;
        }
        connection.notificationQueue.push(response);
        scheduleFlush(connection);
    };

    // the sessions that use NOTIFY, other than the one that caused a change (RFC 5465 section 5: SHOULD omit)
    const listeners = origin => [...server.connections].filter(connection => connection !== origin && isActive(connection));

    /**
     * Builds an unsolicited STATUS response for a mailbox. With FlagChange the UNSEEN count is added
     * when it changed since the session last heard of it (RFC 5465 section 5.1), with CONDSTORE (or
     * QRESYNC) enabled HIGHESTMODSEQ as well (sections 5.1, 5.2 and 5.3)
     *
     * @return {Object|Boolean} response, or false if there is nothing to tell
     */
    const eventStatus = (connection, mailbox, items, events) => {
        items = items.slice();
        if (events.has('FlagChange')) {
            const unseen = server.getStatus(mailbox).unseen || 0;
            if (connection.notifyState.unseen.get(mailbox) !== unseen) {
                connection.notifyState.unseen.set(mailbox, unseen);
                items.push('UNSEEN');
            }
        }
        if (server.condstore && server.condstore.isEnabled(connection)) {
            items.push('HIGHESTMODSEQ');
        }
        if (!items.length) {
            return false;
        }
        return statusResponse(connection, mailbox.path, mailbox, items);
    };

    // Reports a change of the messages of a mailbox that is not selected (RFC 5465 sections 5.1, 5.2 and 5.3)
    const messageEvent = (mailbox, event, items, origin) => {
        listeners(origin).forEach(connection => {
            if (mailbox === connection.selectedMailbox || !canRead(connection, mailbox)) {
                return;
            }
            const events = getEvents(connection, mailbox.path, mailbox);
            if (!events.has(event)) {
                return;
            }
            const response = eventStatus(
                connection,
                mailbox,
                event === 'FlagChange' && server.condstore && server.condstore.isEnabled(connection) ? ['UIDVALIDITY'] : items,
                events
            );
            if (response) {
                deliver(connection, response);
            }
        });
    };

    // Checks if any mailbox below a mailbox is visible to the session (RFC 3348 section 4)
    const hasVisibleChildren = (connection, path) =>
        server.hasDescendant(path, child => canList(connection, child) && child.flags.indexOf('\\NonExistent') < 0);

    /**
     * Builds an unsolicited LIST response with accurate attributes (RFC 5465 sections 5.4 and 5.5)
     *
     * @param {Object} connection IMAP connection
     * @param {String} path Storage name
     * @param {Object} [options] `{ oldPath, noAccess, exists }`, `exists: false` reports the name as \NonExistent
     */
    const listResponse = (connection, path, options) => {
        options = options || {};
        const mailbox = server.getMailbox(path);
        const exists = options.exists !== false && !!mailbox && canList(connection, mailbox);
        const flags = server.listAttributes(exists ? mailbox : null, {
            exists,
            subscribed: exists && mailbox.subscribed,
            extra: options.noAccess ? ['\\NoAccess'] : [],
            hasChildren: hasVisibleChildren(connection, path)
        });
        const attributes = [flags.map(flag => ({ type: 'ATOM', value: flag })), server.getSeparator(path), { type: 'MAILBOX', value: path }];
        if (options.oldPath) {
            // RFC 5465 section 5.4, the OLDNAME extended data item (mbox-list-extended)
            attributes.push([{ type: 'STRING', value: 'OLDNAME' }, [{ type: 'STRING', value: connection.exportMailboxName(options.oldPath) }]]);
        }
        return { tag: '*', command: 'LIST', attributes };
    };

    // RFC 5465 section 5.4: a created or deleted mailbox and its direct parent are affected
    const nameEvent = (connection, path, mailbox, exists) => {
        [path, server.getParentPath(path)].forEach(name => {
            if (!name) {
                return;
            }
            const target = name === path ? mailbox : server.getMailbox(name);
            if (getEvents(connection, name, target).has('MailboxName')) {
                deliver(connection, listResponse(connection, name, name === path ? { exists } : {}));
            }
        });
    };

    // RFC 5465 section 5.1: with FlagChange the server MUST tell about UIDVALIDITY changes, a mailbox that
    // gets a name that is watched has a new UIDVALIDITY
    const uidvalidityEvent = (connection, mailbox) => {
        if (mailbox !== connection.selectedMailbox && canRead(connection, mailbox) && getEvents(connection, mailbox.path, mailbox).has('FlagChange')) {
            deliver(connection, eventStatus(connection, mailbox, ['MESSAGES', 'UIDNEXT', 'UIDVALIDITY'], new Set(['FlagChange'])));
        }
    };

    server.on('mailbox', change => {
        const mailbox = server.getMailbox(change.path);
        listeners(change.origin).forEach(connection => {
            switch (change.type) {
                case 'create':
                    if (mailbox && canList(connection, mailbox)) {
                        nameEvent(connection, change.path, mailbox, true);
                        uidvalidityEvent(connection, mailbox);
                    }
                    break;
                case 'delete':
                    if (change.mailbox && canList(connection, change.mailbox)) {
                        nameEvent(connection, change.path, mailbox, !!mailbox);
                    }
                    break;
                case 'rename':
                    // RFC 5465 section 5.4: one LIST response for the new name, none for the children
                    if (mailbox && canList(connection, mailbox)) {
                        const events = getEvents(connection, change.path, mailbox);
                        getEvents(connection, change.oldPath).forEach(event => events.add(event));
                        if (events.has('MailboxName')) {
                            deliver(connection, listResponse(connection, change.path, { oldPath: change.oldPath }));
                        }
                        uidvalidityEvent(connection, mailbox);
                    }
                    break;
                case 'subscribe':
                case 'unsubscribe':
                    // RFC 5465 section 5.5
                    if (mailbox && canList(connection, mailbox) && getEvents(connection, change.path, mailbox, true).has('SubscriptionChange')) {
                        deliver(connection, listResponse(connection, change.path));
                    }
                    break;
            }
        });
    });

    // RFC 5465 section 5.4: granting or revoking the "l" right counts as creating or deleting the mailbox. Section 5.9:
    // monitoring stops without the rights and starts again when they are granted, \NoAccess tells about the "r" right
    server.on('acl', (mailbox, previous) => {
        listeners(null).forEach(connection => {
            const before = { list: canList(connection, mailbox, previous), read: canRead(connection, mailbox, previous) };
            const after = { list: canList(connection, mailbox), read: canRead(connection, mailbox) };
            if (before.list !== after.list) {
                nameEvent(connection, mailbox.path, mailbox, after.list);
            } else if (after.list && before.read !== after.read) {
                const events = getEvents(connection, mailbox.path, mailbox);
                if (MESSAGE_EVENTS.some(event => events.has(event))) {
                    deliver(connection, listResponse(connection, mailbox.path, { noAccess: !after.read }));
                }
            }
        });
    });

    server.on('expunge', (mailbox, messages, origin) => messageEvent(mailbox, 'MessageExpunge', ['MESSAGES', 'UIDNEXT'], origin));

    server.on('notify', notification => {
        const command = notification.command || {};
        const mailbox = typeof notification.mailbox === 'string' ? server.getMailbox(notification.mailbox) : notification.mailbox;

        if (mailbox && command.flagUpdate) {
            messageEvent(mailbox, 'FlagChange', [], notification.origin);
        } else if (mailbox && command.message && isAtom(command.attributes && command.attributes[1], 'EXISTS')) {
            messageEvent(mailbox, 'MessageNew', ['MESSAGES', 'UIDNEXT'], notification.origin);
        } else if (command.command === 'METADATA' && command.attributes && command.attributes[0]) {
            // RFC 5465 sections 5.6 and 5.7: METADATA responses without ENABLE METADATA
            const path = command.attributes[0].value;
            const target = path === '' ? null : server.getMailbox(path);
            listeners(notification.origin).forEach(connection => {
                let wanted;
                if (path === '') {
                    wanted = connection.notifyState.groups.some(group => group.events.has('ServerMetadataChange'));
                } else {
                    wanted = !!target && canRead(connection, target) && getEvents(connection, path, target).has('MailboxMetadataChange');
                }
                if (wanted) {
                    notification.notifyHandled = notification.notifyHandled || new Set();
                    notification.notifyHandled.add(connection);
                    deliver(connection, Object.assign({}, command));
                }
            });
        }
    });

    // a METADATA response that NOTIFY sent already does not go out again for ENABLE METADATA
    server.notifyFilters.push((connection, notification) => !(notification.notifyHandled && notification.notifyHandled.has(connection)));

    // Which message event a notification for the selected mailbox is
    const selectedEvent = command => {
        if (command.flagUpdate) {
            return 'FlagChange';
        }
        const type = command.attributes && command.attributes[1];
        if (isAtom(type, 'EXPUNGE')) {
            return 'MessageExpunge';
        }
        if (isAtom(type, 'EXISTS')) {
            // the EXISTS after expunges carries a snapshot, the one of a new message the message
            return command.message ? 'MessageNew' : 'MessageExpunge';
        }
        return false;
    };

    // Builds the FETCH response for a new message in the selected mailbox (RFC 5465 section 5.2)
    const newMessageFetch = (connection, items, sequence, message) => {
        const params = items.map(item => Object.assign({}, item));
        let data;
        try {
            data = fetchResponse(connection, message, params);
        } catch {
            // the items were checked by NOTIFY SET, a failure here leaves out the FETCH response
            return false;
        }
        // the message goes with the response for output handlers (UIDONLY reports its UID). Not as `message`, that
        // marks an EXPUNGE notification
        return { tag: '*', notification: true, attributes: [sequence, { type: 'ATOM', value: 'FETCH' }, data], fetchedMessage: message };
    };

    server.connectionHandlers.push(connection => {
        connection.notifyState = null;

        const queueNotification = connection.queueNotification;
        connection.queueNotification = function (command, notification) {
            const event = notification && notification.mailbox && selectedEvent(command);
            if (!isActive(this) || !event || notification.origin === this) {
                // responses to the own commands of the session are not NOTIFY events
                return queueNotification.call(this, command, notification);
            }
            const selected = this.notifyState.selected;
            if (!selected || !selected.events.has(event) || !canRead(this, this.selectedMailbox)) {
                // RFC 5465 section 3.1: without SELECTED or SELECTED-DELAYED (or without the event) the client
                // does not want to hear about it
                return;
            }
            this.notificationQueue.push(command);
            if (event === 'MessageNew' && selected.fetch) {
                // the EXISTS response gives the sequence number of the new message
                const fetch = newMessageFetch(this, selected.fetch, command.attributes[0], command.message);
                if (fetch) {
                    this.notificationQueue.push(fetch);
                }
            }
            scheduleFlush(this);
        };
    });

    // RFC 8437 section 4.1: UNAUTHENTICATE forgets the NOTIFY settings
    server.resetHandlers.push(connection => {
        connection.notifyState = null;
    });

    // notifications held back during a command (FETCH, STORE, SEARCH) go out once it completed
    server.outputHandlers.push((connection, response) => {
        if (response.tag !== '*' && !response.notification && isActive(connection) && connection.notificationQueue.length) {
            scheduleFlush(connection);
        }
    });

    /**
     * RFC 5465 section 5.8: disables notifications for a session (or all sessions that use NOTIFY),
     * which get an untagged OK [NOTIFICATIONOVERFLOW] and behave as after NOTIFY NONE
     *
     * @param {Object} [target] IMAP connection, all sessions if not set
     */
    server.notifyOverflow = target => {
        listeners(null)
            .filter(connection => !target || connection === target)
            .forEach(connection => {
                connection.notifyState = { selected: null, groups: [], unseen: new WeakMap() };
                deliver(connection, {
                    command: 'OK',
                    attributes: [
                        { type: 'SECTION', section: [{ type: 'ATOM', value: 'NOTIFICATIONOVERFLOW' }] },
                        { type: 'TEXT', value: 'Too many notifications, NOTIFY is turned off' }
                    ]
                });
            });
    };

    /**
     * Parses the fetch attributes of MessageNew (RFC 5465 section 8: "(" fetch-att *(SP fetch-att) ")")
     *
     * @param {Object} connection IMAP connection
     * @param {Array} list Parsed list
     * @return {Array} fetch items
     */
    const parseFetchAtts = (connection, list) => {
        if (!list.length) {
            throw badError('MessageNew expects a list of fetch attributes');
        }
        return list.map(item => {
            const key = isAtom(item) && item.value.toUpperCase();
            // macros like ALL are not fetch-att values
            if (!key || !(server.fetchHandlers[key] || builtinFetchHandlers[key])) {
                throw badError('Invalid fetch attribute for MessageNew');
            }
            if ((item.section || item.partial) && SECTION_ITEMS.indexOf(key) >= 0) {
                // check the section and the partial range against a message
                const params = [Object.assign({}, item)];
                try {
                    fetchResponse(connection, { raw: 'Subject: test\r\n\r\nTest\r\n', flags: [], uid: 1 }, params);
                } catch (err) {
                    throw badError(err.message);
                }
            }
            return item;
        });
    };

    /**
     * Parses the events of an event group (RFC 5465 section 8: events = ( "(" event *(SP event) ")" ) / "NONE")
     *
     * @param {Object} connection IMAP connection
     * @param {Object|Array} value Parsed events
     * @param {Boolean} selected true for SELECTED and SELECTED-DELAYED
     * @param {Array} unknown Collects the unknown event names
     * @return {Object} `{ events, fetch }`
     */
    const parseEvents = (connection, value, selected, unknown) => {
        const events = new Set();
        let fetch = null;
        if (isAtom(value, 'NONE')) {
            return { events, fetch };
        }
        if (!Array.isArray(value) || !value.length) {
            throw badError('Expecting a list of events or NONE');
        }
        for (let i = 0; i < value.length; i++) {
            const item = value[i];
            if (!isAtom(item) || item.section || item.partial) {
                throw badError('Invalid event');
            }
            const name = EVENT_NAMES.get(item.value.toUpperCase());
            if (Array.isArray(value[i + 1]) && name === 'MessageNew') {
                // the fetch-att list is only allowed for the selected mailbox (RFC 5465 section 8)
                if (!selected) {
                    throw badError('Fetch attributes for MessageNew are only allowed with SELECTED or SELECTED-DELAYED');
                }
                fetch = parseFetchAtts(connection, value[++i]);
            }
            if (!name) {
                // event-ext: an event this server does not know, NO [BADEVENT] once the syntax is checked
                unknown.push(item.value);
                continue;
            }
            if (selected && MESSAGE_EVENTS.indexOf(name) < 0) {
                // RFC 5465 section 6.1
                throw badError(name + ' can not be used with SELECTED or SELECTED-DELAYED');
            }
            events.add(name);
        }
        // RFC 5465 section 5
        if (events.has('MessageNew') !== events.has('MessageExpunge')) {
            throw badError('MessageNew and MessageExpunge must be used together');
        }
        if ((events.has('FlagChange') || events.has('AnnotationChange')) && !events.has('MessageNew')) {
            throw badError('FlagChange and AnnotationChange require MessageNew and MessageExpunge');
        }
        return { events, fetch };
    };

    // one-or-more-mailbox = mailbox / many-mailboxes, the names are converted to storage names
    const parseMailboxes = (connection, value) => {
        const list = Array.isArray(value) ? value : [value];
        if (!list.length || !list.every(isAstring)) {
            throw badError('Expecting a mailbox name or a list of mailbox names');
        }
        return list.map(item => normalizePath(connection.importMailboxName(item.value)));
    };

    /**
     * Parses the arguments of NOTIFY (RFC 5465 section 8)
     *
     * @return {Object} `{ state, status, unknown }`
     */
    const parseNotify = (connection, args) => {
        // `unseen` holds the UNSEEN count each mailbox had in the last STATUS response the session got
        const state = { selected: null, groups: [], unseen: new WeakMap() };
        const unknown = [];
        if (isAtom(args[0], 'NONE')) {
            if (args.length !== 1) {
                throw badError('NOTIFY NONE does not take any arguments');
            }
            return { state, status: false, unknown };
        }
        if (!isAtom(args[0], 'SET')) {
            throw badError('NOTIFY expects SET or NONE');
        }
        const status = isAtom(args[1], 'STATUS');
        const groups = args.slice(status ? 2 : 1);
        if (!groups.length) {
            throw badError('NOTIFY SET expects event groups');
        }
        groups.forEach(group => {
            if (!Array.isArray(group) || !isAtom(group[0])) {
                throw badError('Invalid event group');
            }
            const filter = group[0].value.toUpperCase();
            if (SELECTED_FILTERS.indexOf(filter) >= 0) {
                if (group.length !== 2) {
                    throw badError('Invalid event group');
                }
                if (state.selected) {
                    // RFC 5465 section 6.1
                    throw badError('Only one of SELECTED and SELECTED-DELAYED can be used');
                }
                state.selected = Object.assign({ delayed: filter === 'SELECTED-DELAYED' }, parseEvents(connection, group[1], true, unknown));
            } else if (OTHER_FILTERS.indexOf(filter) >= 0) {
                const withNames = filter === 'SUBTREE' || filter === 'MAILBOXES';
                if (group.length !== (withNames ? 3 : 2)) {
                    throw badError('Invalid event group');
                }
                const paths = withNames ? parseMailboxes(connection, group[1]) : [];
                const { events } = parseEvents(connection, group[group.length - 1], false, unknown);
                // the names below a SUBTREE root start with these
                const prefixes = filter === 'SUBTREE' ? paths.map(root => root + server.getSeparator(root)) : [];
                state.groups.push({ filter, paths, prefixes, events });
            } else {
                throw badError('Unknown mailbox filter ' + group[0].value);
            }
        });
        return { state, status, unknown };
    };

    // RFC 5465 section 3.1: the initial STATUS responses and the \NoAccess LIST responses of NOTIFY SET
    const sendInitialResponses = (connection, status, parsed, data) => {
        const paths = Object.keys(server.folderCache).sort((a, b) => (a === 'INBOX' ? -1 : b === 'INBOX' ? 1 : a.localeCompare(b)));
        paths.forEach(path => {
            const mailbox = server.folderCache[path];
            if (mailbox === connection.selectedMailbox || mailbox.flags.some(flag => /^\\(Noselect|NonExistent)$/i.test(flag))) {
                return;
            }
            const events = getEvents(connection, path, mailbox);
            if (!events.size || !canList(connection, mailbox)) {
                return;
            }
            if (!canRead(connection, mailbox)) {
                connection.send(listResponse(connection, path, { noAccess: true }), 'NOTIFY LIST', parsed, data);
                return;
            }
            if (!status || !events.has('MessageNew')) {
                return;
            }
            const items = ['MESSAGES', 'UIDNEXT', 'UIDVALIDITY'];
            if (events.has('FlagChange')) {
                items.push('UNSEEN');
                connection.notifyState.unseen.set(mailbox, server.getStatus(mailbox).unseen || 0);
                if (server.condstore) {
                    items.push('HIGHESTMODSEQ');
                }
            }
            connection.send(statusResponse(connection, path, mailbox, items), 'NOTIFY STATUS', parsed, data);
        });
    };

    server.setCommandHandler(
        'NOTIFY',
        (connection, parsed, data, callback) => {
            let result;
            try {
                result = parseNotify(connection, parsed.attributes || []);
            } catch (err) {
                connection.sendStatus(parsed, data, 'BAD', err.imapResponse === 'BAD' ? err.message : 'Invalid NOTIFY arguments');
                return callback();
            }

            const supported = getSupportedEvents();
            const used = [result.state.selected].concat(result.state.groups).filter(group => group);
            const unsupported = result.unknown.concat(...used.map(group => [...group.events].filter(event => supported.indexOf(event) < 0)));
            if (unsupported.length) {
                // RFC 5465 section 3.1: NO with BADEVENT, which MUST list all supported events
                connection.send(
                    {
                        tag: parsed.tag,
                        command: 'NO',
                        attributes: [
                            { type: 'SECTION', section: [{ type: 'ATOM', value: 'BADEVENT' }, supported.map(event => ({ type: 'ATOM', value: event }))] },
                            { type: 'TEXT', value: 'Unsupported NOTIFY events' }
                        ]
                    },
                    'NOTIFY FAILED',
                    parsed,
                    data
                );
                return callback();
            }

            connection.notifyState = result.state;
            sendInitialResponses(connection, result.status, parsed, data);

            // the tagged response sends the changes of the selected mailbox, NOTIFY SET implies NOOP (section 3.1)
            connection.sendStatus(parsed, data, 'OK', 'NOTIFY completed');
            return callback();
        },
        { states: states.AUTHENTICATED }
    );
};
