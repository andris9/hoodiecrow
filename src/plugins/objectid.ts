import { badError } from '../commands/handlers/search.js';
import type { IMAPConnection, IMAPResponse, IMAPServer, Mailbox, Message, ParsedCommand } from '../types.js';

// RFC 8474 section 7: objectid = 1*255(ALPHA / DIGIT / "_" / "-"), case sensitive
const OBJECTID = /^[A-Za-z0-9_-]{1,255}$/;

// header fields that threading uses, in an unfolded header
const MESSAGE_ID_HEADER = /^Message-ID[ \t]*:(.*)$/im;
const REFERENCES_HEADER = /^References[ \t]*:(.*)$/im;
const IN_REPLY_TO_HEADER = /^In-Reply-To[ \t]*:(.*)$/im;

// uidvalidity a MAILBOXID was assigned for
const ASSIGNED_FOR = Symbol('mailboxid-uidvalidity');

/** A mailbox with the uidvalidity its MAILBOXID was assigned for */
type TrackedMailbox = Mailbox & { [ASSIGNED_FOR]?: number | undefined };

type IdPrefix = 'F' | 'M' | 'T';

/**
 * @help Adds OBJECTID [RFC8474] capability
 * @help MAILBOXID, EMAILID and THREADID values are generated (F1, M1, T1, ...)
 * @help unless storage sets them for a mailbox ("MAILBOXID") or a message
 * @help ("EMAILID", "THREADID"). Messages are threaded by their Message-ID,
 * @help In-Reply-To and References headers across all mailboxes
 *
 * OBJECTID: https://www.rfc-editor.org/rfc/rfc8474.txt
 *
 * Additional response codes:
 * - MAILBOXID for CREATE, SELECT and EXAMINE
 *
 * Additional STATUS items:
 * - MAILBOXID
 *
 * Additional FETCH items:
 * - EMAILID, THREADID
 *
 * Additional SEARCH keys:
 * - EMAILID, THREADID
 */
export default function objectidPlugin(server: IMAPServer) {
    server.registerCapability('OBJECTID');

    // kind (F, M or T) of every value ever used, generated values must not collide with them
    const used = new Map<string, IdPrefix>();
    const counters: Record<IdPrefix, number> = { F: 0, M: 0, T: 0 };
    // current owner of each MAILBOXID, RFC 8474 section 4: never two mailboxes at the same time
    const mailboxOwners = new Map<string, Mailbox>();
    // THREADID by EMAILID, RFC 8474 section 5.2: the same EMAILID always has the same THREADID
    const emailThreads = new Map<string, string>();
    // THREADID by Message-ID, for threading
    const messageIdThreads = new Map<string, string>();

    // RFC 8474 section 8.1: the prefix keeps generated ids from starting with a digit or a dash
    const generate = (prefix: IdPrefix) => {
        let id: string;
        do {
            id = prefix + ++counters[prefix];
        } while (used.has(id));
        used.set(id, prefix);
        return id;
    };

    const checkValue = (value: unknown, what: string, owner: string) => {
        if (typeof value !== 'string' || !OBJECTID.test(value)) {
            throw new Error('Invalid ' + what + ' value ' + JSON.stringify(value) + ' in ' + owner);
        }
    };

    // RFC 8474 section 5.2: an id is used for one kind of object only
    const checkUnique = (value: string, prefix: IdPrefix) => {
        if (used.has(value) && used.get(value) !== prefix) {
            throw new Error('Object identifier ' + JSON.stringify(value) + ' is already used for another kind of object');
        }
        used.set(value, prefix);
    };

    /**
     * Returns the MAILBOXID of a mailbox. A mailbox that got a new UIDVALIDITY (re-created after
     * DELETE) is a new mailbox and gets a new id (RFC 8474 section 4)
     */
    const getMailboxId = (mailbox: TrackedMailbox): string => {
        if (mailbox[ASSIGNED_FOR] === mailbox.uidvalidity && mailboxOwners.get(mailbox.MAILBOXID) === mailbox) {
            return mailbox.MAILBOXID;
        }

        let id: string;
        if (mailbox.MAILBOXID && mailbox[ASSIGNED_FOR] === undefined && !mailboxOwners.has(mailbox.MAILBOXID)) {
            // value from storage
            id = mailbox.MAILBOXID;
            checkValue(id, 'MAILBOXID', 'mailbox ' + mailbox.path);
            checkUnique(id, 'F');
        } else {
            // a new mailbox, or a copy of a deleted one (a \Noselect placeholder that is created again)
            id = generate('F');
        }

        mailbox.MAILBOXID = id;
        mailbox[ASSIGNED_FOR] = mailbox.uidvalidity;
        mailboxOwners.set(id, mailbox);
        return id;
    };

    // Assign ids when mailboxes are loaded or created. A \Noselect placeholder is not a mailbox
    server.mailboxHandlers.push((server: IMAPServer, mailbox: TrackedMailbox) => {
        if (mailbox.flags.indexOf('\\Noselect') >= 0) {
            return;
        }
        if (mailbox.MAILBOXID && mailbox[ASSIGNED_FOR] === undefined && mailboxOwners.has(mailbox.MAILBOXID)) {
            // two mailboxes in storage with the same id
            throw new Error('Duplicate MAILBOXID value ' + JSON.stringify(mailbox.MAILBOXID) + ' in mailbox ' + mailbox.path);
        }
        getMailboxId(mailbox);
    });

    server.messageHandlers.push((server: IMAPServer, message: Message, mailbox: Mailbox) => {
        const owner = 'a message of mailbox ' + mailbox.path;

        if (message.EMAILID) {
            checkValue(message.EMAILID, 'EMAILID', owner);
            checkUnique(message.EMAILID, 'M');
        } else {
            message.EMAILID = generate('M');
        }

        if (message.THREADID) {
            checkValue(message.THREADID, 'THREADID', owner);
            checkUnique(message.THREADID, 'T');
        }

        const threadOfEmail = emailThreads.get(message.EMAILID);
        if (threadOfEmail && message.THREADID && message.THREADID !== threadOfEmail) {
            throw new Error('Messages with EMAILID ' + JSON.stringify(message.EMAILID) + ' must have the same THREADID');
        }

        const ids = getThreadingIds(message.raw);
        message.THREADID = message.THREADID || threadOfEmail || findThread(ids.references) || generate('T');
        emailThreads.set(message.EMAILID, message.THREADID);

        // later replies, and later messages with a common parent, join this thread
        [ids.messageId].concat(ids.references).forEach(id => {
            if (id && !messageIdThreads.has(id)) {
                messageIdThreads.set(id, message.THREADID);
            }
        });
    });

    // the nearest known parent decides the thread
    const findThread = (references: string[]) => {
        for (let i = references.length - 1; i >= 0; i--) {
            if (messageIdThreads.has(references[i])) {
                return messageIdThreads.get(references[i]);
            }
        }
        return false;
    };

    // RFC 8474 section 5.1: the copy in the COPYUID pairing has the EMAILID of the source, after COPY as well as after MOVE
    server.copyHandlers.push((server: IMAPServer, source: Message, copy: Record<string, any>) => {
        if (source.EMAILID) {
            copy.EMAILID = source.EMAILID;
            copy.THREADID = source.THREADID;
        }
    });

    // RFC 8474 section 4.3
    server.allowedStatus.push('MAILBOXID');
    server.statusHandlers.MAILBOXID = (connection: IMAPConnection, mailbox: Mailbox) => [{ type: 'ATOM', value: getMailboxId(mailbox) }];

    // RFC 8474 section 5.3
    server.fetchHandlers.EMAILID = (connection: IMAPConnection, message: Message) => [{ type: 'ATOM', value: message.EMAILID }];
    server.fetchHandlers.THREADID = (connection: IMAPConnection, message: Message) => [{ type: 'ATOM', value: message.THREADID }];

    // RFC 8474 section 6: search-key =/ "EMAILID" SP objectid / "THREADID" SP objectid
    const objectIdArgument = (value: string) => {
        if (!OBJECTID.test(value)) {
            throw badError('Invalid object identifier');
        }
        return value;
    };

    const searchHandler = (name: string) => {
        const handler = (connection: IMAPConnection, message: Message, index: number, value: string) => message[name] === value;
        handler.argumentTypes = () => [objectIdArgument];
        server.searchHandlers[name] = handler;
    };
    searchHandler('EMAILID');
    searchHandler('THREADID');

    // resp-text-code =/ "MAILBOXID" SP "(" objectid ")"
    const mailboxIdCode = (mailbox: Mailbox) => ({
        type: 'SECTION',
        section: [{ type: 'ATOM', value: 'MAILBOXID' }, [{ type: 'ATOM', value: getMailboxId(mailbox) }]]
    });

    server.outputHandlers.push((connection: IMAPConnection, response: IMAPResponse, description: string, parsed: ParsedCommand, data: string, extra: any) => {
        // RFC 8474 section 4.1: MAILBOXID response code in the tagged OK of CREATE
        if (description === 'CREATE' && response.command === 'OK' && extra) {
            response.attributes = [mailboxIdCode(extra)].concat(response.attributes || []);
            return;
        }

        // RFC 8474 section 4.2: untagged OK with MAILBOXID on every successful SELECT and EXAMINE
        if (
            (description === 'SELECT' || description === 'EXAMINE') &&
            parsed &&
            response.tag === parsed.tag &&
            response.command === 'OK' &&
            connection.selectedMailbox
        ) {
            connection.send(
                {
                    tag: '*',
                    command: 'OK',
                    attributes: [mailboxIdCode(connection.selectedMailbox), { type: 'TEXT', value: 'Ok' }]
                },
                description + ' MAILBOXID',
                parsed,
                data
            );
        }
    });
}

/**
 * Reads the message ids that threading uses from the header of a message
 *
 * @param {String} raw Message source
 * @return {Object} `{ messageId, references }`, references lists the ids of References and In-Reply-To, the parent last
 */
function getThreadingIds(raw: string): { messageId: string | false; references: string[] } {
    raw = raw || '';
    const end = raw.search(/\r?\n\r?\n/);
    // unfolded header lines
    const header = (end >= 0 ? raw.substr(0, end) : raw).replace(/\r?\n(?=[ \t])/g, '');

    const getIds = (regex: RegExp): string[] => {
        const match = header.match(regex);
        return match ? match[1].match(/<[^<>\s]+>/g) || [] : [];
    };

    return {
        messageId: getIds(MESSAGE_ID_HEADER)[0] || false,
        // In-Reply-To names the parent, which is also the last entry of References
        references: getIds(REFERENCES_HEADER).concat(getIds(IN_REPLY_TO_HEADER))
    };
}
