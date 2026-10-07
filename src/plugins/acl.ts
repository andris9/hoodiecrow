import { states } from '../command-states.js';
import { normalizeSystemFlag, checkSystemFlags } from '../commands/handlers/flags.js';
import builtinStoreHandlers from '../commands/handlers/store.js';
import { getListExtensions } from '../list-extensions.js';
import type { ListItemInfo } from '../list-extensions.js';
import { beginSelect } from '../commands/select.js';
import { getPendingTarget } from '../commands/append.js';
import { isAstring } from '../arguments.js';
import type {
    Attribute,
    Callback,
    CommandHandler,
    CommandOptions,
    IMAPConnection,
    IMAPError,
    IMAPResponse,
    IMAPServer,
    Mailbox,
    Message,
    NotifyEvent,
    ParsedCommand,
    Refusal
} from '../types.js';

/** Rights of RFC 4314 section 2.1, one letter each */
type Rights = Set<string>;

/** The ACL of a mailbox, rights by identifier ("-" prefixes negative rights) */
type Acl = Map<string, Rights>;

/** Runs instead of a command handler, with the handler it wraps */
type CommandWrapper = (prevHandler: CommandHandler, connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => void;

/** Handler of an ACL command, called once the arguments are checked, with the mailbox of the first argument */
type AclCommandHandler = (connection: IMAPConnection, parsed: ParsedCommand, data: string, mailbox: Mailbox | undefined) => void;

/**
 * @help Adds ACL [RFC4314] capability with RIGHTS=texk
 * @help The owner (server option "aclOwner", default "testuser")
 * @help has all rights on every mailbox. Other users get rights
 * @help from the "acl" property of a mailbox in storage, e.g.
 * @help {"otheruser": "lr", "anyone": "l"}, or from SETACL. With
 * @help LIST-EXTENDED, LIST-MYRIGHTS [RFC8440] is supported as well
 *
 * ACL: https://www.rfc-editor.org/rfc/rfc4314
 *
 * LIST-MYRIGHTS: https://www.rfc-editor.org/rfc/rfc8440
 *
 * Additional commands:
 * - SETACL, DELETEACL, GETACL, LISTRIGHTS, MYRIGHTS
 * - the MYRIGHTS return option of LIST, when LIST-EXTENDED is loaded
 *
 * Users other than the owner can only do what their rights allow (RFC 4314 section 4).
 */

// RFC 4314 section 2.1, in the order they are listed in responses
const RIGHTS = 'lrswipkxtea';
const ALL_RIGHTS = new Set(RIGHTS);
// RFC 4314 section 2.1.1: the obsolete "c" and "d" rights are macros. Like Dovecot, "c" is "kx"
// ("create" for servers that used "c" for DELETE) and "d" is "et"
const VIRTUAL_RIGHTS: Record<string, string> = { c: 'kx', d: 'et' };
// RFC 4314 section 5.2: with none of these the mailbox is READ-ONLY. All flags are shared between
// the users of a mailbox, so the "shared flag rights" are "s", "w" and "t"
const WRITE_RIGHTS = ['i', 'e', 's', 'w', 't'];
// RFC 4314 section 4: the rights for changing flags
const FLAG_RIGHTS = ['s', 'w', 't'];
// RFC 4314 section 4: MYRIGHTS needs any of these
const ANY_RIGHTS = ['l', 'r', 'i', 'k', 'x', 'a'];
const STORE_ITEMS = ['FLAGS', '+FLAGS', '-FLAGS', 'FLAGS.SILENT', '+FLAGS.SILENT', '-FLAGS.SILENT'];

/**
 * Formats an astring for a response. The compiler sends an ATOM value that is not a valid atom as a
 * quoted string or a literal, only a leading "\\" (allowed for flags) and NIL have to be kept away from it
 *
 * @param {String} value
 * @return {Object|String}
 */
function astring(value: string): Attribute {
    // identifiers are unicode strings, sent as UTF-8 (RFC 4314 section 3)
    value = Buffer.from(value, 'utf-8').toString('binary');
    // an atom NIL would read back as NIL, not as an identifier
    return value && value.charAt(0) !== '\\' && !/^NIL$/i.test(value) ? { type: 'ATOM', value } : value;
}

/**
 * Creates an error that is answered with BAD
 *
 * @param {String} message Error text
 * @return {Error}
 */
function badInput(message: string): IMAPError {
    const err: IMAPError = new Error(message);
    err.imapResponse = 'BAD';
    return err;
}

/**
 * Parses a rights string, the virtual "c" and "d" rights are expanded (RFC 4314 section 2.1.1)
 *
 * @param {String} value Rights, e.g. "lrswd"
 * @return {Set} rights
 * @throws {Error} BAD error for unknown rights (RFC 4314 section 3.1)
 */
function parseRights(value: string): Rights {
    const rights: Rights = new Set();
    for (const chr of value) {
        if (ALL_RIGHTS.has(chr)) {
            rights.add(chr);
        } else if (Object.hasOwn(VIRTUAL_RIGHTS, chr)) {
            VIRTUAL_RIGHTS[chr].split('').forEach((right: string) => rights.add(right));
        } else if (/^[A-Z]$/.test(chr)) {
            throw badInput('Uppercase rights are not allowed');
        } else {
            throw badInput('The ' + (/^[\x21-\x7e]$/.test(chr) ? chr + ' ' : '') + 'right is not supported');
        }
    }
    return rights;
}

/**
 * Builds the attributes of an ACL, LISTRIGHTS or MYRIGHTS response. The mailbox name is a MAILBOX
 * attribute, so each session gets it in the form it uses (modified UTF-7, or UTF-8 after ENABLE
 * UTF8=ACCEPT)
 *
 * @param {Object} mailbox Mailbox object
 * @param {Array} values Values that follow the mailbox name
 * @return {Array} Response attributes
 */
function mailboxResponse(mailbox: Mailbox, values: string[]): Attribute[] {
    return ([{ type: 'MAILBOX', value: mailbox.path }] as Attribute[]).concat(values.map(value => astring(value)));
}

/**
 * Formats rights for ACL and MYRIGHTS responses. "c" and "d" are added when any of their
 * member rights is set (RFC 4314 section 2.1.1)
 *
 * @param {Set} rights
 * @return {String}
 */
function formatRights(rights: Rights) {
    let result = RIGHTS.split('')
        .filter(right => rights.has(right))
        .join('');
    Object.keys(VIRTUAL_RIGHTS).forEach(virtual => {
        if (VIRTUAL_RIGHTS[virtual].split('').some((right: string) => rights.has(right))) {
            result += virtual;
        }
    });
    return result;
}

/**
 * Checks an identifier argument. RFC 4314 section 3 asks for SASLprep, which is not implemented,
 * but an identifier that SASLprep would refuse (control characters, invalid UTF-8) or that is
 * empty gets BAD, as does a lone "-" (section 2: "-" prefixes the identifier of a negative right)
 *
 * @param {String} identifier Identifier as a binary string
 * @return {String|Boolean} error text, or false if the identifier is fine
 */
function identifierError(identifier: string): string | false {
    if (!identifier || identifier === '-') {
        return 'Empty identifier';
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(identifier)) {
        return 'Identifier contains control characters';
    }
    const decoded = Buffer.from(identifier, 'binary').toString('utf-8');
    if (Buffer.from(decoded, 'utf-8').toString('binary') !== identifier) {
        return 'Identifier is not valid UTF-8';
    }
    return false;
}

export default function aclPlugin(server: IMAPServer) {
    server.registerCapability('ACL');
    // RFC 4314 section 5.1.1: the rights not defined in RFC 2086, MUST include "t", "e", "x" and "k"
    server.registerCapability('RIGHTS=texk');

    const owner = typeof server.options.aclOwner === 'string' ? server.options.aclOwner : 'testuser';

    const isOwner = (connection: IMAPConnection) => connection.username === owner;

    /**
     * Returns the ACL of a mailbox as a Map of identifier to a Set of rights. The ACL from the
     * storage (an object of identifier to rights string) is converted on first use
     *
     * @param {Object} mailbox Mailbox object
     * @return {Map}
     */
    const getAcl = (mailbox: Mailbox): Acl => {
        if (!(mailbox.acl instanceof Map)) {
            const acl: Acl = new Map();
            const source = mailbox.acl && typeof mailbox.acl === 'object' ? mailbox.acl : {};
            Object.keys(source).forEach(identifier => {
                try {
                    acl.set(identifier, parseRights(String(source[identifier])));
                } catch (err) {
                    // not a client error, so this is answered with NO [SERVERBUG]
                    throw new Error('Invalid ACL in storage for ' + mailbox.path + ': ' + (err as Error).message, { cause: err });
                }
            });
            mailbox.acl = acl;
        }
        return mailbox.acl;
    };

    /**
     * Returns the rights a user has on a mailbox. The owner has all rights, other users get the
     * union of the rights of their own identifier and "anyone", minus the negative rights of
     * "-user" and "-anyone" (RFC 4314 section 2)
     *
     * @param {Object} connection IMAP connection of the user
     * @param {Object} mailbox Mailbox object
     * @param {Map} [acl] ACL to use instead of the current one of the mailbox
     * @return {Set} rights
     */
    const getRights = (connection: IMAPConnection, mailbox: Mailbox, acl?: Acl): Rights => {
        const username = connection.username;
        if (username === owner) {
            return ALL_RIGHTS;
        }
        acl = acl || getAcl(mailbox);
        const identifiers = ['anyone'].concat(typeof username === 'string' && username ? username : []);
        const rights: Rights = new Set();
        identifiers.forEach(identifier => (acl!.get(identifier) || []).forEach((right: string) => rights.add(right)));
        identifiers.forEach(identifier => (acl!.get('-' + identifier) || []).forEach((right: string) => rights.delete(right)));
        return rights;
    };

    // for plugins that report only what a user may see (e.g. NOTIFY)
    server.acl = { getRights, isOwner };

    // Tells plugins that the ACL of a mailbox changed, with an `acl` event `(mailbox, previousAcl)`
    const changeAcl = (mailbox: Mailbox, change: (acl: Acl) => void) => {
        const acl = getAcl(mailbox);
        const previous = new Map(acl);
        change(acl);
        server.emit('acl', mailbox, previous);
    };

    // CATENATE (RFC 4469 section 5): reading a message through an IMAP URL needs the "r" right, a
    // mailbox without "l" is reported like one that does not exist (RFC 4314 section 6)
    server.urlAccessChecks.push((connection: IMAPConnection, mailbox: Mailbox) => {
        const rights = getRights(connection, mailbox);
        if (!rights.has('r')) {
            return { text: rights.has('l') ? 'Permission denied' : 'Mailbox does not exist' };
        }
        return false;
    });

    // MULTISEARCH (RFC 7377 section 2.2): searching needs "r", and "l" for a mailbox that the client did not name.
    // Other mailboxes are left out without an error
    server.searchAccessChecks.push((connection: IMAPConnection, mailbox: Mailbox, named: boolean) => {
        const rights = getRights(connection, mailbox);
        return rights.has('r') && (named || rights.has('l'));
    });

    // Rights on the selected mailbox are taken when it is selected (RFC 4314 section 5.1.1 allows caching
    // them), so the FLAGS and PERMANENTFLAGS a session got stay correct until the next SELECT
    const getSelectedRights = (connection: IMAPConnection): Rights => connection.aclRights || ALL_RIGHTS;

    // RFC 4314 section 4: "t" for \Deleted, "s" for \Seen and "w" for all other flags
    const flagRight = (flag: string) => {
        flag = normalizeSystemFlag(flag);
        if (flag === '\\Deleted') {
            return 't';
        }
        if (flag === '\\Seen') {
            return 's';
        }
        return 'w';
    };

    // flags are strings or parsed atoms
    const flagValue = (flag: Attribute): string => (typeof flag === 'string' ? flag : String((flag && flag.value) || ''));

    const canSetFlag = (rights: Rights, flag: Attribute) => rights.has(flagRight(flagValue(flag)));

    const mailboxArgument = (parsed: ParsedCommand, position: number): string | false => {
        const attr = (parsed.attributes || [])[position];
        return isAstring(attr) ? attr.value : false;
    };

    // the mailbox named by an argument, false if there is no such mailbox or the argument is invalid
    const argumentMailbox = (parsed: ParsedCommand, position: number) => {
        const name = mailboxArgument(parsed, position);
        return (name !== false && server.getMailbox(name)) || false;
    };

    const sendNoPerm = (connection: IMAPConnection, parsed: ParsedCommand, data: string, description?: string) =>
        connection.sendStatus(parsed, data, 'NO', 'Permission denied', 'NOPERM', description);

    /**
     * Refuses a command for lack of rights. Without the "l" right the user gets the same error
     * as for a mailbox that does not exist, so the existence of the mailbox is not disclosed
     * (RFC 4314 section 6), otherwise NO [NOPERM] (RFC 5530 section 3)
     */
    const sendDenied = (connection: IMAPConnection, parsed: ParsedCommand, data: string, rights: Rights, description?: string, notFound?: string) => {
        if (rights.has('l')) {
            sendNoPerm(connection, parsed, data, description);
        } else if (notFound === 'TRYCREATE') {
            connection.sendStatus(parsed, data, 'NO', 'Target mailbox does not exist', 'TRYCREATE', description);
        } else {
            connection.sendStatus(parsed, data, 'NO', 'Mailbox does not exist', 'NONEXISTENT', description);
        }
    };

    /**
     * Finds the nearest existing parent of a mailbox name (RFC 4314 section 4, CREATE)
     *
     * @param {String} path Mailbox path
     * @return {Object|Boolean} parent mailbox or false if there is none
     */
    const getParent = (path: string) => {
        for (let parent = server.getParentPath(path); parent; parent = server.getParentPath(parent)) {
            const mailbox = server.getMailbox(parent);
            if (mailbox) {
                return mailbox;
            }
        }
        return false;
    };

    // Checks for the ACL commands, true if the command can go ahead
    const checkAclCommand = (
        connection: IMAPConnection,
        parsed: ParsedCommand,
        data: string,
        mailbox: Mailbox | undefined,
        isAllowed: (rights: Rights) => boolean
    ): mailbox is Mailbox => {
        if (!mailbox) {
            connection.sendStatus(parsed, data, 'NO', 'Mailbox does not exist', 'NONEXISTENT');
            return false;
        }
        const rights = getRights(connection, mailbox);
        if (!isAllowed(rights)) {
            sendDenied(connection, parsed, data, rights);
            return false;
        }
        return true;
    };

    const hasAdmin = (rights: Rights) => rights.has('a');

    /**
     * Validates the arguments of an ACL command: `count` astrings, the first one a mailbox name and
     * the second one (if any) an identifier
     *
     * @return {Boolean} true if the arguments are fine, otherwise BAD was sent
     */
    const checkArguments = (connection: IMAPConnection, parsed: ParsedCommand, data: string, count: number) => {
        const args = parsed.attributes || [];
        const command = parsed.command.toUpperCase();
        if (args.length !== count || args.some(arg => !isAstring(arg))) {
            connection.sendStatus(parsed, data, 'BAD', command + ' expects ' + (count === 1 ? 'a mailbox name' : count + ' string arguments'));
            return false;
        }
        const error = count > 1 && identifierError(args[1].value);
        if (error) {
            // RFC 4314 section 3: an identifier that fails preparation is refused with BAD
            connection.sendStatus(parsed, data, 'BAD', error);
            return false;
        }
        if (count > 1) {
            // user names and identifiers are unicode strings, whatever way the user logged in
            args[1].value = Buffer.from(args[1].value, 'binary').toString('utf-8');
        }
        return true;
    };

    // RFC 4314 section 2: an implementation MAY force rights to always be granted to an identifier
    const refuseOwnerIdentifier = (connection: IMAPConnection, parsed: ParsedCommand, data: string) => {
        const identifier = parsed.attributes![1].value;
        if (identifier !== owner && identifier !== '-' + owner) {
            return false;
        }
        connection.sendStatus(parsed, data, 'NO', 'Rights of the mailbox owner can not be changed', 'CANNOT');
        return true;
    };

    const aclCommand = (count: number, handler: AclCommandHandler) => (connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
        if (checkArguments(connection, parsed, data, count)) {
            handler(connection, parsed, data, server.getMailbox(parsed.attributes![0].value));
        }
        callback();
    };

    const aclOptions: CommandOptions = { states: states.AUTHENTICATED, mailboxArguments: [0] };
    // RFC 4314 section 7: identifier and mod-rights are astrings
    const identifierOptions: CommandOptions = Object.assign({ astringArguments: [1] }, aclOptions);

    // RFC 4314 section 3.8: myrights-data = "MYRIGHTS" SP mailbox SP rights
    const sendMyRights = (connection: IMAPConnection, mailbox: Mailbox, parsed: ParsedCommand, data: string) =>
        connection.send(
            { tag: '*', command: 'MYRIGHTS', attributes: mailboxResponse(mailbox, [formatRights(getRights(connection, mailbox))]) },
            'MYRIGHTS',
            parsed,
            data,
            mailbox
        );

    // RFC 8440 section 3: the MYRIGHTS return option of an extended LIST. The registry is shared with
    // LIST-EXTENDED, which accepts the option only when it is loaded, in any load order
    const listExtensions = getListExtensions(server);
    server.registerCapability('LIST-MYRIGHTS', () => listExtensions.enabled);
    listExtensions.returnOptions.MYRIGHTS = {
        // a MYRIGHTS response follows the LIST response of every listed mailbox that matches the
        // selection criteria and exists, not the ones listed only for CHILDINFO or as \NonExistent
        onItem: (connection: IMAPConnection, folder: Mailbox, value: any, info: ListItemInfo, parsed: ParsedCommand, data: string) => {
            if (info.matched && info.exists) {
                sendMyRights(connection, folder, parsed, data);
            }
        }
    };

    // RFC 4314 section 3.1
    server.setCommandHandler(
        'SETACL',
        aclCommand(3, (connection: IMAPConnection, parsed: ParsedCommand, data: string, mailbox: Mailbox | undefined) => {
            const identifier: string = parsed.attributes![1].value;
            const modification: string = parsed.attributes![2].value;
            const mode = /^[+-]/.test(modification) ? modification.charAt(0) : '';

            // an unrecognized right MUST cause BAD, before anything else is checked
            const rights = parseRights(modification.substr(mode.length));

            if (!checkAclCommand(connection, parsed, data, mailbox, hasAdmin) || refuseOwnerIdentifier(connection, parsed, data)) {
                return;
            }

            changeAcl(mailbox, acl => {
                const current = new Set(acl.get(identifier) || []);
                if (mode === '+') {
                    rights.forEach(right => current.add(right));
                } else if (mode === '-') {
                    rights.forEach(right => current.delete(right));
                }
                const updated = mode ? current : rights;
                if (updated.size) {
                    acl.set(identifier, updated);
                } else {
                    acl.delete(identifier);
                }
            });
            connection.sendStatus(parsed, data, 'OK', 'Setacl complete');
        }),
        Object.assign({ astringArguments: [1, 2] }, aclOptions)
    );

    // RFC 4314 section 3.2
    server.setCommandHandler(
        'DELETEACL',
        aclCommand(2, (connection: IMAPConnection, parsed: ParsedCommand, data: string, mailbox: Mailbox | undefined) => {
            if (!checkAclCommand(connection, parsed, data, mailbox, hasAdmin) || refuseOwnerIdentifier(connection, parsed, data)) {
                return;
            }
            changeAcl(mailbox, acl => acl.delete(parsed.attributes![1].value));
            connection.sendStatus(parsed, data, 'OK', 'Deleteacl complete');
        }),
        identifierOptions
    );

    // RFC 4314 sections 3.3 and 3.6
    server.setCommandHandler(
        'GETACL',
        aclCommand(1, (connection: IMAPConnection, parsed: ParsedCommand, data: string, mailbox: Mailbox | undefined) => {
            if (!checkAclCommand(connection, parsed, data, mailbox, hasAdmin)) {
                return;
            }
            const attributes = [owner, formatRights(ALL_RIGHTS)];
            getAcl(mailbox).forEach((rights, identifier) => {
                attributes.push(identifier, formatRights(rights));
            });
            connection.send({ tag: '*', command: 'ACL', attributes: mailboxResponse(mailbox, attributes) }, 'ACL', parsed, data, mailbox);
            connection.sendStatus(parsed, data, 'OK', 'Getacl complete');
        }),
        aclOptions
    );

    // RFC 4314 sections 3.4 and 3.7
    server.setCommandHandler(
        'LISTRIGHTS',
        aclCommand(2, (connection: IMAPConnection, parsed: ParsedCommand, data: string, mailbox: Mailbox | undefined) => {
            if (!checkAclCommand(connection, parsed, data, mailbox, hasAdmin)) {
                return;
            }
            // the identifier is sent back in the same form as the client used
            const identifier: string = parsed.attributes![1].value;
            let attributes: string[];
            if (identifier === owner) {
                // the owner always has every right, nothing is optional
                attributes = [identifier, formatRights(ALL_RIGHTS)];
            } else {
                // nothing is granted always, every right can be granted on its own, including the virtual ones
                attributes = [identifier, ''].concat(RIGHTS.split(''), Object.keys(VIRTUAL_RIGHTS));
            }
            connection.send({ tag: '*', command: 'LISTRIGHTS', attributes: mailboxResponse(mailbox, attributes) }, 'LISTRIGHTS', parsed, data, mailbox);
            connection.sendStatus(parsed, data, 'OK', 'Listrights complete');
        }),
        identifierOptions
    );

    // RFC 4314 sections 3.5 and 3.8
    server.setCommandHandler(
        'MYRIGHTS',
        aclCommand(1, (connection: IMAPConnection, parsed: ParsedCommand, data: string, mailbox: Mailbox | undefined) => {
            if (!checkAclCommand(connection, parsed, data, mailbox, (rights: Rights) => ANY_RIGHTS.some(right => rights.has(right)))) {
                return;
            }
            sendMyRights(connection, mailbox, parsed, data);
            connection.sendStatus(parsed, data, 'OK', 'Myrights complete');
        }),
        aclOptions
    );

    // Enforcement (RFC 4314 section 4). Commands are wrapped once every plugin is loaded, so that
    // the commands of every plugin (MOVE, UID EXPUNGE, ...) are covered whatever the load order is
    const wrappers: Record<string, CommandWrapper> = {};
    // the handlers that the enforcement wraps
    const prevHandlers: Record<string, CommandHandler> = {};
    const wrapCommands = () => {
        Object.keys(wrappers).forEach(command => {
            const prevHandler = server.getCommandHandler(command);
            if (prevHandler) {
                prevHandlers[command] = prevHandler;
                server.setCommandHandler(command, (connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
                    if (isOwner(connection)) {
                        return prevHandler(connection, parsed, data, callback);
                    }
                    return wrappers[command](prevHandler, connection, parsed, data, callback);
                });
            }
        });

        // Return options of an extended LIST (LIST-STATUS, LIST-MYRIGHTS) add responses for the listed
        // mailboxes, so they skip the mailboxes that are not listed for the user. STATUS also needs "r"
        // (RFC 5819 section 2: the STATUS response MUST NOT be returned if the mailbox can not be selected)
        Object.keys(listExtensions.returnOptions).forEach(name => {
            const option = listExtensions.returnOptions[name];
            if (typeof option.onItem !== 'function') {
                return;
            }
            const onItem = option.onItem;
            const right = name === 'STATUS' ? 'r' : 'l';
            option.onItem = (connection: IMAPConnection, folder: Mailbox, ...args: [any, ListItemInfo, ParsedCommand, string]) => {
                if (isOwner(connection)) {
                    return onItem(connection, folder, ...args);
                }
                const rights = getRights(connection, folder);
                if (rights.has('l') && rights.has(right)) {
                    return onItem(connection, folder, ...args);
                }
            };
        });

        // RFC 4314 section 4: STORE changes only the flags the user has rights for
        STORE_ITEMS.forEach(item => {
            const prevHandler = server.storeHandlers[item] || builtinStoreHandlers[item];
            server.storeHandlers[item] = (connection: IMAPConnection, message: Message, flags: Attribute, ...args: [number, ParsedCommand, string]) => {
                const rights = getSelectedRights(connection);
                if (FLAG_RIGHTS.every(right => rights.has(right))) {
                    return prevHandler(connection, message, flags, ...args);
                }
                flags = ([] as Attribute[]).concat(flags);
                // invalid flags are still refused with BAD, even if the user could not set them anyway
                flags.forEach((flag: Attribute) => checkSystemFlags(connection, normalizeSystemFlag(flagValue(flag))));
                let allowed: Attribute[] = flags.filter((flag: Attribute) => canSetFlag(rights, flag));
                if (item.charAt(0) !== '+' && item.charAt(0) !== '-') {
                    // replacing the flags keeps the ones the user can not change
                    allowed = message.flags.filter(flag => !canSetFlag(rights, flag)).concat(allowed);
                }
                return prevHandler(connection, message, allowed, ...args);
            };
        });
    };

    server.once('pluginsLoaded', wrapCommands);

    const selectWrapper = (prevHandler: CommandHandler, connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
        const mailbox = argumentMailbox(parsed, 0);
        if (!mailbox) {
            return prevHandler(connection, parsed, data, callback);
        }
        const command = parsed.command.toUpperCase();
        const rights = getRights(connection, mailbox);
        if (!rights.has('r')) {
            // a failed SELECT leaves no mailbox selected (RFC 3501 section 6.3.1)
            beginSelect(connection, parsed, data);
            connection.closeMailbox();
            sendDenied(connection, parsed, data, rights, command + ' FAILED');
            return callback();
        }
        connection.aclRights = rights;
        if (command === 'SELECT' && !WRITE_RIGHTS.some(right => rights.has(right))) {
            // RFC 4314 section 5.2: the server MUST answer READ-ONLY, so the mailbox is opened like EXAMINE does
            return prevHandlers.EXAMINE(connection, parsed, data, callback);
        }
        return prevHandler(connection, parsed, data, callback);
    };
    wrappers.SELECT = selectWrapper;
    wrappers.EXAMINE = selectWrapper;

    // Checks that the user has a right on the mailbox named by an argument. Unknown mailboxes and
    // invalid arguments are left to the command handler
    const hasMailboxRight = (right: string, position: number, notFound?: string) => (connection: IMAPConnection, parsed: ParsedCommand, data: string) => {
        const mailbox = argumentMailbox(parsed, position);
        const rights = mailbox && getRights(connection, mailbox);
        if (rights && !rights.has(right)) {
            sendDenied(connection, parsed, data, rights, undefined, notFound);
            return false;
        }
        return true;
    };

    const requireRight = (right: string, position: number, notFound?: string): CommandWrapper => {
        const check = hasMailboxRight(right, position, notFound);
        return (prevHandler: CommandHandler, connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) =>
            check(connection, parsed, data) ? prevHandler(connection, parsed, data, callback) : callback();
    };

    wrappers.STATUS = requireRight('r', 0);
    // SUBSCRIBE checks that the mailbox exists, so it needs "l". UNSUBSCRIBE needs no rights
    wrappers.SUBSCRIBE = requireRight('l', 0);

    wrappers.DELETE = requireRight('x', 0);

    // CREATE needs "k" on the nearest existing parent, a mailbox at the top level can not be created
    const checkCreateRight = (connection: IMAPConnection, parsed: ParsedCommand, data: string, path: string) => {
        const parent = getParent(path);
        if (!parent || !getRights(connection, parent).has('k')) {
            sendNoPerm(connection, parsed, data);
            return false;
        }
        return true;
    };

    wrappers.CREATE = (prevHandler: CommandHandler, connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
        const name = mailboxArgument(parsed, 0);
        if (name !== false && !checkCreateRight(connection, parsed, data, name)) {
            return callback();
        }
        return prevHandler(connection, parsed, data, callback);
    };

    // RENAME needs "x" on the mailbox and "k" on the new parent
    const hasRenameRight = hasMailboxRight('x', 0);
    wrappers.RENAME = (prevHandler: CommandHandler, connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
        if (!hasRenameRight(connection, parsed, data)) {
            return callback();
        }
        const name = mailboxArgument(parsed, 1);
        if (name !== false && argumentMailbox(parsed, 0) && !checkCreateRight(connection, parsed, data, name)) {
            return callback();
        }
        return prevHandler(connection, parsed, data, callback);
    };

    // APPEND needs "i", and only the flags the user has rights for are stored
    wrappers.APPEND = (prevHandler: CommandHandler, connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
        const mailbox = argumentMailbox(parsed, 0);
        if (!mailbox) {
            return prevHandler(connection, parsed, data, callback);
        }
        const rights = getRights(connection, mailbox);
        if (!rights.has('i')) {
            sendDenied(connection, parsed, data, rights, 'APPEND FAILED', 'TRYCREATE');
            return callback();
        }
        const flags = parsed.attributes![1];
        if (Array.isArray(flags) && flags.every((flag: Attribute) => flag && flag.type === 'ATOM')) {
            try {
                flags.forEach((flag: Attribute) => checkSystemFlags(connection, normalizeSystemFlag(flag.value)));
                // the server MUST NOT fail APPEND for flags the user can not set
                parsed.attributes![1] = flags.filter((flag: Attribute) => canSetFlag(rights, flag));
            } catch {
                // invalid flags are refused with BAD by the APPEND handler
            }
        }
        return prevHandler(connection, parsed, data, callback);
    };

    // the refusal for a target mailbox without "i", see sendDenied
    const insertRefusal = (connection: IMAPConnection, mailbox: Mailbox | false): Refusal | false => {
        const rights = mailbox ? getRights(connection, mailbox) : false;
        if (!rights || rights.has('i')) {
            return false;
        }
        return rights.has('l')
            ? { command: 'NO', code: 'NOPERM', text: 'Permission denied' }
            : { command: 'NO', code: 'TRYCREATE', text: 'Target mailbox does not exist' };
    };

    // COPY and MOVE need "i" on the target, MOVE also needs what UID STORE \Deleted and UID EXPUNGE
    // need on the source, "t" and "e" (RFC 6851 section 4.2)
    const requireInsert = requireRight('i', 1, 'TRYCREATE');
    const copyWrapper =
        (isMove: boolean): CommandWrapper =>
        (prevHandler: CommandHandler, connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
            const command = parsed.command.toUpperCase();
            if (isMove && !connection.readOnly) {
                const rights = getSelectedRights(connection);
                if (!rights.has('t') || !rights.has('e')) {
                    sendNoPerm(connection, parsed, data, command + ' FAIL');
                    return callback();
                }
            }
            return requireInsert(prevHandler, connection, parsed, data, callback);
        };
    wrappers.COPY = copyWrapper(false);
    wrappers['UID COPY'] = copyWrapper(false);
    wrappers.MOVE = copyWrapper(true);
    wrappers['UID MOVE'] = copyWrapper(true);

    // RFC 8508 section 4.1: REPLACE needs the rights of UID STORE (\Deleted, "t") and UID EXPUNGE ("e") on the
    // selected mailbox, and of APPEND ("i") on the target. A read-only session is refused by the command handler
    const replaceRefusal = (connection: IMAPConnection, mailbox: Mailbox | false): Refusal | false => {
        const selected = getSelectedRights(connection);
        if (!connection.readOnly && (!selected.has('t') || !selected.has('e'))) {
            return { command: 'NO', code: 'NOPERM', text: 'Permission denied' };
        }
        return insertRefusal(connection, mailbox);
    };
    const replaceWrapper = (prevHandler: CommandHandler, connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
        const refusal = replaceRefusal(connection, argumentMailbox(parsed, 1));
        if (refusal) {
            connection.sendStatus(parsed, data, refusal.command, refusal.text, refusal.code, parsed.command.toUpperCase() + ' FAILED');
            return callback();
        }
        return prevHandler(connection, parsed, data, callback);
    };
    wrappers.REPLACE = replaceWrapper;
    wrappers['UID REPLACE'] = replaceWrapper;

    // The message literal of APPEND and REPLACE is refused before it is sent when the user may not add messages to the
    // target, with the same answer as after the literal. A mailbox the user can not see ("l") is refused like a
    // missing one, which the core literal filter refuses before the literal too, so the transcripts do not tell
    // a hidden mailbox from a missing one (RFC 4314 section 6)
    server.literalFilters.unshift((connection: IMAPConnection, command: string, line: string) => {
        if (isOwner(connection) || connection.isBusy()) {
            return false;
        }
        const path = getPendingTarget(connection, command, line);
        const mailbox = path !== false && server.getMailbox(path);
        if (!mailbox) {
            return false;
        }
        return command === 'APPEND' ? insertRefusal(connection, mailbox) : replaceRefusal(connection, mailbox);
    });

    // RFC 5464 section 3.3: mailbox annotations need "l" and any of "r", "s", "w", "i" or "p". Server
    // annotations (the empty mailbox name) are not covered by mailbox ACLs
    const METADATA_RIGHTS = ['r', 's', 'w', 'i', 'p'];
    const canUseMetadata = (rights: Rights) => rights.has('l') && METADATA_RIGHTS.some(right => rights.has(right));
    const metadataWrapper = (prevHandler: CommandHandler, connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
        const args = parsed.attributes || [];
        // GETMETADATA takes its options before the mailbox name (RFC 5464 errata 2785)
        const position = parsed.command.toUpperCase() === 'GETMETADATA' && Array.isArray(args[0]) ? 1 : 0;
        const mailbox = argumentMailbox(parsed, position);
        if (mailbox && mailboxArgument(parsed, position) !== '') {
            const rights = getRights(connection, mailbox);
            if (!canUseMetadata(rights)) {
                sendDenied(connection, parsed, data, rights);
                return callback();
            }
        }
        return prevHandler(connection, parsed, data, callback);
    };
    wrappers.GETMETADATA = metadataWrapper;
    wrappers.SETMETADATA = metadataWrapper;

    // Unsolicited METADATA responses (RFC 5464 section 4.4.2) only go to sessions that could read the
    // annotations of the mailbox. Server annotations have an empty mailbox name
    server.notifyFilters.push((connection: IMAPConnection, notification: NotifyEvent) => {
        const command: Partial<IMAPResponse> = notification.command || {};
        if (command.command !== 'METADATA' || isOwner(connection)) {
            return true;
        }
        const name = command.attributes && command.attributes[0];
        const path = name && typeof name === 'object' ? name.value : name;
        const mailbox = typeof path === 'string' && path !== '' && server.getMailbox(path);
        return !mailbox || canUseMetadata(getRights(connection, mailbox));
    });

    // RFC 9208 section 6: GETQUOTA needs no rights. GETQUOTAROOT needs "r" for the MESSAGE and STORAGE
    // resources, which tell about the messages of the mailbox, only MAILBOX needs no right. Without "r"
    // (or for a mailbox that does not exist, so nothing is disclosed) the QUOTA responses only list MAILBOX
    wrappers.GETQUOTAROOT = (prevHandler: CommandHandler, connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
        const mailbox = argumentMailbox(parsed, 0);
        if (!mailbox || !getRights(connection, mailbox).has('r')) {
            parsed.aclQuotaMailboxOnly = true;
        }
        return prevHandler(connection, parsed, data, callback);
    };

    // RFC 9208 section 6: SETQUOTA needs "a". The quota root is not a mailbox, so the user needs "a" on
    // every mailbox the quota root applies to (all personal mailboxes)
    wrappers.SETQUOTA = (prevHandler: CommandHandler, connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
        const args = parsed.attributes || [];
        if (args.length === 2 && Array.isArray(args[1])) {
            const isAdmin = Object.keys(server.folderCache).every(path => {
                const mailbox = server.folderCache[path];
                return !server.isPersonal(mailbox) || getRights(connection, mailbox).has('a');
            });
            if (!isAdmin) {
                sendNoPerm(connection, parsed, data);
                return callback();
            }
        }
        return prevHandler(connection, parsed, data, callback);
    };

    // EXPUNGE needs "e". In a read-only session the command handler refuses it already
    const expungeWrapper = (prevHandler: CommandHandler, connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
        if (!connection.readOnly && !getSelectedRights(connection).has('e')) {
            sendNoPerm(connection, parsed, data);
            return callback();
        }
        return prevHandler(connection, parsed, data, callback);
    };
    wrappers.EXPUNGE = expungeWrapper;
    wrappers['UID EXPUNGE'] = expungeWrapper;

    // UNAUTHENTICATE (RFC 8437): rights of the previous user must not stay with the session
    server.resetHandlers.push((connection: IMAPConnection) => {
        connection.aclRights = null;
    });

    server.connectionHandlers.push((connection: IMAPConnection) => {
        // A FETCH that implies setting \Seen MUST NOT set it without "s", and without "e" CLOSE MUST
        // close the mailbox without expunging (RFC 4314 section 4)
        const canSetSeen = connection.canSetSeen;
        const canExpunge = connection.canExpunge;
        connection.canSetSeen = () => canSetSeen.call(connection) && getSelectedRights(connection).has('s');
        connection.canExpunge = () => canExpunge.call(connection) && getSelectedRights(connection).has('e');
    });

    // STORE needs the right of at least one of the flags it changes, it SHOULD NOT fail otherwise.
    // The flags themselves are filtered by the store handlers
    const storeWrapper = (prevHandler: CommandHandler, connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
        const rights = getSelectedRights(connection);
        const args = parsed.attributes || [];
        const item = args.length >= 3 && args[args.length - 2] && args[args.length - 2].type === 'ATOM' && args[args.length - 2].value.toUpperCase();
        if (connection.readOnly || !item) {
            return prevHandler(connection, parsed, data, callback);
        }
        if (STORE_ITEMS.indexOf(item) < 0) {
            // other items of plugins (e.g. X-GM-LABELS) change shared message data like keywords do, so they
            // need "w". Unknown items are refused with BAD by the STORE handler
            if (Object.hasOwn(server.storeHandlers, item) && !rights.has('w')) {
                sendNoPerm(connection, parsed, data);
                return callback();
            }
            return prevHandler(connection, parsed, data, callback);
        }
        const flags: Attribute[] = ([] as Attribute[]).concat(args[args.length - 1] || []);
        try {
            flags.forEach(flag => checkSystemFlags(connection, normalizeSystemFlag(flagValue(flag))));
        } catch {
            // invalid flags are refused with BAD by the STORE handler
            return prevHandler(connection, parsed, data, callback);
        }
        let allowed: boolean;
        if (item.charAt(0) === '+' || item.charAt(0) === '-') {
            allowed = !flags.length || flags.some(flag => canSetFlag(rights, flag));
        } else {
            // replacing the flags changes every flag the user has rights for
            allowed = FLAG_RIGHTS.some(right => rights.has(right));
        }
        if (!allowed) {
            sendNoPerm(connection, parsed, data);
            return callback();
        }
        return prevHandler(connection, parsed, data, callback);
    };
    wrappers.STORE = storeWrapper;
    wrappers['UID STORE'] = storeWrapper;

    // Checks if an extended LIST command asks for the STATUS return option (RFC 5819)
    const hasStatusReturnOption = (parsed: ParsedCommand) => {
        const args = (parsed && parsed.attributes) || [];
        return args.some(
            (arg: any, i: number) =>
                arg &&
                arg.type === 'ATOM' &&
                /^RETURN$/i.test(arg.value) &&
                Array.isArray(args[i + 1]) &&
                args[i + 1].some((option: Attribute) => option && option.type === 'ATOM' && /^STATUS$/i.test(option.value))
        );
    };

    // Checks if any mailbox below a mailbox is visible to the user
    const hasVisibleChildren = (connection: IMAPConnection, mailbox: Mailbox) =>
        server.hasDescendant(mailbox.path, (child: Mailbox) => getRights(connection, child).has('l'));

    server.outputHandlers.push((connection: IMAPConnection, response: IMAPResponse, description: string, parsed: ParsedCommand, data: string, extra: any) => {
        if (isOwner(connection)) {
            return;
        }

        if ((description === 'LIST ITEM' || description === 'LSUB ITEM') && extra && extra.path) {
            // LIST and LSUB need "l", the mailbox is left out without it and never answered with NO
            if (!getRights(connection, extra).has('l')) {
                response.skipResponse = true;
                return;
            }
            const flags = response.attributes[0];
            if (!Array.isArray(flags)) {
                return;
            }
            response.attributes[0] = flags.slice();
            const index = flags.findIndex((flag: Attribute) => flag && flag.value === '\\HasChildren');
            if (index >= 0 && !hasVisibleChildren(connection, extra)) {
                // children that the user can not see do not count (RFC 3348 section 4)
                response.attributes[0][index] = { type: 'ATOM', value: '\\HasNoChildren' };
            }
            // RFC 5819 section 2: a mailbox that gets no STATUS response because it can not be selected
            // (no "r" right) MUST be listed with \Noselect
            const isSelectable = !flags.some((flag: Attribute) => flag && /^\\(Noselect|NonExistent)$/i.test(flag.value));
            if (isSelectable && hasStatusReturnOption(parsed) && !getRights(connection, extra).has('r')) {
                response.attributes[0].push({ type: 'ATOM', value: '\\Noselect' });
            }
            return;
        }

        if (description === 'QUOTA' && parsed && parsed.aclQuotaMailboxOnly && Array.isArray(response.attributes[1])) {
            // quota-resource = resource-name SP resource-usage SP resource-limit
            const list = response.attributes[1];
            const filtered: Attribute[] = [];
            for (let i = 0; i < list.length; i += 3) {
                if (list[i] && String(list[i].value).toUpperCase() === 'MAILBOX') {
                    filtered.push(list[i], list[i + 1], list[i + 2]);
                }
            }
            // quota-list needs at least one resource, so without a MAILBOX limit there is no QUOTA response
            if (filtered.length) {
                response.attributes[1] = filtered;
            } else {
                response.skipResponse = true;
            }
            return;
        }

        if (description === 'SELECT PERMANENTFLAGS') {
            // RFC 4314 section 5.1.1: PERMANENTFLAGS MUST reflect the rights of the user
            const section = response.attributes[0] && response.attributes[0].section;
            const rights = getSelectedRights(connection);
            if (section && Array.isArray(section[1])) {
                section[1] = section[1].filter((flag: Attribute) => (flag.value === '\\*' ? rights.has('w') : canSetFlag(rights, flag)));
            }
            return;
        }

        if (extra && extra.targetUids && extra.mailbox && /^(UID )?(COPY|MOVE COPYUID)$/.test(description)) {
            // RFC 4314 section 4: the copies only keep the flags the user has rights for in the target
            const rights = getRights(connection, extra.mailbox);
            const uids = new Set(extra.targetUids);
            extra.mailbox.messages.forEach((message: Message) => {
                if (uids.has(message.uid)) {
                    message.flags = message.flags.filter((flag: string) => canSetFlag(rights, flag));
                }
            });
        }
    });

    // The DELETE command MUST delete the ACL of the mailbox (RFC 4314 section 4), this matters when a
    // \Noselect placeholder stays for the children of the mailbox
    // DELETE and CREATE are core commands, so the handlers exist
    const prevDelete = server.getCommandHandler('DELETE') as CommandHandler;
    server.setCommandHandler('DELETE', (connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
        const mailbox = argumentMailbox(parsed, 0);
        prevDelete(connection, parsed, data, () => {
            const placeholder = argumentMailbox(parsed, 0);
            if (placeholder && placeholder !== mailbox) {
                delete placeholder.acl;
            }
            callback();
        });
    });

    // A new mailbox inherits the ACL of its parent (RFC 4314 section 4, CREATE SHOULD)
    const prevCreate = server.getCommandHandler('CREATE') as CommandHandler;
    server.setCommandHandler('CREATE', (connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
        const existing = new Set(Object.keys(server.folderCache));
        prevCreate(connection, parsed, data, () => {
            Object.keys(server.folderCache)
                .filter(path => !existing.has(path))
                .sort((a, b) => a.length - b.length)
                .forEach(path => {
                    const parent = getParent(path);
                    const mailbox = server.folderCache[path];
                    if (parent && parent !== mailbox) {
                        const acl: Acl = new Map();
                        getAcl(parent).forEach((rights, identifier) => acl.set(identifier, new Set(rights)));
                        mailbox.acl = acl;
                    }
                });
            callback();
        });
    });
}
