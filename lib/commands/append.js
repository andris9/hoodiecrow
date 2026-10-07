'use strict';

const { normalizeSystemFlag, checkSystemFlags } = require('./handlers/flags');

/**
 * Creates an error that refuses an APPEND like command
 *
 * @param {String} text Human readable text
 * @param {String} [code] Response code, e.g. "TOOBIG"
 * @param {Array} [codeArgs] Arguments of the response code, as response attributes
 * @param {String} [response] "NO" (default) or "BAD"
 * @return {Error} Error object
 */
function appendError(text, code, codeArgs, response) {
    const err = new Error(text);
    err.imapResponse = response || 'NO';
    err.responseCode = code || false;
    err.responseCodeArgs = codeArgs || [];
    return err;
}

const badArgument = text => appendError(text, false, false, 'BAD');

/**
 * Parses a flag list, flags are atoms, and \Recent or unknown system flags can not be set (RFC 3501 section 9)
 *
 * @param {Object} connection IMAPConnection
 * @param {Array} list Parsed flag list
 * @return {Array} Flags
 */
function parseFlags(connection, list) {
    try {
        return list.map(flag => {
            if (!flag || flag.type !== 'ATOM') {
                throw new Error('Invalid flags argument');
            }
            const value = normalizeSystemFlag(flag.value);
            checkSystemFlags(connection, value);
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
 * @return {Array} Messages `{ flags, internaldate, raw, resolve }`, resolve builds the message source
 *   of an append-data extension. Throws a BAD error if the arguments break the grammar
 */
function parseMessages(connection, args, maxMessages) {
    const server = connection.server;
    const messages = [];

    for (let i = 0; i < args.length;) {
        const message = { flags: [], internaldate: false, raw: false };

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
function sendAppendError(connection, parsed, data, err, description) {
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
function prepareAppend(connection, parsed, data, pathArg, args, options) {
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
            }
        });

        // checkAppend sends the NO response itself
        if (!connection.checkAppend(mailbox, messages, parsed, data, description, { command: options.command, replaced: options.replaced })) {
            return false;
        }

        return { mailbox, messages };
    } catch (err) {
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
function storeMessages(connection, prepared) {
    const messages = prepared.messages.map(
        message => connection.server.appendMessage(prepared.mailbox, message.flags, message.internaldate, message.raw).message
    );
    return { mailbox: prepared.mailbox, message: messages[messages.length - 1], messages };
}

module.exports = function (connection, parsed, data, callback) {
    const args = [].concat(parsed.attributes || []);

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
};

module.exports.appendError = appendError;
module.exports.badArgument = badArgument;
module.exports.prepareAppend = prepareAppend;
module.exports.storeMessages = storeMessages;
