import imapHandler from 'imap-handler';
import { normalizeSystemFlag, checkSystemFlags } from './handlers/flags.js';
import { restoreNilAtoms, isAstring } from '../arguments.js';
import type { ArgumentPath } from '../arguments.js';
import type { AppendMessage, Attribute, Callback, IMAPConnection, IMAPError, Mailbox, Message, ParsedCommand, Refusal } from '../types.js';

/** A message of an APPEND like command, ready to be stored */
export interface PreparedMessage extends AppendMessage {
    flags: string[];
    internaldate: string | false;
    raw: string;
    /** builds the message source of an append-data extension */
    resolve?: (() => string) | undefined;
    /** the message was sent as a literal8 */
    literal8?: boolean | undefined;
}

/** A parsed message of an APPEND like command, `raw` is false until `resolve` builds it */
interface ParsedMessage {
    flags: string[];
    internaldate: string | false;
    raw: string | false;
    resolve?: (() => string) | undefined;
    literal8?: boolean | undefined;
}

/** The result of prepareAppend() */
export interface PreparedAppend {
    mailbox: Mailbox;
    messages: PreparedMessage[];
}

/** Options of prepareAppend() */
export interface PrepareAppendOptions {
    command: string;
    maxMessages?: number | undefined;
    replaced?: Message | null | undefined;
}

/**
 * Creates an error that refuses an APPEND like command
 *
 * @param {String} text Human readable text
 * @param {String} [code] Response code, e.g. "TOOBIG"
 * @param {Array} [codeArgs] Arguments of the response code, as response attributes
 * @param {String} [response] "NO" (default) or "BAD"
 * @return {Error} Error object
 */
function appendError(text: string, code?: string | false, codeArgs?: Attribute[] | false, response?: string): IMAPError {
    const err: IMAPError = new Error(text);
    err.imapResponse = response || 'NO';
    err.responseCode = code || false;
    err.responseCodeArgs = codeArgs || [];
    return err;
}

const badArgument = (text: string) => appendError(text, false, false, 'BAD');

/**
 * Parses a flag list, flags are atoms, and \Recent or unknown system flags can not be set (RFC 3501 section 9)
 *
 * @param {Object} connection IMAPConnection
 * @param {Array} list Parsed flag list
 * @return {Array} Flags
 */
function parseFlags(connection: IMAPConnection, list: Attribute[]): string[] {
    try {
        return list.map(flag => {
            if (!flag || flag.type !== 'ATOM') {
                throw new Error('Invalid flags argument');
            }
            const value = normalizeSystemFlag(flag.value);
            checkSystemFlags(connection.server, value);
            return value;
        });
    } catch {
        throw badArgument('Invalid flags argument');
    }
}

/**
 * Parses the messages of an APPEND like command. RFC 3502 and RFC 4466 section 3:
 * append-message = [SP flag-list] [SP date-time] SP append-data, where append-data is a literal
 * or an extension (label SP value) from `server.appendDataHandlers`, e.g. CATENATE (RFC 4469)
 *
 * @param {Object} connection IMAPConnection
 * @param {Array} args Parsed arguments after the mailbox name
 * @param {Number} maxMessages Largest number of messages allowed
 * @return {Array} Messages `{ flags, internaldate, raw, resolve, literal8 }`, resolve builds the message source
 *   of an append-data extension. Throws a BAD error if the arguments break the grammar
 */
function parseMessages(connection: IMAPConnection, args: Attribute[], maxMessages: number): ParsedMessage[] {
    const server = connection.server;
    const messages: ParsedMessage[] = [];

    for (let i = 0; i < args.length;) {
        const message: ParsedMessage = { flags: [], internaldate: false, raw: false };

        if (Array.isArray(args[i])) {
            message.flags = parseFlags(connection, args[i++]);
        }

        // date-time is always a quoted string, a literal here is the message
        if (args[i] && args[i].type === 'STRING') {
            if (!server.validateInternalDate(args[i].value)) {
                throw badArgument('Invalid internaldate argument');
            }
            message.internaldate = args[i++].value;
        }

        const appendData = args[i++];
        const label = appendData && appendData.type === 'ATOM' ? String(appendData.value).toUpperCase() : '';
        if (appendData && appendData.type === 'LITERAL') {
            message.raw = appendData.value;
        } else if (appendData && appendData.type === 'LITERAL8' && server.appendLiteral8) {
            // RFC 3516 section 4.4: the message as a literal8, server.appendLiteral8 (BINARY) stores it
            message.raw = appendData.value;
            message.literal8 = true;
        } else if (label && Object.hasOwn(server.appendDataHandlers, label) && i < args.length) {
            message.resolve = server.appendDataHandlers[label](connection, args[i++]);
        } else {
            throw badArgument('Invalid message source argument');
        }

        messages.push(message);
    }

    if (!messages.length) {
        throw badArgument('Missing message argument');
    }

    if (messages.length > maxMessages) {
        // only a single message unless MULTIAPPEND is supported (RFC 4466 section 3)
        throw badArgument('Only a single message can be appended');
    }

    return messages;
}

/**
 * Sends the response for an error from appendError()
 *
 * @param {Object} connection IMAPConnection
 * @param {Object} parsed Parsed command
 * @param {String} data Raw command
 * @param {Error} err Error object
 * @param {String} description Description of a NO response
 */
function sendAppendError(connection: IMAPConnection, parsed: ParsedCommand, data: string, err: IMAPError, description: string) {
    const attributes = [];
    if (err.responseCode) {
        attributes.push({
            type: 'SECTION',
            section: [{ type: 'ATOM', value: err.responseCode }].concat(err.responseCodeArgs)
        });
    }
    attributes.push({ type: 'TEXT', value: err.message });

    connection.send(
        {
            tag: parsed.tag,
            command: err.imapResponse,
            attributes
        },
        err.imapResponse === 'BAD' ? 'INVALID COMMAND' : description,
        parsed,
        data
    );
}

/**
 * Finds the target mailbox name of an APPEND or REPLACE command when a literal of a message (or of a CATENATE TEXT
 * part) is announced. Only the start of the command up to the mailbox argument is parsed, so the data of earlier
 * literals is not parsed again for every message of a MULTIAPPEND
 *
 * @param {Object} connection IMAPConnection
 * @param {String} command Upper case command name
 * @param {String} line Command received so far, up to the literal size marker
 * @return {String|Boolean} storage name of the mailbox, or false if the literal is not a message or the name is not
 *   known yet or not valid
 */
function getPendingTarget(connection: IMAPConnection, command: string, line: string): string | false {
    const options = connection.server.getCommandOptions(command);
    if (!options.appendMessage) {
        return false;
    }
    const mailboxPosition = options.mailboxArguments[0];

    // the literal of a CATENATE URL is not a message part
    if (/[ (]URL $/i.test(line.slice(-5))) {
        return false;
    }

    // an open CATENATE list is closed for parsing
    const parse = (text: string) => {
        text = text.replace(/ $/, '');
        for (const suffix of ['', ')']) {
            try {
                const parsed = imapHandler.parser(text + suffix);
                restoreNilAtoms(parsed, text, (path: ArgumentPath) => path.length === 1 && path[0] === mailboxPosition);
                return parsed.attributes || [];
            } catch {
                // try the next suffix
            }
        }
        return [];
    };

    // the command up to the first literal, or up to the end of it when that literal is the mailbox name
    const literal = line.match(/(~?)\{(\d+)\+?\}\r\n/);
    let attributes = parse(literal ? line.substr(0, literal.index) : line);
    if (attributes.length <= mailboxPosition && literal && !literal[1]) {
        attributes = parse(line.substr(0, literal.index! + literal[0].length + Number(literal[2])));
    }
    // a literal8 can not be a mailbox name, the command handler refuses it
    const pathArg = attributes[mailboxPosition];
    if (!isAstring(pathArg)) {
        return false;
    }
    try {
        return connection.importMailboxName((pathArg as Attribute).value);
    } catch {
        // the command handler refuses the name
        return false;
    }
}

/**
 * A literal filter (`server.literalFilters`) that refuses the message of an APPEND or REPLACE to a mailbox that does
 * not exist before the client sends it, by not sending a continuation request (RFC 3502 section 6.3.11 example A004,
 * RFC 3501 section 6.3.11: TRYCREATE). Not while earlier commands are still waiting, these could create the mailbox
 *
 * @param {Object} connection IMAPConnection
 * @param {String} command Upper case command name
 * @param {String} line Command received so far, up to the literal size marker
 * @return {Object|Boolean} `{ command, code, text }` to refuse the literal, or false
 */
function refuseMissingTarget(connection: IMAPConnection, command: string, line: string): Refusal | false {
    const path = !connection.isBusy() && getPendingTarget(connection, command, line);
    return path !== false && connection.server.targetRefusal(path);
}

/**
 * Prepares the messages of an APPEND like command (APPEND, REPLACE): parses the arguments, checks
 * the target mailbox, builds the message sources and runs `server.appendChecks` through
 * IMAPConnection#checkAppend. Nothing is stored yet, so a failure leaves every mailbox as it was
 * (RFC 3502 section 6.3.11). The error response is sent here.
 *
 * The checks get the built messages (with `raw`) of the whole command and the options as
 * `{ command, replaced }`, `replaced` is the message that REPLACE removes.
 *
 * @param {Object} connection IMAPConnection
 * @param {Object} parsed Parsed command
 * @param {String} data Raw command
 * @param {Object} pathArg Parsed mailbox name argument
 * @param {Array} args Parsed arguments after the mailbox name
 * @param {Object} options `{ command, maxMessages, replaced }`
 * @return {Object|Boolean} `{ mailbox, messages }` or false if an error response was sent
 */
function prepareAppend(
    connection: IMAPConnection,
    parsed: ParsedCommand,
    data: string,
    pathArg: Attribute,
    args: Attribute[],
    options: PrepareAppendOptions
): PreparedAppend | false {
    const description = options.command + ' FAILED';
    const maxMessages = options.maxMessages || (connection.server.multiAppend ? Infinity : 1);
    try {
        if (!pathArg || ['STRING', 'ATOM', 'LITERAL'].indexOf(pathArg.type) < 0) {
            throw badArgument('Invalid mailbox argument');
        }
        const messages = parseMessages(connection, args, maxMessages);

        // getTargetMailbox sends the NO response itself
        const mailbox = connection.getTargetMailbox(pathArg.value, parsed, data, description);
        if (!mailbox) {
            return false;
        }

        messages.forEach(message => {
            if (message.resolve) {
                message.raw = message.resolve();
            } else if (message.literal8) {
                // literal8 is only set when server.appendLiteral8 exists, and then raw holds the literal
                message.raw = connection.server.appendLiteral8!(message.raw as string);
            }
        });
        // every message source is built now
        const prepared = messages as PreparedMessage[];

        // checkAppend sends the NO response itself
        if (!connection.checkAppend(mailbox, prepared, parsed, data, description, { command: options.command, replaced: options.replaced })) {
            return false;
        }

        return { mailbox, messages: prepared };
    } catch (error) {
        const err = error as IMAPError;
        if (!err.imapResponse) {
            throw err;
        }
        sendAppendError(connection, parsed, data, err, description);
        return false;
    }
}

/**
 * Stores prepared messages. The sessions that have the target mailbox selected get EXISTS updates
 *
 * @param {Object} connection IMAPConnection
 * @param {Object} prepared Result of prepareAppend()
 * @return {Object} `{ mailbox, message, messages }`, message is the last stored message
 */
function storeMessages(connection: IMAPConnection, prepared: PreparedAppend): { mailbox: Mailbox; message: Message | undefined; messages: Message[] } {
    const messages = prepared.messages.map(
        message => connection.server.appendMessage(prepared.mailbox, message.flags, message.internaldate, message.raw).message
    );
    return { mailbox: prepared.mailbox, message: messages[messages.length - 1], messages };
}

export default function appendCommand(connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) {
    const args = ([] as Attribute[]).concat(parsed.attributes || []);

    const prepared = prepareAppend(connection, parsed, data, args.shift(), args, { command: 'APPEND' });
    if (!prepared) {
        return callback();
    }

    const appendResult = storeMessages(connection, prepared);

    connection.send(
        {
            tag: parsed.tag,
            command: 'OK',
            attributes: [
                {
                    type: 'TEXT',
                    value: 'APPEND Completed'
                }
            ]
        },
        'APPEND',
        parsed,
        data,
        appendResult
    );
    callback();
}

export { appendError, badArgument, prepareAppend, storeMessages, getPendingTarget, refuseMissingTarget };
