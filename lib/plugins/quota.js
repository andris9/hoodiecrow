'use strict';

const { states } = require('../command-states');
const { normalizeLineBreaks } = require('../mimeparser');

// Resource types of RFC 9208 section 5 that can be counted. ANNOTATION-STORAGE is left out,
// as there is no ANNOTATE support
const RESOURCES = ['STORAGE', 'MESSAGE', 'MAILBOX'];
const DEFAULT_ROOT = 'User quota';
// RFC 9051 section 9: number64 = 1*DIGIT, unsigned 63-bit integer
const MAX_NUMBER64 = 2n ** 63n - 1n;

/**
 * @help Adds QUOTA [RFC9208] capability with the STORAGE, MESSAGE and MAILBOX
 * @help resources and SETQUOTA. All personal mailboxes share one quota root, set
 * @help with the "quota" server option, eg. {"root": "User quota",
 * @help "STORAGE": 10240, "MESSAGE": 1000, "MAILBOX": 100, "soft": false}.
 * @help STORAGE is in units of 1024 octets. Hard limits make APPEND, COPY, MOVE
 * @help and CREATE fail with NO [OVERQUOTA], soft limits only send a warning
 *
 * QUOTA: https://www.rfc-editor.org/rfc/rfc9208.txt
 *
 * Additional commands:
 * - GETQUOTA, GETQUOTAROOT, SETQUOTA
 *
 * Additional STATUS items:
 * - DELETED, DELETED-STORAGE
 */
module.exports = function (server) {
    const config = server.options.quota || {};
    const root = {
        name: typeof config.root === 'string' ? config.root : DEFAULT_ROOT,
        soft: !!config.soft,
        limits: {}
    };

    RESOURCES.forEach(resource => {
        if (config[resource] === undefined || config[resource] === null) {
            return;
        }
        const limit = Number(config[resource]);
        if (!Number.isSafeInteger(limit) || limit < 0) {
            throw new Error('Invalid quota limit for ' + resource + ': ' + JSON.stringify(config[resource]));
        }
        root.limits[resource] = limit;
    });

    // RFC 9208 sections 3.1.1 and 5: every supported resource is advertised, SETQUOTA needs QUOTASET
    server.registerCapability('QUOTA');
    RESOURCES.forEach(resource => server.registerCapability('QUOTA=RES-' + resource));
    server.registerCapability('QUOTASET');

    // Personal mailboxes, INBOX included, belong to the quota root. Other namespaces have no quota root
    const isPersonal = namespace => namespace === 'INBOX' || (namespace !== false && server.storage[namespace].type === 'personal');

    // a mailbox that does not exist yet belongs to the namespace of its prefix
    const inRoot = path => {
        const mailbox = server.getMailbox(path);
        return isPersonal(mailbox ? mailbox.namespace : server.getNamespace(path));
    };

    const isSelectable = mailbox => mailbox.flags.indexOf('\\Noselect') < 0;

    // RFC822.SIZE, the message with CRLF line breaks
    const totalSize = messages => messages.reduce((total, message) => total + normalizeLineBreaks(message.raw).length, 0);

    const getUsage = () => {
        const usage = { MESSAGE: 0, MAILBOX: 0, bytes: 0 };
        Object.keys(server.folderCache).forEach(path => {
            const mailbox = server.folderCache[path];
            if (!isSelectable(mailbox) || !isPersonal(mailbox.namespace)) {
                return;
            }
            usage.MAILBOX++;
            usage.MESSAGE += mailbox.messages.length;
            usage.bytes += totalSize(mailbox.messages);
        });
        return usage;
    };

    // RFC 9208 section 4.2.1: quota-list, resources that are not listed are not limited
    const sendQuota = (connection, parsed, data) => {
        const usage = getUsage();
        // RFC 9208 section 5.1: units of 1024 octets
        usage.STORAGE = Math.ceil(usage.bytes / 1024);
        const list = [];
        RESOURCES.forEach(resource => {
            if (resource in root.limits) {
                list.push({ type: 'ATOM', value: resource }, usage[resource], root.limits[resource]);
            }
        });
        connection.send(
            {
                tag: '*',
                command: 'QUOTA',
                attributes: [{ type: 'STRING', value: root.name }, list]
            },
            'QUOTA',
            parsed,
            data
        );
    };

    /**
     * Checks if adding to the quota root goes over a limit
     *
     * @param {Object} added Added amounts, `{ MESSAGE, MAILBOX, bytes }`
     * @return {Object|undefined} `{ code, text, soft }` for IMAPConnection#checkAppend, or nothing if within limits
     */
    const checkLimits = added => {
        const limited = (added.MESSAGE && 'MESSAGE' in root.limits) || (added.bytes && 'STORAGE' in root.limits) || (added.MAILBOX && 'MAILBOX' in root.limits);
        if (!limited) {
            return;
        }
        const usage = getUsage();
        const over =
            (added.MESSAGE && 'MESSAGE' in root.limits && usage.MESSAGE + added.MESSAGE > root.limits.MESSAGE) ||
            (added.bytes && 'STORAGE' in root.limits && usage.bytes + added.bytes > root.limits.STORAGE * 1024) ||
            (added.MAILBOX && 'MAILBOX' in root.limits && usage.MAILBOX + added.MAILBOX > root.limits.MAILBOX);
        if (!over) {
            return;
        }
        // RFC 9208 section 4.3.1 and RFC 5530 section 3
        return root.soft ? { code: 'OVERQUOTA', text: 'Soft quota has been exceeded', soft: true } : { code: 'OVERQUOTA', text: 'Quota exceeded' };
    };

    // APPEND, COPY and MOVE
    server.appendChecks.push((connection, mailbox, messages, options) => {
        if (!messages.length || !inRoot(mailbox.path)) {
            return;
        }
        if (options.move && options.source && inRoot(options.source.path)) {
            // moving within the quota root does not change the usage
            return;
        }
        return checkLimits({
            MESSAGE: messages.length,
            bytes: totalSize(messages)
        });
    });

    // Number of mailboxes that CREATE adds, missing parent mailboxes are created as well
    const countNewMailboxes = path => {
        const namespaceKey = server.getNamespace(path) || '';
        const separator = (server.storage[namespaceKey] || {}).separator || '/';
        if (path.substr(-separator.length) === separator) {
            path = path.substr(0, path.length - separator.length);
        }
        const names = path.substr(namespaceKey.length).split(separator);
        let count = 0;
        let curPath = namespaceKey;
        names.forEach((name, i) => {
            curPath += (i ? separator : '') + name;
            const mailbox = server.getMailbox(curPath);
            if (!mailbox || (i === names.length - 1 && !isSelectable(mailbox))) {
                count++;
            }
        });
        return count;
    };

    // The MAILBOX resource limits CREATE and RENAME INBOX (which creates a mailbox)
    const wrapCreate = (command, getPath) => {
        const prevHandler = server.getCommandHandler(command);
        server.setCommandHandler(command, (connection, parsed, data, callback) => {
            const path = getPath(parsed.attributes);
            if (
                typeof path === 'string' &&
                path.toUpperCase() !== 'INBOX' &&
                inRoot(path) &&
                !connection.applyChecks([checkLimits({ MAILBOX: countNewMailboxes(path) })], parsed, data, command + ' FAILED')
            ) {
                return callback();
            }
            prevHandler(connection, parsed, data, callback);
        });
    };

    const isAstring = attr => !!attr && ['ATOM', 'STRING', 'LITERAL'].indexOf(attr.type) >= 0;
    const argValue = (attributes, i) => isAstring((attributes || [])[i]) && attributes[i].value;

    wrapCreate('CREATE', attributes => (attributes && attributes.length === 1 ? argValue(attributes, 0) : false));
    wrapCreate('RENAME', attributes => {
        const source = argValue(attributes, 0);
        // only RENAME INBOX adds a mailbox, other renames keep the count (RFC 3501 section 6.3.5)
        return attributes && attributes.length === 2 && typeof source === 'string' && source.toUpperCase() === 'INBOX' ? argValue(attributes, 1) : false;
    });

    // RFC 9208 section 4.1.1: GETQUOTA quota-root-name
    server.setCommandHandler(
        'GETQUOTA',
        (connection, parsed, data, callback) => {
            if (!parsed.attributes || parsed.attributes.length !== 1 || !isAstring(parsed.attributes[0])) {
                connection.sendStatus(parsed, data, 'BAD', 'GETQUOTA expects a quota root name');
                return callback();
            }
            if (parsed.attributes[0].value !== root.name) {
                connection.sendStatus(parsed, data, 'NO', 'Quota root does not exist', 'NONEXISTENT');
                return callback();
            }
            sendQuota(connection, parsed, data);
            connection.sendStatus(parsed, data, 'OK', 'GETQUOTA completed');
            return callback();
        },
        { states: states.AUTHENTICATED }
    );

    // RFC 9208 section 4.1.2: GETQUOTAROOT mailbox, the mailbox does not have to exist
    server.setCommandHandler(
        'GETQUOTAROOT',
        (connection, parsed, data, callback) => {
            if (!parsed.attributes || parsed.attributes.length !== 1 || !isAstring(parsed.attributes[0])) {
                connection.sendStatus(parsed, data, 'BAD', 'GETQUOTAROOT expects a mailbox name');
                return callback();
            }
            let path = parsed.attributes[0].value;
            if (path.toUpperCase() === 'INBOX') {
                path = 'INBOX';
            }
            const hasRoot = inRoot(path);
            connection.send(
                {
                    tag: '*',
                    command: 'QUOTAROOT',
                    attributes: [{ type: 'ATOM', value: path }].concat(hasRoot ? { type: 'STRING', value: root.name } : [])
                },
                'QUOTAROOT',
                parsed,
                data
            );
            if (hasRoot) {
                sendQuota(connection, parsed, data);
            }
            connection.sendStatus(parsed, data, 'OK', 'GETQUOTAROOT completed');
            return callback();
        },
        { states: states.AUTHENTICATED, mailboxArguments: [0] }
    );

    // RFC 9208 section 4.1.3: SETQUOTA quota-root-name setquota-list, the new limits replace all earlier ones
    server.setCommandHandler(
        'SETQUOTA',
        (connection, parsed, data, callback) => {
            const list = parsed.attributes && parsed.attributes[1];
            if (!parsed.attributes || parsed.attributes.length !== 2 || !isAstring(parsed.attributes[0]) || !Array.isArray(list) || list.length % 2) {
                connection.sendStatus(parsed, data, 'BAD', 'SETQUOTA expects a quota root name and a list of resource limits');
                return callback();
            }

            const limits = {};
            for (let i = 0; i < list.length; i += 2) {
                const name = list[i];
                const limit = list[i + 1];
                // setquota-resource = resource-name SP resource-limit, resource-limit = number64
                if (!name || name.type !== 'ATOM' || !limit || limit.type !== 'ATOM' || !/^\d+$/.test(limit.value) || BigInt(limit.value) > MAX_NUMBER64) {
                    connection.sendStatus(parsed, data, 'BAD', 'Invalid resource limit');
                    return callback();
                }
                const resource = name.value.toUpperCase();
                if (RESOURCES.indexOf(resource) < 0 || resource in limits) {
                    connection.sendStatus(parsed, data, 'NO', 'Can not set a limit for ' + resource, 'CANNOT');
                    return callback();
                }
                const value = Number(limit.value);
                if (!Number.isSafeInteger(value)) {
                    connection.sendStatus(parsed, data, 'NO', 'Limit is too large for ' + resource, 'LIMIT');
                    return callback();
                }
                limits[resource] = value;
            }

            // new quota roots can not be created
            if (parsed.attributes[0].value !== root.name) {
                connection.sendStatus(parsed, data, 'NO', 'Quota root does not exist', 'NONEXISTENT');
                return callback();
            }

            root.limits = limits;
            sendQuota(connection, parsed, data);
            connection.sendStatus(parsed, data, 'OK', 'SETQUOTA completed');
            return callback();
        },
        { states: states.AUTHENTICATED }
    );

    // RFC 9208 section 4.1.4: DELETED (the built-in item, required with QUOTA=RES-MESSAGE) and DELETED-STORAGE
    // (required with QUOTA=RES-STORAGE), the storage EXPUNGE would free as the sum of RFC822.SIZE
    ['DELETED', 'DELETED-STORAGE'].forEach(item => {
        if (server.allowedStatus.indexOf(item) < 0) {
            server.allowedStatus.push(item);
        }
    });
    server.statusHandlers['DELETED-STORAGE'] = (connection, mailbox) => totalSize(mailbox.messages.filter(message => message.flags.indexOf('\\Deleted') >= 0));
};
