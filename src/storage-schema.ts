/**
 * The shape of the `storage` option, which is also the shape of `server.control.snapshot()`: a JSON Schema for
 * editors and other tools, and the check the server runs on the option, so that a typo in a fixture ("message" for
 * "messages") fails with a clear error instead of an empty mailbox. Plugins keep their own data on mailboxes and
 * messages (acl, metadata, MODSEQ ...), so other keys are allowed, only the types of the known keys are checked
 */

import { MAX_NUMBER } from './numbers.js';
import { isDateTime } from './dates.js';

// keys of plugins, an unknown key that looks like a typo of a known key is refused unless a plugin uses it
const PLUGIN_KEYS = [
    'acl',
    'metadata',
    'special-use',
    'MAILBOXID',
    'HIGHESTMODSEQ',
    'qresyncExpunged',
    'appendLimit',
    'SAVEDATE',
    'MODSEQ',
    'EMAILID',
    'THREADID',
    'X-GM-LABELS',
    'X-GM-MSGID',
    'X-GM-THRID'
];

const flagList = { type: 'array', items: { type: 'string' } };
const nzNumber = { type: 'integer', minimum: 1, maximum: MAX_NUMBER };

/** JSON Schema (draft 2020-12) of the `storage` option */
export const storageSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'ImapKit storage',
    description: 'Namespaces by prefix ("INBOX", "", "INBOX.", "#shared/" ...), INBOX is a mailbox of its own',
    type: 'object',
    properties: { INBOX: { $ref: '#/$defs/mailbox' } },
    additionalProperties: { $ref: '#/$defs/namespace' },
    $defs: {
        message: {
            oneOf: [
                { type: 'string', description: 'the message source' },
                {
                    type: 'object',
                    properties: {
                        raw: { type: 'string', description: 'the message source (a Buffer also works in JavaScript)' },
                        uid: nzNumber,
                        flags: { oneOf: [{ type: 'string' }, flagList] },
                        internaldate: {
                            type: 'string',
                            description: 'RFC 3501 date-time, e.g. "14-Sep-2013 21:22:28 -0300" (a Date also works in JavaScript)'
                        },
                        recent: { type: 'boolean' }
                    }
                }
            ]
        },
        mailbox: {
            type: 'object',
            properties: {
                uid: { type: 'integer' },
                uidvalidity: nzNumber,
                uidnext: nzNumber,
                flags: flagList,
                permanentFlags: flagList,
                allowPermanentFlags: { type: 'boolean' },
                subscribed: { type: 'boolean' },
                knownFlags: flagList,
                messages: { type: 'array', items: { $ref: '#/$defs/message' } },
                folders: { type: 'object', additionalProperties: { $ref: '#/$defs/mailbox' } }
            }
        },
        namespace: {
            type: 'object',
            properties: {
                separator: { type: 'string', minLength: 1, maxLength: 1 },
                type: { enum: ['personal', 'user', 'shared'] },
                folders: { type: 'object', additionalProperties: { $ref: '#/$defs/mailbox' } }
            }
        }
    }
} as const;

// the keys the schema knows, the typo check compares unknown keys with them
const MAILBOX_KEYS = Object.keys(storageSchema.$defs.mailbox.properties);
const NAMESPACE_KEYS = ['separator', 'type'];
const MESSAGE_KEYS = Object.keys(storageSchema.$defs.message.oneOf[1].properties);

/**
 * Finds the known key that an unknown key looks like a typo of: the same key in another case, or one edit away
 *
 * @param {String} key Unknown key
 * @param {Array} known Known keys
 * @return {String|null} the known key, or null
 */
function typoOf(key: string, known: string[]): string | null {
    if (known.includes(key) || PLUGIN_KEYS.includes(key)) {
        return null;
    }
    return known.find(name => name.toLowerCase() === key.toLowerCase() || (key.length > 3 && editDistance(name, key) === 1)) || null;
}

/**
 * Levenshtein distance, only used for short keys
 */
function editDistance(a: string, b: string): number {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let previous = row[0];
        row[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const current = row[j];
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
            previous = current;
        }
    }
    return row[b.length];
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isFlagList = (value: unknown) => Array.isArray(value) && value.every(flag => typeof flag === 'string');
const isNz = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_NUMBER;

/**
 * Checks the `storage` option
 *
 * @param {Object} storage Storage
 * @throws {Error} "Invalid storage at <path>: <problem>"
 */
export function validateStorage(storage: unknown): void {
    const fail = (path: string, problem: string): never => {
        throw new Error('Invalid storage at ' + path + ': ' + problem);
    };
    const checkKeys = (value: Record<string, unknown>, path: string, known: string[]) => {
        Object.keys(value).forEach(key => {
            const typo = typoOf(key, known);
            if (typo) {
                fail(path, 'unknown key ' + JSON.stringify(key) + ', did you mean ' + JSON.stringify(typo) + '?');
            }
        });
    };
    const checkMessage = (message: unknown, path: string) => {
        if (typeof message === 'string' || message instanceof Uint8Array) {
            return;
        }
        if (!isObject(message)) {
            return fail(path, 'a message is a string or an object');
        }
        checkKeys(message, path, MESSAGE_KEYS);
        if (message.raw !== undefined && typeof message.raw !== 'string' && !(message.raw instanceof Uint8Array)) {
            fail(path + '.raw', 'must be a string');
        }
        if (message.uid !== undefined && !isNz(message.uid)) {
            fail(path + '.uid', 'must be an integer from 1 to ' + MAX_NUMBER);
        }
        if (message.flags !== undefined && typeof message.flags !== 'string' && !isFlagList(message.flags)) {
            fail(path + '.flags', 'must be a flag or a list of flags');
        }
        // FETCH sends the internal date as it is and SORT ARRIVAL reads it, so it must be a date-time of RFC 3501
        // section 9 (month names in any case, they are sent as "Jan", "Feb", ...) or a valid Date. The save date
        // of the SAVEDATE plugin is a date-time too (RFC 8514 section 4.2)
        for (const key of ['internaldate', 'SAVEDATE'] as const) {
            const value = message[key];
            if (value === undefined || value === false || (key === 'SAVEDATE' && value === null)) {
                continue;
            }
            if (value instanceof Date ? isNaN(value.getTime()) : !isDateTime(value)) {
                fail(path + '.' + key, 'must be a date-time string like "14-Sep-2013 21:22:28 -0300" or a Date, not ' + JSON.stringify(value));
            }
        }
        if (message.recent !== undefined && typeof message.recent !== 'boolean') {
            fail(path + '.recent', 'must be true or false');
        }
    };
    const checkMailbox = (mailbox: unknown, path: string, known: string[]) => {
        if (!isObject(mailbox)) {
            return fail(path, 'a mailbox is an object');
        }
        checkKeys(mailbox, path, known);
        for (const key of ['uidvalidity', 'uidnext'] as const) {
            if (mailbox[key] !== undefined && !isNz(mailbox[key])) {
                fail(path + '.' + key, 'must be an integer from 1 to ' + MAX_NUMBER);
            }
        }
        for (const key of ['flags', 'permanentFlags', 'knownFlags'] as const) {
            if (mailbox[key] !== undefined && !isFlagList(mailbox[key])) {
                fail(path + '.' + key, 'must be a list of strings');
            }
        }
        for (const key of ['allowPermanentFlags', 'subscribed'] as const) {
            if (mailbox[key] !== undefined && typeof mailbox[key] !== 'boolean') {
                fail(path + '.' + key, 'must be true or false');
            }
        }
        if (mailbox.messages !== undefined) {
            if (!Array.isArray(mailbox.messages)) {
                fail(path + '.messages', 'must be a list of messages');
            }
            (mailbox.messages as unknown[]).forEach((message, i) => checkMessage(message, path + '.messages[' + i + ']'));
        }
        if (mailbox.folders !== undefined) {
            if (!isObject(mailbox.folders)) {
                fail(path + '.folders', 'must be an object of mailboxes by name');
            }
            Object.keys(mailbox.folders as object).forEach(name =>
                checkMailbox((mailbox.folders as Record<string, unknown>)[name], path + '.folders[' + JSON.stringify(name) + ']', MAILBOX_KEYS)
            );
        }
    };

    if (!isObject(storage)) {
        fail('the top level', 'storage is an object of namespaces');
    }
    Object.keys(storage as object).forEach(key => {
        const value = (storage as Record<string, unknown>)[key];
        const path = JSON.stringify(key);
        if (key === 'INBOX') {
            return checkMailbox(value, path, MAILBOX_KEYS.concat('separator'));
        }
        checkMailbox(value, path, MAILBOX_KEYS.concat(NAMESPACE_KEYS));
        const namespace = value as Record<string, unknown>;
        if (namespace.separator !== undefined && (typeof namespace.separator !== 'string' || namespace.separator.length !== 1)) {
            fail(path + '.separator', 'must be a single character');
        }
        if (namespace.type !== undefined && !['personal', 'user', 'shared'].includes(namespace.type as string)) {
            fail(path + '.type', 'must be "personal", "user" or "shared"');
        }
    });
}
