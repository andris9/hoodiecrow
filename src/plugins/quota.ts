import { states } from '../command-states.js';
import { normalizeLineBreaks } from '../mimeparser.js';
import { MAX_NUMBER64, isNumber } from '../numbers.js';
import { isAstring } from '../arguments.js';
import type {
    AppendCheckOptions,
    AppendMessage,
    Attribute,
    Callback,
    CheckResult,
    CommandHandler,
    IMAPConnection,
    IMAPServer,
    Mailbox,
    ParsedCommand
} from '../types.js';

/** Amounts by resource, STORAGE in units of 1024 octets */
type Limits = Partial<Record<string, number>>;

/** Amounts a command adds to the quota root, `bytes` in octets */
interface Usage {
    MESSAGE?: number | undefined;
    MAILBOX?: number | undefined;
    bytes?: number | undefined;
}

// Resource types of RFC 9208 section 5 that can be counted. ANNOTATION-STORAGE is left out,
// as there is no ANNOTATE support
const RESOURCES = ['STORAGE', 'MESSAGE', 'MAILBOX'];
const DEFAULT_ROOT = 'User quota';

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
export default function quotaPlugin(server: IMAPServer) {
    const config = server.options.quota || {};
    const root: { name: string; soft: boolean; limits: Limits } = {
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

    // Personal mailboxes, INBOX included, belong to the quota root. Other namespaces have no quota root. A mailbox
    // that does not exist yet belongs to the namespace of its prefix
    const inRoot = (path: string | Mailbox) => server.isPersonal(path);

    const isSelectable = (mailbox: Mailbox) => mailbox.flags.indexOf('\\Noselect') < 0;

    // RFC822.SIZE, the message with CRLF line breaks
    const totalSize = (messages: { raw: string }[]) => messages.reduce((total, message) => total + normalizeLineBreaks(message.raw).length, 0);

    const getUsage = () => {
        const usage: { MESSAGE: number; MAILBOX: number; bytes: number; STORAGE?: number } = { MESSAGE: 0, MAILBOX: 0, bytes: 0 };
        Object.keys(server.folderCache).forEach(path => {
            const mailbox = server.folderCache[path];
            if (!isSelectable(mailbox) || !inRoot(mailbox)) {
                return;
            }
            usage.MAILBOX++;
            usage.MESSAGE += mailbox.messages.length;
            usage.bytes += totalSize(mailbox.messages);
        });
        return usage;
    };

    // RFC 9208 section 4.2.1: quota-list, resources that are not listed are not limited
    const sendQuota = (connection: IMAPConnection, parsed: ParsedCommand, data: string) => {
        const usage = getUsage();
        // RFC 9208 section 5.1: units of 1024 octets
        usage.STORAGE = Math.ceil(usage.bytes / 1024);
        const list: Attribute[] = [];
        RESOURCES.forEach(resource => {
            if (resource in root.limits) {
                list.push({ type: 'ATOM', value: resource }, usage[resource as keyof typeof usage], root.limits[resource]);
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
    const checkLimits = (added: Usage): CheckResult | undefined => {
        const limited = (added.MESSAGE && 'MESSAGE' in root.limits) || (added.bytes && 'STORAGE' in root.limits) || (added.MAILBOX && 'MAILBOX' in root.limits);
        if (!limited) {
            return;
        }
        const usage = getUsage();
        const over =
            (added.MESSAGE && 'MESSAGE' in root.limits && usage.MESSAGE + added.MESSAGE > root.limits.MESSAGE!) ||
            (added.bytes && 'STORAGE' in root.limits && usage.bytes + added.bytes > root.limits.STORAGE! * 1024) ||
            (added.MAILBOX && 'MAILBOX' in root.limits && usage.MAILBOX + added.MAILBOX > root.limits.MAILBOX!);
        if (!over) {
            return;
        }
        // RFC 9208 section 4.3.1 and RFC 5530 section 3
        return root.soft ? { code: 'OVERQUOTA', text: 'Soft quota has been exceeded', soft: true } : { code: 'OVERQUOTA', text: 'Quota exceeded' };
    };

    // APPEND, COPY, MOVE and REPLACE
    server.appendChecks.push((connection: IMAPConnection, mailbox: Mailbox, messages: AppendMessage[], options: AppendCheckOptions) => {
        if (!messages.length || !inRoot(mailbox)) {
            return;
        }
        if (options.move && options.source && inRoot(options.source)) {
            // moving within the quota root does not change the usage
            return;
        }
        const added = { MESSAGE: messages.length, bytes: totalSize(messages) };
        // RFC 8508 section 3.4: REPLACE counts only the net usage, the replaced message is removed
        if (options.replaced && connection.selectedMailbox && inRoot(connection.selectedMailbox)) {
            added.MESSAGE--;
            added.bytes -= totalSize([options.replaced]);
        }
        return checkLimits(added);
    });

    // Number of mailboxes that CREATE adds, missing parent mailboxes are created as well
    const countNewMailboxes = (path: string) => {
        const target = server.getMailbox(server.stripSeparator(path, server.getSeparator(path)));
        let count = !target || !isSelectable(target) ? 1 : 0;
        for (let parent = server.getParentPath(path); parent; parent = server.getParentPath(parent)) {
            if (!server.getMailbox(parent)) {
                count++;
            }
        }
        return count;
    };

    // The MAILBOX resource limits CREATE and RENAME INBOX (which creates a mailbox)
    const wrapCreate = (command: string, getPath: (attributes: Attribute[] | undefined) => unknown) => {
        // CREATE and RENAME are core commands, so the handler exists
        const prevHandler = server.getCommandHandler(command) as CommandHandler;
        server.setCommandHandler(command, (connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
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

    const argValue = (attributes: Attribute[] | undefined, i: number) => isAstring((attributes || [])[i]) && attributes![i].value;

    wrapCreate('CREATE', (attributes: Attribute[] | undefined) => (attributes && attributes.length === 1 ? argValue(attributes, 0) : false));
    wrapCreate('RENAME', (attributes: Attribute[] | undefined) => {
        const source = argValue(attributes, 0);
        // only RENAME INBOX adds a mailbox, other renames keep the count (RFC 3501 section 6.3.5)
        return attributes && attributes.length === 2 && typeof source === 'string' && source.toUpperCase() === 'INBOX' ? argValue(attributes, 1) : false;
    });

    // RFC 9208 section 4.1.1: GETQUOTA quota-root-name
    server.setCommandHandler(
        'GETQUOTA',
        (connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
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
        // quota-root = astring (RFC 9208 section 9)
        { states: states.AUTHENTICATED, astringArguments: [0] }
    );

    // RFC 9208 section 4.1.2: GETQUOTAROOT mailbox, the mailbox does not have to exist
    server.setCommandHandler(
        'GETQUOTAROOT',
        (connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
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
                    attributes: ([{ type: 'MAILBOX', value: path }] as Attribute[]).concat(hasRoot ? { type: 'STRING', value: root.name } : [])
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
        (connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
            const list = parsed.attributes && parsed.attributes[1];
            if (!parsed.attributes || parsed.attributes.length !== 2 || !isAstring(parsed.attributes[0]) || !Array.isArray(list) || list.length % 2) {
                connection.sendStatus(parsed, data, 'BAD', 'SETQUOTA expects a quota root name and a list of resource limits');
                return callback();
            }

            const limits: Limits = {};
            for (let i = 0; i < list.length; i += 2) {
                const name = list[i];
                const limit = list[i + 1];
                // setquota-resource = resource-name SP resource-limit, resource-limit = number64
                if (!name || name.type !== 'ATOM' || !limit || limit.type !== 'ATOM' || !isNumber(limit.value, MAX_NUMBER64)) {
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
        // quota-root = astring (RFC 9208 section 9)
        { states: states.AUTHENTICATED, astringArguments: [0] }
    );

    // RFC 9208 section 4.1.4: DELETED (the built-in item, required with QUOTA=RES-MESSAGE) and DELETED-STORAGE
    // (required with QUOTA=RES-STORAGE), the storage EXPUNGE would free as the sum of RFC822.SIZE
    ['DELETED', 'DELETED-STORAGE'].forEach(item => {
        if (server.allowedStatus.indexOf(item) < 0) {
            server.allowedStatus.push(item);
        }
    });
    server.statusHandlers['DELETED-STORAGE'] = (connection: IMAPConnection, mailbox: Mailbox) =>
        totalSize(mailbox.messages.filter(message => message.flags.indexOf('\\Deleted') >= 0));
}
