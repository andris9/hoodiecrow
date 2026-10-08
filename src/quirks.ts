/**
 * Quirk presets (#87): named sets of script rules (and plugins to leave out) that make the server behave like a known
 * real server, so a client test reproduces the bug of that server in every run, without the server itself. The
 * `quirks` option turns them on, the rules come after the rules of the `script` option. The probabilistic ones use
 * the random numbers of the `scriptSeed` option, so a run can be repeated. The presets are exported as data, copy
 * and adjust one as script rules when it does not fit
 */

import type { ScriptRule } from './script.js';
import type { Attribute, IMAPResponse } from './types.js';

/** A quirk preset */
export interface Quirk {
    description: string;
    /** script rules, see README "Scripted faults" */
    rules?: ScriptRule[] | undefined;
    /** plugins that are not loaded even when the `plugins` option lists them */
    removePlugins?: string[] | undefined;
}

const FETCH_COMMANDS = ['FETCH', 'UID FETCH'];

/**
 * The part a body section belongs to: "2.MIME", "2.HEADER" and "2" all belong to part 2, "HEADER" and "TEXT" to the
 * message itself
 *
 * @param {Array} section Section of a BODY item, its first entry is the section spec
 * @return {String} part path, "" for the message
 */
function partPath(section: Attribute[]): string {
    const spec = String((section[0] && section[0].value) || '').toUpperCase();
    return spec.replace(/(^|\.)(MIME|HEADER(\.FIELDS(\.NOT)?)?|TEXT)$/, '');
}

/**
 * Changes the BODY[...] values of an untagged FETCH response
 *
 * @param {Object} response Untagged FETCH response
 * @param {Function} change `(name, value, index)` returns the new value
 * @return {Object|undefined} the changed response, nothing for other responses
 */
function changeBodyValues(response: IMAPResponse, change: (name: Attribute, value: Attribute) => Attribute): IMAPResponse | undefined {
    const items = response.attributes && response.attributes[2];
    if (!Array.isArray(items) || !response.attributes[1] || response.attributes[1].value !== 'FETCH') {
        return undefined;
    }
    const changed = items.slice();
    for (let i = 0; i < changed.length - 1; i += 2) {
        const name = changed[i];
        if (name && name.type === 'ATOM' && String(name.value).toUpperCase() === 'BODY' && Array.isArray(name.section)) {
            changed[i + 1] = change(name, changed[i + 1]);
        }
    }
    return Object.assign({}, response, { attributes: [response.attributes[0], response.attributes[1], changed] });
}

export const quirks: Record<string, Quirk> = {
    'james-fetchgroup': {
        description:
            'Apache James FetchGroup: only the first section asked for a part in one FETCH is answered, later ones for the same ' +
            'part come back empty. BODY[2.MIME] BODY[2] gives a zero-length body, the reverse order loses the headers',
        rules: [
            {
                on: 'response',
                command: FETCH_COMMANDS,
                untagged: true,
                mutate: response => {
                    const seen = new Set<string>();
                    return changeBodyValues(response, (name, value) => {
                        const path = partPath(name.section);
                        if (seen.has(path)) {
                            return { type: 'LITERAL', value: '' };
                        }
                        seen.add(path);
                        return value;
                    });
                }
            }
        ]
    },
    'james-late-fetch': {
        description: 'Apache James: now and then (1 in 4) a FETCH response comes after the tagged OK of its command',
        rules: [{ on: 'response', command: FETCH_COMMANDS, untagged: true, chance: 0.25, defer: 'tagged' }]
    },
    'yahoo-quoted-sections': {
        description: 'Yahoo: short body sections (up to 100 octets without line breaks) are quoted strings instead of literals',
        rules: [
            {
                on: 'response',
                command: FETCH_COMMANDS,
                untagged: true,
                mutate: response =>
                    changeBodyValues(response, (name, value) =>
                        value && value.type === 'LITERAL' && typeof value.value === 'string' && value.value.length <= 100 && /^[\x20-\x7e]*$/.test(value.value)
                            ? { type: 'STRING', value: value.value }
                            : value
                    )
            }
        ]
    },
    'm365-throttle': {
        description: 'Microsoft 365: 1 in 10 commands (not LOGOUT) is refused with "BAD Request is throttled. Suggested Backoff Time: 1000 milliseconds"',
        rules: [
            {
                on: 'command',
                chance: 0.1,
                when: context => context.command !== 'LOGOUT',
                send: '$TAG BAD Request is throttled. Suggested Backoff Time: 1000 milliseconds\r\n'
            }
        ]
    },
    'no-uidplus': {
        description: 'A server without UIDPLUS: no APPENDUID, COPYUID or UID EXPUNGE, even when the plugins list it',
        removePlugins: ['UIDPLUS']
    },
    'no-move': {
        description: 'A server without MOVE, clients have to COPY, STORE \\Deleted and EXPUNGE',
        removePlugins: ['MOVE']
    }
};

/**
 * Resolves the `quirks` option
 *
 * @param {Array|String} names Quirk names
 * @return {Object} `{ rules, removePlugins }` of all of them, removePlugins maps a plugin name to the quirk that removes it
 * @throws {Error} for an unknown name
 */
export function resolveQuirks(names: string[] | string | null | undefined): { rules: ScriptRule[]; removePlugins: Map<string, string> } {
    const rules: ScriptRule[] = [];
    const removePlugins = new Map<string, string>();
    ([] as string[]).concat(names || []).forEach(name => {
        const key = String(name).toLowerCase();
        const quirk = Object.hasOwn(quirks, key) ? quirks[key] : null;
        if (!quirk) {
            throw new Error('Unknown quirk "' + name + '". Available quirks: ' + Object.keys(quirks).join(', '));
        }
        rules.push(...(quirk.rules || []));
        (quirk.removePlugins || []).forEach(plugin => removePlugins.set(plugin, key));
    });
    return { rules, removePlugins };
}
