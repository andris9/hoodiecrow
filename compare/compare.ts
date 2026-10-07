// Replays the same IMAP commands against ImapKit and a Dovecot reference
// server and shows where the responses differ. This is a development aid for
// checking what RFC compliant input and output look like, not a test suite:
// Dovecot has its own bugs and extensions, so a difference is a hint to check
// the RFC, not proof that ImapKit is wrong. See CLAUDE.md for usage.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { parseArgs } from 'node:util';
import imapkit from '../src/server.js';
import { splitAtLiterals } from '../src/framing.js';
import DeflateLayer from '../src/deflate-layer.js';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { IMAPServer } from '../src/server.js';
import type { Mailbox, Message, StorageNamespace } from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_STORAGE = path.join(__dirname, 'storage.json');

const IMAPKIT_USER = 'testuser';
const IMAPKIT_PASS = 'testpass';
const DOVECOT_PASS = 'pass';

// storage JSON as read from a file, checked by ImapKit itself
type Storage = Record<string, any>;

/** A parsed scenario step */
type Step =
    | { type: 'wait'; ms: number; line: number; session?: undefined; tag?: undefined; text?: undefined }
    | { type: 'raw'; session: number; tag: null; text: string; line: number; ms?: undefined }
    | { type: 'command'; session: number; tag: string; text: string; line: number; ms?: undefined };

/** Values for $USER, $PASS and $UIDVALIDITY */
interface PayloadVars {
    user: string;
    pass: string;
    uidvalidity?: string | undefined;
}

interface NormalizeOptions {
    keepText?: boolean | undefined;
    exact?: boolean | undefined;
}

interface SeedFolder {
    path: string;
    subscribed: boolean | undefined;
    messages: { uid: number; raw: string; internaldate: string; flags: string[] }[];
}

interface Seed {
    folders: SeedFolder[];
    warnings: string[];
}

interface Target extends PayloadVars {
    name: string;
    host: string;
    port: number;
    seed?: ((session: Session) => Promise<string[]>) | undefined;
}

interface RunOptions {
    timeout: number;
    settle: number;
    manualLogin?: boolean | undefined;
    baseDir: string;
}

/** Responses of one step, keyed by session id */
type StepResponses = Record<number, Buffer[]>;

interface StepResult {
    responses: StepResponses;
    notes: string[];
}

interface TargetResult {
    setup: { session: number; response: Buffer }[];
    steps: StepResult[];
    warnings: string[];
}

/**
 * Parses scenario text into steps.
 *
 * Syntax, one step per line:
 *   # comment                  ignored, as are blank lines
 *   SELECT INBOX               sent with an automatic tag (A1, A2, ...)
 *   2: SELECT INBOX            sent on session 2 (sessions open on first use, default 1)
 *   > DONE                     sent verbatim, without a tag (also "2:> DONE")
 *   !wait 500                  pause, then collect whatever the sessions received
 *
 * In commands and verbatim lines, the four characters \r\n become CRLF and
 * {file:path} or {file+:path} become a synchronizing or non-synchronizing
 * literal with the file contents (line endings converted to CRLF, path relative
 * to the scenario file). ~{file:path} and ~{file+:path} become a literal8
 * (RFC 3516) with the file octets as they are. $USER and $PASS expand to the
 * target's credentials, $UIDVALIDITY to the last UIDVALIDITY value the target
 * sent (for QRESYNC).
 *
 * @param {String} text Scenario source
 * @return {Array} steps
 */
function parseScenario(text: string): Step[] {
    const steps: Step[] = [];
    let tagCounter = 0;

    text.split(/\r?\n/).forEach((rawLine, i) => {
        const line = rawLine.trim();
        if (!line || line.charAt(0) === '#') {
            return;
        }

        if (line.charAt(0) === '!') {
            const [directive, arg] = line.substr(1).split(/\s+/);
            if (directive!.toLowerCase() !== 'wait' || !/^\d+$/.test(arg || '')) {
                throw new Error(`Line ${i + 1}: unknown directive "${line}", expected "!wait <ms>"`);
            }
            steps.push({ type: 'wait', ms: Number(arg), line: i + 1 });
            return;
        }

        let session = 1;
        let rest = line;
        const sessionMatch = rest.match(/^(\d+):\s*/);
        if (sessionMatch) {
            session = Number(sessionMatch[1]);
            rest = rest.substr(sessionMatch[0].length);
        }

        if (rest.charAt(0) === '>') {
            steps.push({ type: 'raw', session, tag: null, text: rest.substr(1).trim(), line: i + 1 });
            return;
        }

        const tag = 'A' + ++tagCounter;
        steps.push({ type: 'command', session, tag, text: tag + ' ' + rest, line: i + 1 });
    });

    return steps;
}

/**
 * Turns a step's text into the bytes to send, expanding escapes, placeholders and file literals
 *
 * @param {String} text Step text
 * @param {Object} vars Values for $USER, $PASS and $UIDVALIDITY
 * @param {String} baseDir Directory that {file:path} placeholders are resolved against
 * @return {Buffer} payload, including the final CRLF
 */
function buildPayload(text: string, vars: PayloadVars, baseDir: string): Buffer {
    const parts: Buffer[] = [];
    const re = /(~?)\{file(\+?):([^}]+)\}/g;
    let last = 0;
    let match;

    const pushText = (str: string) => {
        str = str
            .replace(/\$USER\b/g, vars.user)
            .replace(/\$PASS\b/g, vars.pass)
            .replace(/\$UIDVALIDITY\b/g, vars.uidvalidity || '1')
            .replace(/\\r\\n/g, '\r\n');
        parts.push(Buffer.from(str, 'utf8'));
    };

    while ((match = re.exec(text))) {
        pushText(text.slice(last, match.index));
        const file = path.resolve(baseDir, match[3]!.trim());
        // a literal8 (RFC 3516) carries the file octets as they are, they may be binary
        const content = match[1] ? fs.readFileSync(file) : Buffer.from(fs.readFileSync(file, 'utf8').replace(/\r?\n/g, '\r\n'), 'utf8');
        parts.push(Buffer.from(`${match[1]}{${content.length}${match[2]}}\r\n`), content);
        last = re.lastIndex;
    }
    pushText(text.slice(last));
    parts.push(Buffer.from('\r\n'));

    return Buffer.concat(parts);
}

/**
 * Normalizes a response for comparison: removes Dovecot's command timings, the
 * human readable text of status responses (unless keepText is set) and values
 * that legitimately differ between servers, such as UIDVALIDITY. Unless exact
 * is set, it also sorts flag and mailbox attribute lists and unquotes mailbox
 * names that are valid atoms, as neither changes the meaning.
 *
 * @param {String} response Response as a latin1 string, without the final CRLF
 * @param {Object} [options] keepText to compare the human readable text too, exact to keep order and quoting
 * @return {String} normalized response
 */
function normalizeResponse(response: string, options: NormalizeOptions = {}): string {
    let result = response.replace(/ \(\d+\.\d+(?: \+ \d+\.\d+)+ secs\)/g, '');

    if (!options.keepText) {
        result = result.replace(/^((?:\*|[^\s*+]+) (?:OK|NO|BAD|BYE|PREAUTH)(?: \[[^\]]*\])?)(?: [^\r\n]*)?$/i, '$1');
        // continuation requests carry free text (or a SASL challenge); keep "+" and "+ " apart
        result = result.replace(/^\+ .+$/, '+ <text>');
    }

    result = result.replace(/\bUIDVALIDITY (\d+)/gi, 'UIDVALIDITY <n>').replace(/\[(COPYUID|APPENDUID) \d+/gi, '[$1 <n>');

    if (!options.exact) {
        const sortList = (list: string) =>
            list
                .split(' ')
                .filter(Boolean)
                .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
                .join(' ');
        const unquote = (name: string) => (/^"[!#$&'+,\-./0-9:;<=>?@A-Z[^_`a-z|}~]+"$/.test(name) && name.toUpperCase() !== '"NIL"' ? name.slice(1, -1) : name);

        result = result
            .replace(/\b(FLAGS|PERMANENTFLAGS) \(([^)]*)\)/gi, (m, key: string, list: string) => `${key} (${sortList(list)})`)
            .replace(
                /^\* (LIST|LSUB) \(([^)]*)\) (\S+) (.+)$/i,
                (m, cmd: string, attrs: string, sep: string, name: string) => `* ${cmd} (${sortList(attrs)}) ${sep} ${unquote(name)}`
            )
            .replace(/^\* STATUS ("[^"]*"|\S+) /i, (m, name: string) => `* STATUS ${unquote(name)} `);
    }

    return result;
}

/**
 * Normalizes all responses of one session in a step. Unless exact is set, LIST
 * and LSUB responses are sorted, as RFC 3501 does not define their order.
 *
 * @param {Array} responses Buffers
 * @param {Object} [options] Same as for normalizeResponse
 * @return {Array} normalized strings
 */
function normalizeResponses(responses: Buffer[], options: NormalizeOptions = {}): string[] {
    const result = responses.map(response => normalizeResponse(response.toString('latin1'), options));

    if (!options.exact) {
        const isList = (str: string) => /^\* (LIST|LSUB) /i.test(str);
        const positions = result.map((str, i) => (isList(str) ? i : -1)).filter(i => i >= 0);
        const sorted = positions.map(i => result[i]).sort();
        positions.forEach((pos, i) => {
            result[pos] = sorted[i]!;
        });
    }

    return result;
}

/**
 * A minimal IMAP client session that keeps every response, splitting the input
 * into complete responses (including any literals they carry).
 */
class Session extends EventEmitter {
    responses: Buffer[];
    mark: number;
    openTag: string | null;
    closed: boolean;
    socket?: net.Socket;
    layer: DeflateLayer | null;
    private _buffer: Buffer;
    private _current: Buffer[];
    private _literalRemaining: number;
    private _compressTag: string | null;

    constructor() {
        super();
        this.responses = [];
        // index into responses up to which the output was already reported
        this.mark = 0;
        // tag of a command that is waiting for more client input, such as IDLE or AUTHENTICATE
        this.openTag = null;
        this.closed = false;
        this._buffer = Buffer.alloc(0);
        this._current = [];
        this._literalRemaining = 0;
        // COMPRESS=DEFLATE layer (RFC 4978), once the server accepted COMPRESS
        this.layer = null;
        // tag of a COMPRESS DEFLATE command waiting for its result
        this._compressTag = null;
    }

    connect(host: string, port: number, timeout: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const socket = net.connect(port, host);
            this.socket = socket;
            socket.on('data', (chunk: Buffer) => (this.layer ? this.layer.receive(chunk) : this._onData(chunk)));
            socket.on('close', () => {
                this.closed = true;
                this.emit('close');
            });
            socket.on('error', err => {
                this.closed = true;
                reject(err);
            });
            this.waitFor(() => true, timeout).then(found => {
                if (!found) {
                    reject(new Error(`No greeting from ${host}:${port}`));
                }
                resolve();
            });
        });
    }

    _onData(chunk: Buffer) {
        this._buffer = Buffer.concat([this._buffer, chunk]);

        for (;;) {
            if (this._literalRemaining) {
                if (this._buffer.length < this._literalRemaining) {
                    this._current.push(this._buffer);
                    this._literalRemaining -= this._buffer.length;
                    this._buffer = Buffer.alloc(0);
                    return;
                }
                this._current.push(this._buffer.subarray(0, this._literalRemaining));
                this._buffer = this._buffer.subarray(this._literalRemaining);
                this._literalRemaining = 0;
            }

            const idx = this._buffer.indexOf('\r\n');
            if (idx < 0) {
                return;
            }

            const line = this._buffer.subarray(0, idx + 2);
            this._buffer = this._buffer.subarray(idx + 2);
            this._current.push(line);

            const literal = line.toString('latin1').match(/~?\{(\d+)\}\r\n$/);
            if (literal && line[0] !== 0x2b /* + */) {
                this._literalRemaining = Number(literal[1]);
                continue;
            }

            const response = Buffer.concat(this._current);
            this._current = [];
            this.responses.push(response.subarray(0, response.length - 2));
            if (this._compressTag && response.toString('latin1').startsWith(this._compressTag + ' ')) {
                this._compressTag = null;
                if (/^\S+ OK/i.test(response.toString('latin1'))) {
                    this._startCompression();
                }
            }
            if (this.openTag && response.toString('latin1').startsWith(this.openTag + ' ')) {
                this.openTag = null;
            }
            this.emit('response', response);
        }
    }

    /**
     * Resolves to true when a response matching the predicate arrives, or false on timeout or close
     */
    waitFor(predicate: (response: string) => boolean, timeout: number): Promise<boolean> {
        return new Promise(resolve => {
            const done = (result: boolean) => {
                clearTimeout(timer);
                this.removeListener('response', onResponse);
                this.removeListener('close', onClose);
                resolve(result);
            };
            const onResponse = (response: Buffer) => {
                if (predicate(response.toString('latin1'))) {
                    done(true);
                }
            };
            const onClose = () => done(false);
            const timer = setTimeout(() => done(false), timeout);
            this.on('response', onResponse);
            this.once('close', onClose);
        });
    }

    /**
     * Sends a command, waiting for continuations before synchronizing literals.
     * Without a tag (a raw line such as DONE) it waits for the command left open
     * by a continuation, if any. Resolves to a note string when the exchange did
     * not complete normally.
     */
    async send(payload: Buffer, tag: string | null, timeout: number): Promise<string | null> {
        tag = tag || this.openTag;
        if (!tag) {
            if (!this.closed) {
                this._write(payload);
            }
            return this.closed ? 'connection closed' : null;
        }
        // a Buffer payload gives Buffer chunks
        const chunks = splitAtLiterals(payload) as Buffer[];

        for (let i = 0; i < chunks.length; i++) {
            if (this.closed) {
                return 'connection closed';
            }
            const last = i === chunks.length - 1;
            let continued = false;
            const wait = this.waitFor(str => {
                continued = str.startsWith('+');
                return continued || str.startsWith(tag + ' ');
            }, timeout);
            if (/^\S+ COMPRESS DEFLATE\r\n$/i.test(String(chunks[i]))) {
                this._compressTag = tag;
            }
            this._write(chunks[i]!);
            const found = await wait;

            if (!found) {
                return this.closed ? 'connection closed' : `no response within ${timeout}ms`;
            }
            if (!continued && !last) {
                // the server answered with a tagged response instead of accepting the literal
                return 'literal rejected';
            }
            if (last) {
                this.openTag = continued ? tag : null;
            }
        }
        return null;
    }

    _write(data: Buffer) {
        if (this.layer) {
            this.layer.write(Buffer.from(data));
        } else {
            this.socket!.write(data);
        }
    }

    // everything after the CRLF of the tagged OK is compressed in both directions (RFC 4978 section 3)
    _startCompression() {
        const rest = this._buffer;
        this._buffer = Buffer.alloc(0);
        this.layer = new DeflateLayer({
            writeRaw: (chunk: Buffer | string) => this.socket!.write(chunk),
            onData: (chunk: Buffer) => this._onData(chunk),
            onError: () => this.socket!.destroy()
        });
        if (rest.length) {
            this.layer.receive(rest);
        }
    }

    close() {
        if (this.layer) {
            this.layer.destroy();
        }
        if (this.socket) {
            this.socket.destroy();
        }
    }
}

/**
 * Reads ImapKit storage and returns the folders and messages to seed Dovecot with,
 * as processed by ImapKit itself (uids, internaldates, flags)
 *
 * @param {Object} storage ImapKit storage object (not modified)
 * @return {Object} { folders: [{path, subscribed, messages}], warnings: [] }
 */
function collectSeed(storage: Storage): Seed {
    const server = imapkit({ storage: structuredClone(storage) });
    const warnings: string[] = [];
    const folders: SeedFolder[] = [];

    Object.keys(server.folderCache as Record<string, Mailbox>)
        .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
        .forEach(folderPath => {
            const mailbox: Mailbox = server.folderCache[folderPath];
            const namespace: StorageNamespace = server.storage[mailbox.namespace];
            if (mailbox.namespace !== 'INBOX' && (namespace.type !== 'personal' || namespace.separator !== '/')) {
                warnings.push(`Skipping "${folderPath}": only personal namespaces with "/" as separator are seeded to Dovecot`);
                return;
            }
            if (mailbox.flags.includes('\\Noselect')) {
                // Dovecot creates \Noselect parents itself when a child is created
                return;
            }
            folders.push({
                path: folderPath,
                subscribed: mailbox.subscribed,
                messages: mailbox.messages.map((message: Message) => ({
                    uid: message.uid,
                    raw: message.raw,
                    internaldate: message.internaldate,
                    flags: message.flags.filter(flag => flag.toLowerCase() !== '\\recent')
                }))
            });
        });

    return { folders, warnings };
}

const quote = (str: string | number) => '"' + String(str).replace(/(["\\])/g, '\\$1') + '"';

/**
 * Sends a tagged command and returns its tagged response, throwing unless it is OK
 *
 * @param {Session} session Session to use
 * @param {String} tag Command tag
 * @param {String} text Command without the tag
 * @param {Number} timeout Milliseconds to wait for the response
 * @param {Buffer} [literal] Appended as a non-synchronizing literal
 * @return {String} tagged response
 */
async function runCommand(session: Session, tag: string, text: string, timeout: number, literal?: Buffer): Promise<string> {
    const payload = literal
        ? Buffer.concat([Buffer.from(`${tag} ${text} {${literal.length}+}\r\n`), literal, Buffer.from('\r\n')])
        : Buffer.from(`${tag} ${text}\r\n`);
    const start = session.responses.length;
    const note = await session.send(payload, tag, timeout);
    const tagged = session.responses
        .slice(start)
        .map(response => response.toString('latin1'))
        .find(response => response.startsWith(tag + ' '));
    if (note || !/^\S+ OK/i.test(tagged || '')) {
        throw new Error(`"${text}" failed: ${note || tagged || 'no tagged response'}`);
    }
    return tagged!;
}

/**
 * Creates the folders and messages of the seed in a fresh Dovecot account
 */
async function seedDovecot(session: Session, seed: Seed, timeout: number): Promise<string[]> {
    const warnings: string[] = [];
    let counter = 0;

    const run = (text: string, literal?: Buffer) =>
        runCommand(session, 'S' + ++counter, text, timeout, literal).catch(err => {
            throw new Error(`Seeding Dovecot failed: ${err.message}`, { cause: err });
        });

    for (const folder of seed.folders) {
        if (folder.path.toUpperCase() !== 'INBOX') {
            await run(`CREATE ${quote(folder.path)}`);
        }
        if (folder.subscribed) {
            await run(`SUBSCRIBE ${quote(folder.path)}`);
        }
        for (const message of folder.messages) {
            const tagged = await run(
                `APPEND ${quote(folder.path)} (${message.flags.join(' ')}) ${quote(message.internaldate)}`,
                // ImapKit keeps message sources as binary strings, one char per octet
                Buffer.from(message.raw, 'binary')
            );
            const appendUid = tagged.match(/\[APPENDUID \d+ (\d+)\]/i);
            if (appendUid && Number(appendUid[1]) !== message.uid) {
                warnings.push(`${folder.path}: imapkit UID ${message.uid} is UID ${appendUid[1]} in Dovecot`);
            }
        }
    }

    return warnings;
}

/**
 * Runs all steps against one server
 *
 * @param {Object} target { name, host, port, user, pass, seed (optional async function) }
 * @param {Array} steps Parsed scenario
 * @param {Object} options { timeout, settle, manualLogin, baseDir }
 * @return {Object} { setup: [responses], steps: [{ responses: {session: [Buffer]}, notes: [] }], warnings }
 */
async function runTarget(target: Target, steps: Step[], options: RunOptions): Promise<TargetResult> {
    const sessions = new Map<number, Session>();
    const setup: TargetResult['setup'] = [];
    let warnings: string[] = [];

    const connect = async (login: boolean) => {
        const session = new Session();
        await session.connect(target.host, target.port, options.timeout);
        if (login) {
            await runCommand(session, 'L1', `LOGIN ${quote(target.user)} ${quote(target.pass)}`, options.timeout).catch(err => {
                session.close();
                throw new Error(`${target.name}: login failed: ${err.message}`, { cause: err });
            });
        }
        return session;
    };

    const open = async (id: number) => {
        const session = await connect(!options.manualLogin);
        setup.push(...session.responses.map(response => ({ session: id, response })));
        session.mark = session.responses.length;
        sessions.set(id, session);
        return session;
    };

    const collect = () => {
        const result: StepResponses = {};
        for (const [id, session] of sessions) {
            const fresh = session.responses.slice(session.mark);
            session.mark = session.responses.length;
            for (const response of fresh) {
                const match = response.toString('latin1').match(/\[UIDVALIDITY (\d+)\]/i);
                if (match) {
                    target.uidvalidity = match[1];
                }
            }
            if (fresh.length) {
                result[id] = fresh;
            }
        }
        return result;
    };

    try {
        if (target.seed) {
            const seeder = await connect(true);
            try {
                warnings = await target.seed(seeder);
            } finally {
                seeder.close();
            }
        }

        const results: StepResult[] = [];
        for (const step of steps) {
            const notes: string[] = [];
            if (step.type === 'wait') {
                await new Promise(resolve => setTimeout(resolve, step.ms));
            } else {
                const session = sessions.get(step.session) || (await open(step.session));
                const payload = buildPayload(step.text, target, options.baseDir);
                const note = await session.send(payload, step.tag, options.timeout);
                if (note) {
                    notes.push(note);
                }
            }
            // let unsolicited responses (other sessions, IDLE updates) arrive
            await new Promise(resolve => setTimeout(resolve, options.settle));
            results.push({ responses: collect(), notes });
        }

        return { setup, steps: results, warnings };
    } finally {
        for (const session of sessions.values()) {
            session.close();
        }
    }
}

/**
 * Starts an in-process ImapKit server for the comparison
 */
function startImapKit(storage: Storage, plugins: string[]): Promise<IMAPServer> {
    return new Promise((resolve, reject) => {
        const server = imapkit({ storage: structuredClone(storage), plugins });
        server.server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

const COLORS = { red: 31, green: 32, yellow: 33, cyan: 36, dim: 2, bold: 1 };

const display = (response: Buffer) => response.toString('utf8').replace(/\r\n/g, '\n');

function sessionLines(responses: StepResponses, multi: boolean): string[] {
    const lines: string[] = [];
    Object.keys(responses).forEach(id => {
        responses[Number(id)]!.forEach(response => {
            display(response)
                .split('\n')
                .forEach(line => lines.push((multi ? `[${id}] ` : '') + line));
        });
    });
    return lines;
}

/**
 * Checks whether two targets produced equivalent results for a step
 *
 * @param {Object} a Step result ({ responses, notes }) of one target
 * @param {Object} b Step result of the other target
 * @param {Object} [options] Same as for normalizeResponse
 * @return {Boolean} true if the normalized responses and notes match
 */
function sameStep(a: StepResult, b: StepResult, options?: NormalizeOptions): boolean {
    const normalize = (step: StepResult) =>
        JSON.stringify([Object.keys(step.responses).map(id => [id, normalizeResponses(step.responses[Number(id)]!, options)]), step.notes]);
    return normalize(a) === normalize(b);
}

async function main() {
    const { values: argv, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            command: { type: 'string', short: 'c', multiple: true },
            storage: { type: 'string' },
            plugin: { type: 'string', multiple: true },
            target: { type: 'string', default: 'both' },
            'manual-login': { type: 'boolean', default: false },
            'keep-text': { type: 'boolean', default: false },
            exact: { type: 'boolean', default: false },
            timeout: { type: 'string', default: '3000' },
            settle: { type: 'string', default: '100' },
            verbose: { type: 'boolean', short: 'v', default: false },
            json: { type: 'boolean', default: false },
            help: { type: 'boolean', short: 'h', default: false }
        }
    });

    if (argv.help || (!positionals.length && !argv.command)) {
        console.log(`Usage: node --import tsx compare/compare.ts [options] [scenario-file]

Replays IMAP commands against imapkit and Dovecot (start it with
"npm run dovecot:start") and shows where the responses differ.

  -c, --command <cmd>   command to run (repeatable), instead of a scenario file
  --storage <file>      imapkit storage JSON, also seeded into Dovecot
                        (default compare/storage.json)
  --plugin <names>      imapkit plugins, comma separated (repeatable)
  --target <name>       both (default), imapkit or dovecot
  --manual-login        do not log in automatically; use $USER and $PASS
  --keep-text           also compare the human readable text of OK/NO/BAD
  --exact               do not sort LIST responses and flag lists or unquote
                        mailbox names before comparing
  --timeout <ms>        wait this long for a tagged response (default 3000)
  --settle <ms>         wait this long after each step for extra output (default 100)
  -v, --verbose         also show greetings, login and seeding notes
  --json                print machine readable results

Scenario syntax: see the comment on parseScenario() in compare/compare.js.`);
        return;
    }

    const scenarioFile = positionals[0];
    const scenario = scenarioFile ? fs.readFileSync(scenarioFile, 'utf8') : argv.command!.join('\n');
    const steps = parseScenario(scenario);
    const storage = JSON.parse(fs.readFileSync(argv.storage || DEFAULT_STORAGE, 'utf8'));
    const plugins = (argv.plugin || [])
        .flatMap(value => value.split(','))
        .map(value => value.trim().toUpperCase())
        .filter(Boolean);
    const options: RunOptions = {
        timeout: Number(argv.timeout),
        settle: Number(argv.settle),
        manualLogin: argv['manual-login'],
        baseDir: scenarioFile ? path.dirname(path.resolve(scenarioFile)) : process.cwd()
    };

    // each runner runs the scenario against one server and returns its results
    const runners: Record<string, () => Promise<TargetResult>> = {
        imapkit: async () => {
            const server = await startImapKit(storage, plugins);
            try {
                return await runTarget(
                    { name: 'imapkit', host: '127.0.0.1', port: (server.address() as AddressInfo).port, user: IMAPKIT_USER, pass: IMAPKIT_PASS },
                    steps,
                    options
                );
            } finally {
                server.close();
            }
        },
        dovecot: async () => {
            const seed = collectSeed(storage);
            const target: Target = {
                name: 'dovecot',
                host: process.env.IMAPKIT_DOVECOT_HOST || '127.0.0.1',
                port: Number(process.env.IMAPKIT_DOVECOT_PORT) || 32143,
                user: `compare-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                pass: DOVECOT_PASS,
                seed: async (session: Session) => seed.warnings.concat(await seedDovecot(session, seed, options.timeout))
            };
            return runTarget(target, steps, options).catch(err => {
                if (err.code === 'ECONNREFUSED') {
                    throw new Error(`Dovecot is not reachable on ${target.host}:${target.port}, start it with "npm run dovecot:start"`, { cause: err });
                }
                throw err;
            });
        }
    };

    const targetNames = argv.target === 'both' ? Object.keys(runners) : [argv.target];
    if (!targetNames.every(name => runners[name])) {
        throw new Error(`Unknown target "${argv.target}"`);
    }
    const both = targetNames.length === 2;

    // the targets share nothing, so run them at the same time
    const results: Record<string, TargetResult> = Object.fromEntries(await Promise.all(targetNames.map(async name => [name, await runners[name]!()])));

    const multi = steps.some(step => step.session !== 1);
    const compareOptions = { keepText: argv['keep-text'], exact: argv.exact };

    if (argv.json) {
        const toLines = (responses: StepResponses) => sessionLines(responses, true);
        console.log(
            JSON.stringify(
                {
                    warnings: Object.fromEntries(targetNames.map(name => [name, results[name].warnings])),
                    steps: steps.map((step, i) => ({
                        line: step.line,
                        session: step.session,
                        send: step.text || `!wait ${step.ms}`,
                        same: both ? sameStep(results.imapkit.steps[i], results.dovecot.steps[i], compareOptions) : null,
                        results: Object.fromEntries(
                            targetNames.map(name => [name, { responses: toLines(results[name].steps[i].responses), notes: results[name].steps[i].notes }])
                        )
                    }))
                },
                null,
                2
            )
        );
        return;
    }

    const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
    const c = (color: keyof typeof COLORS, str: string) => (useColor ? `\x1b[${COLORS[color]}m${str}\x1b[0m` : str);
    let differences = 0;

    targetNames.forEach(name => {
        results[name].warnings.forEach(warning => console.log(c('yellow', `warning (${name}): ${warning}`)));
        if (argv.verbose) {
            console.log(c('dim', `--- ${name} setup`));
            results[name].setup.forEach(({ session, response }) => console.log(c('dim', `  [${session}] ${display(response)}`)));
        }
    });

    steps.forEach((step, i) => {
        const label = step.type === 'wait' ? `!wait ${step.ms}` : (multi ? `[${step.session}] ` : '') + (step.type === 'raw' ? '> ' : '') + step.text;
        console.log(c('bold', c('cyan', label)));

        const printTarget = (name: string, dim?: boolean) => {
            const { responses, notes } = results[name]!.steps[i]!;
            sessionLines(responses, multi).forEach(line => console.log(dim ? c('dim', '    ' + line) : '    ' + line));
            notes.forEach(note => console.log(c(dim ? 'dim' : 'yellow', `    (${note})`)));
        };

        if (!both) {
            printTarget(targetNames[0]);
            return;
        }

        if (sameStep(results.imapkit.steps[i], results.dovecot.steps[i], compareOptions)) {
            console.log(c('green', '  = same') + c('dim', ' (after normalizing, imapkit output shown)'));
            printTarget('imapkit', true);
            return;
        }
        differences++;
        console.log(c('red', '  imapkit:'));
        printTarget('imapkit');
        console.log(c('red', '  dovecot:'));
        printTarget('dovecot');
    });

    if (both) {
        console.log(differences ? c('red', `\n${differences} of ${steps.length} steps differ`) : c('green', `\nAll ${steps.length} steps match`));
    }
}

// run as a script (`npm run compare`), not when the tests import it
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    main().catch(err => {
        console.error(err.message);
        process.exitCode = 1;
    });
}

export { parseScenario, buildPayload, splitAtLiterals, normalizeResponse, normalizeResponses, sameStep, collectSeed, runTarget, startImapKit, sessionLines };
