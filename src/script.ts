import type { IMAPConnection, IMAPServer } from './server.js';
import type { IMAPResponse, ParsedCommand, Transport } from './types.js';

/**
 * Scripted faults: rules that make the server deviate from the protocol on purpose, to test how a client
 * copes with a broken or unusual server. Every rule watches one kind of event, the first rule that matches
 * an event handles it. Output rules see the exact bytes that are about to go out, after every plugin and the
 * core changed the response, so they can send anything at all, also what the strict server never would.
 */

/** The events a rule can watch */
export type ScriptEvent = 'greeting' | 'command' | 'input' | 'response' | 'continuation';

/** Bytes a rule sends, a function gets the context of the event */
export type ScriptBytes = string | Buffer | ((context: ScriptContext) => string | Buffer);

/** The event a rule is checked against */
export interface ScriptContext {
    event: ScriptEvent;
    connection: IMAPConnection;
    /** the number of the connection, 1 for the first one the server accepted */
    session: number;
    state: string;
    /** the authenticated user, or null */
    user: string | null;
    /** path of the selected mailbox, or null */
    mailbox: string | null;
    /** tag of the command the event belongs to, or null (greeting, unsolicited responses) */
    tag: string | null;
    /** name of the command the event belongs to in upper case (`"UID FETCH"`), or null */
    command: string | null;
    /** the received line (command, input) or the bytes about to be sent (output events), as a binary string */
    data: string;
    /** the description of the response, see `connection.send()` (response and continuation events) */
    description?: string | null | undefined;
    /** the response object (response and continuation events sent with `connection.send()`) */
    response?: IMAPResponse | undefined;
}

/** A rule as it is given to `server.script.add()` or the `script` option */
export interface ScriptRule {
    on: ScriptEvent;

    // matchers, all given ones must match

    /** command name or names, case-insensitive (`"FETCH"`, `"UID FETCH"`) */
    command?: string | string[] | undefined;
    /** command tag, a string matches exactly */
    tag?: string | RegExp | undefined;
    /** response description or descriptions (response and continuation events) */
    description?: string | string[] | undefined;
    /** connection number or numbers, 1 for the first connection */
    session?: number | number[] | undefined;
    user?: string | undefined;
    state?: string | string[] | undefined;
    /** path of the selected mailbox */
    mailbox?: string | undefined;
    /** only untagged (true) or only tagged (false) responses (response events) */
    untagged?: boolean | undefined;
    /** tested against `context.data`, a string is a regular expression source */
    match?: string | RegExp | undefined;
    when?: ((context: ScriptContext) => boolean) | undefined;
    /** the rule fires from the nth matching event on (default 1) */
    nth?: number | undefined;
    /** the rule fires this many times at most (default unlimited) */
    times?: number | undefined;

    // actions

    /** changes or replaces the response object before it is compiled (response events) */
    mutate?: ((response: IMAPResponse, context: ScriptContext) => IMAPResponse | void) | undefined;
    /** bytes to send instead of the output, or instead of answering the command or input line. `$TAG` in a string is the tag */
    send?: ScriptBytes | undefined;
    /** bytes to send before the output (output events) */
    before?: ScriptBytes | undefined;
    /** bytes to send after the output (output events) */
    after?: ScriptBytes | undefined;
    /** process the command or input line as usual after `send` (command and input events) */
    run?: boolean | undefined;
    /** send nothing (output events), or ignore the command or input line */
    drop?: boolean | undefined;
    /** milliseconds to wait before the output goes out, or before the command is handled. Later output waits too */
    delay?: number | undefined;
    /** write the bytes in pieces of this many octets */
    chunk?: number | undefined;
    /** milliseconds between the pieces of `chunk` (default 10) */
    chunkDelay?: number | undefined;
    /** send only this many octets of the bytes, then close the connection */
    truncate?: number | undefined;
    /** close the connection after the bytes are sent, `"reset"` destroys the socket instead of ending it */
    close?: boolean | 'reset' | undefined;
}

/** A rule that was added, `server.script.add()` returns it */
export interface ScriptHandle {
    readonly rule: ScriptRule;
    /** events that matched the rule, also before `nth` */
    readonly matched: number;
    /** events the rule handled */
    readonly hits: number;
    remove(): void;
}

/** Output that waits in the output queue of a connection, see `IMAPConnection#queueOutput` */
export interface OutputOperation {
    data?: Buffer | undefined;
    delay?: number | undefined;
    chunk?: number | undefined;
    chunkDelay?: number | undefined;
    close?: boolean | 'reset' | undefined;
    /** the transport layer of the connection when the output was queued */
    transport?: Transport | null | undefined;
}

const EVENTS: ScriptEvent[] = ['greeting', 'command', 'input', 'response', 'continuation'];
const OUTPUT_EVENTS: ScriptEvent[] = ['greeting', 'response', 'continuation'];

// the events where a key is valid, every other key is a typo and refused
const KEYS: Record<keyof ScriptRule, ScriptEvent[]> = {
    on: EVENTS,
    command: ['command', 'input', 'response', 'continuation'],
    tag: ['command', 'input', 'response', 'continuation'],
    description: ['response', 'continuation'],
    session: EVENTS,
    user: EVENTS,
    state: EVENTS,
    mailbox: EVENTS,
    untagged: ['response'],
    match: EVENTS,
    when: EVENTS,
    nth: EVENTS,
    times: EVENTS,
    mutate: ['response', 'continuation'],
    send: EVENTS,
    before: OUTPUT_EVENTS,
    after: OUTPUT_EVENTS,
    run: ['command', 'input'],
    drop: EVENTS,
    delay: ['greeting', 'command', 'response', 'continuation'],
    chunk: EVENTS,
    chunkDelay: EVENTS,
    truncate: EVENTS,
    close: EVENTS
};
const ACTIONS: (keyof ScriptRule)[] = ['mutate', 'send', 'before', 'after', 'run', 'drop', 'delay', 'chunk', 'truncate', 'close'];

const DEFAULT_CHUNK_DELAY = 10;

// matchers that list accepted values, kept as Sets so that matching an event allocates nothing
const SET_MATCHERS = ['command', 'description', 'session', 'state', 'user', 'mailbox'] as const;
type SetMatcher = (typeof SET_MATCHERS)[number];

interface Entry extends ScriptHandle {
    matched: number;
    hits: number;
    match: RegExp | null;
    sets: Partial<Record<SetMatcher, Set<string | number>>>;
}

/**
 * Turns bytes of a rule into a Buffer. A string is a binary string (one character per octet) like everywhere
 * in ImapKit, unless it has characters above U+00FF, then it is sent as UTF-8
 */
function resolveBytes(value: ScriptBytes | undefined, context: ScriptContext): Buffer | null {
    if (value === undefined) {
        return null;
    }
    const bytes = typeof value === 'function' ? value(context) : value;
    if (Buffer.isBuffer(bytes)) {
        return bytes;
    }
    const text = String(bytes).replace(/\$TAG/g, () => context.tag || '*');
    return Buffer.from(text, /[\u0100-\uffff]/.test(text) ? 'utf-8' : 'binary');
}

/**
 * Checks a rule given by the caller, a mistake is a TypeError right away instead of a rule that silently never fires
 *
 * @param {Object} rule Rule to check
 * @return {RegExp|null} the `match` expression
 */
function validateRule(rule: ScriptRule): RegExp | null {
    if (!rule || typeof rule !== 'object') {
        throw new TypeError('A script rule must be an object');
    }
    if (!EVENTS.includes(rule.on)) {
        throw new TypeError('Script rule "on" must be one of ' + EVENTS.join(', '));
    }
    for (const key of Object.keys(rule)) {
        const events = Object.hasOwn(KEYS, key) ? KEYS[key as keyof ScriptRule] : null;
        if (!events) {
            throw new TypeError('Unknown script rule option "' + key + '"');
        }
        if (!events.includes(rule.on)) {
            throw new TypeError('Script rule option "' + key + '" can not be used with "on": "' + rule.on + '"');
        }
    }
    if (!ACTIONS.some(key => rule[key] !== undefined && rule[key] !== false)) {
        throw new TypeError('A script rule needs an action (' + ACTIONS.join(', ') + ')');
    }
    if (rule.drop && (rule.send !== undefined || rule.run)) {
        throw new TypeError('Script rule option "drop" can not be combined with "send" or "run"');
    }
    if (rule.run && (rule.close || rule.truncate !== undefined)) {
        throw new TypeError('Script rule option "run" can not be combined with "close" or "truncate"');
    }
    if (rule.chunkDelay !== undefined && rule.chunk === undefined) {
        throw new TypeError('Script rule option "chunkDelay" needs "chunk"');
    }
    if (!OUTPUT_EVENTS.includes(rule.on) && rule.send === undefined && (rule.chunk !== undefined || rule.truncate !== undefined)) {
        // a command or input line has no output of its own to cut or split
        throw new TypeError('Script rule options "chunk" and "truncate" need "send" with "on": "' + rule.on + '"');
    }
    for (const key of ['nth', 'times', 'chunk'] as const) {
        if (rule[key] !== undefined && !(Number.isInteger(rule[key]) && (rule[key] as number) > 0)) {
            throw new TypeError('Script rule option "' + key + '" must be a positive integer');
        }
    }
    for (const key of ['delay', 'chunkDelay', 'truncate'] as const) {
        if (rule[key] !== undefined && !(Number.isInteger(rule[key]) && (rule[key] as number) >= 0)) {
            throw new TypeError('Script rule option "' + key + '" must be a non-negative integer');
        }
    }
    for (const key of ['when', 'mutate'] as const) {
        if (rule[key] !== undefined && typeof rule[key] !== 'function') {
            throw new TypeError('Script rule option "' + key + '" must be a function');
        }
    }
    for (const key of ['send', 'before', 'after'] as const) {
        const value = rule[key];
        if (value !== undefined && typeof value !== 'string' && typeof value !== 'function' && !Buffer.isBuffer(value)) {
            throw new TypeError('Script rule option "' + key + '" must be a string, a Buffer or a function');
        }
    }
    if (rule.close !== undefined && typeof rule.close !== 'boolean' && rule.close !== 'reset') {
        throw new TypeError('Script rule option "close" must be true, false or "reset"');
    }
    if (rule.match === undefined) {
        return null;
    }
    if (rule.match instanceof RegExp) {
        // a global or sticky expression would keep its position between events
        return new RegExp(rule.match.source, rule.match.flags.replace(/[gy]/g, ''));
    }
    if (typeof rule.match !== 'string') {
        throw new TypeError('Script rule option "match" must be a string or a RegExp');
    }
    try {
        return new RegExp(rule.match);
    } catch (err) {
        throw new TypeError('Script rule option "match" is not a valid regular expression: ' + (err as Error).message, { cause: err });
    }
}

/**
 * The script of a server, `server.script`
 */
export class ServerScript {
    declare server: IMAPServer;
    declare entries: Entry[];
    /** the events that rules watch, so that an event nobody watches costs one lookup */
    declare watched: Set<ScriptEvent>;

    constructor(server: IMAPServer, rules?: ScriptRule | ScriptRule[] | undefined) {
        this.server = server;
        this.entries = [];
        this.watched = new Set();
        if (rules) {
            this.add(rules);
        }
    }

    /** the rules that were added, in the order they are checked */
    get rules(): ScriptHandle[] {
        return this.entries.slice();
    }

    /**
     * Adds a rule, or a list of rules, after the rules added earlier
     *
     * @param {Object|Array} rules Rule or rules
     * @return {Object|Array} handle or handles with `hits`, `matched` and `remove()`
     */
    add(rule: ScriptRule): ScriptHandle;
    add(rules: ScriptRule[]): ScriptHandle[];
    add(rules: ScriptRule | ScriptRule[]): ScriptHandle | ScriptHandle[];
    add(rules: ScriptRule | ScriptRule[]): ScriptHandle | ScriptHandle[] {
        if (Array.isArray(rules)) {
            // all rules are checked before any is added
            const matches = rules.map(validateRule);
            return rules.map((rule, i) => this.addEntry(rule, matches[i] as RegExp | null));
        }
        return this.addEntry(rules, validateRule(rules));
    }

    /** removes every rule */
    clear(): void {
        this.setEntries([]);
    }

    /**
     * Checks if any rule watches an event, so that the event can skip building a context
     *
     * @param {String} event Event name
     * @return {Boolean} true if a rule watches the event
     */
    watches(event: ScriptEvent): boolean {
        return this.watched.has(event);
    }

    /**
     * Finds the rule that handles an event of a connection
     *
     * @param {Object} connection IMAP connection
     * @param {String} event Event name
     * @param {Object} fields `data`, and `tag`, `command`, `description`, `response` where they are known
     * @return {Object|null} `{ rule, context }`, or null if no rule handles the event
     */
    check(
        connection: IMAPConnection,
        event: ScriptEvent,
        fields: Partial<ScriptContext> & { data: string }
    ): { rule: ScriptRule; context: ScriptContext } | null {
        if (!this.watched.has(event)) {
            return null;
        }
        const context = scriptContext(connection, event, fields);
        const rule = this.find(context);
        return rule ? { rule, context } : null;
    }

    private setEntries(entries: Entry[]): void {
        this.entries = entries;
        this.watched = new Set(entries.map(entry => entry.rule.on));
    }

    private addEntry(rule: ScriptRule, match: RegExp | null): ScriptHandle {
        // a copy, so that changing the caller's object later does not change the rule
        const copy = Object.freeze(Object.assign({}, rule));
        const sets: Entry['sets'] = {};
        for (const key of SET_MATCHERS) {
            if (copy[key] !== undefined) {
                // command names are compared in upper case
                const values = ([] as (string | number)[]).concat(copy[key] as string | number | (string | number)[]);
                sets[key] = new Set(key === 'command' ? values.map(value => String(value).toUpperCase()) : values);
            }
        }
        const entry: Entry = {
            rule: copy,
            match,
            sets,
            matched: 0,
            hits: 0,
            remove: () => this.setEntries(this.entries.filter(item => item !== entry))
        };
        this.setEntries(this.entries.concat(entry));
        return entry;
    }

    /**
     * Finds the rule that handles an event and counts it
     *
     * @param {Object} context Event context
     * @return {Object|null} the rule, or null if no rule handles the event
     */
    find(context: ScriptContext): ScriptRule | null {
        for (const entry of this.entries) {
            const rule = entry.rule;
            if (rule.on !== context.event || !this.matches(entry, context)) {
                continue;
            }
            entry.matched++;
            if (entry.matched < (rule.nth || 1) || (rule.times !== undefined && entry.hits >= rule.times)) {
                continue;
            }
            entry.hits++;
            this.server.emit('script', { rule, event: context.event, session: context.session, tag: context.tag, command: context.command });
            return rule;
        }
        return null;
    }

    private matches(entry: Entry, context: ScriptContext): boolean {
        const rule = entry.rule;
        for (const key of SET_MATCHERS) {
            const set = entry.sets[key];
            const value = context[key];
            if (set && (value === null || value === undefined || !set.has(value))) {
                return false;
            }
        }
        if (rule.tag !== undefined && (context.tag === null || (rule.tag instanceof RegExp ? !rule.tag.test(context.tag) : rule.tag !== context.tag))) {
            return false;
        }
        if (rule.untagged !== undefined && rule.untagged !== (!context.response || context.response.tag === '*')) {
            return false;
        }
        if (entry.match && !entry.match.test(context.data)) {
            return false;
        }
        return !rule.when || !!rule.when(context);
    }
}

/**
 * Builds the context of an event on a connection
 *
 * @param {Object} connection IMAP connection
 * @param {String} event Event name
 * @param {Object} fields `data`, and `tag`, `command`, `description`, `response` where they are known
 * @return {Object} Event context
 */
function scriptContext(connection: IMAPConnection, event: ScriptEvent, fields: Partial<ScriptContext> & { data: string }): ScriptContext {
    // after its handler returned, a command whose input handler reads the lines (IDLE, AUTHENTICATE) is the one
    // the events belong to
    const running = connection._runningCommand
        ? (connection._runningCommand.parsed as ParsedCommand)
        : connection.inputHandler
          ? connection.inputCommand
          : null;
    return Object.assign(
        {
            event,
            connection,
            session: connection.sessionNumber,
            state: connection.state,
            user: connection.username || null,
            mailbox: connection.selectedMailbox ? connection.selectedMailbox.path : null,
            tag: running ? running.tag : null,
            command: running ? String(running.command).toUpperCase() : null
        },
        fields
    );
}

/**
 * Sends output through the rule that handles it: the output itself (unless dropped or replaced with `send`)
 * between `before` and `after`, cut by `truncate`, with the timing of `delay` and `chunk`
 *
 * @param {Object} connection IMAP connection
 * @param {Object} rule Rule that handles the output
 * @param {Object} context Event context
 * @param {Buffer} output The output
 */
export function sendOutput(connection: IMAPConnection, rule: ScriptRule, context: ScriptContext, output: Buffer): void {
    const replaced = rule.drop ? Buffer.alloc(0) : resolveBytes(rule.send, context) || output;
    const parts = [resolveBytes(rule.before, context), replaced, resolveBytes(rule.after, context)].filter((part): part is Buffer => !!part);
    sendBytes(connection, rule, Buffer.concat(parts), rule.delay);
}

/**
 * Sends the bytes of a rule with its timing, `truncate` closes the connection after the cut
 *
 * @param {Object} connection IMAP connection
 * @param {Object} rule Rule
 * @param {Buffer} data Bytes to send
 * @param {Number} [delay] Milliseconds to wait first
 */
function sendBytes(connection: IMAPConnection, rule: ScriptRule, data: Buffer, delay?: number | undefined): void {
    connection.queueOutput({
        data: rule.truncate === undefined ? data : data.subarray(0, rule.truncate),
        delay,
        chunk: rule.chunk,
        chunkDelay: rule.chunkDelay === undefined ? DEFAULT_CHUNK_DELAY : rule.chunkDelay,
        close: rule.close || (rule.truncate === undefined ? undefined : true)
    });
}

/**
 * Handles a command or input line with the rule that matched it: sends the bytes of `send`, closes the connection,
 * and processes the line as usual with `run` (or when the rule only delays it)
 *
 * @param {Object} connection IMAP connection
 * @param {Object} rule Rule that matched
 * @param {Object} context Event context
 * @param {Function} run Processes the line as usual
 */
export function handleLine(connection: IMAPConnection, rule: ScriptRule, context: ScriptContext, run: () => void): void {
    const bytes = resolveBytes(rule.send, context);
    if (bytes || rule.close) {
        sendBytes(connection, rule, bytes || Buffer.alloc(0));
    }
    // a rule that only delays the line does not replace it
    if (rule.run || (!rule.drop && !bytes && !rule.close)) {
        run();
    }
}
