import { prepareAppend, storeMessages } from '../commands/append.js';
import { states } from '../command-states.js';
import { isNzNumber } from '../numbers.js';
import type { Attribute, Callback, IMAPConnection, IMAPServer, Mailbox, Message, ParsedCommand, Refusal } from '../types.js';

// RFC 8508 section 5 and RFC 3501 section 9: seq-number = nz-number / "*"
const isSeqNumber = (value: any) => value === '*' || isNzNumber(value);

/**
 * @help Adds REPLACE [RFC8508] capability (REPLACE and UID REPLACE commands)
 *
 * REPLACE: https://www.rfc-editor.org/rfc/rfc8508
 *
 * Additional commands:
 * - REPLACE
 * - UID REPLACE
 *
 * The new message is appended and the old one expunged as a single action. With UIDPLUS the
 * APPENDUID response code is sent in an untagged OK before the EXPUNGE. Works with CATENATE.
 */
export default function replacePlugin(server: IMAPServer) {
    server.registerCapability('REPLACE');

    const replaceHandler = function (uidMode: boolean, connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) {
        const command = uidMode ? 'UID REPLACE' : 'REPLACE';
        const args: Attribute[] = ([] as Attribute[]).concat(parsed.attributes || []);
        const id = args.shift();
        const pathArg = args.shift();

        // RFC 8508 section 5: replace = "REPLACE" SP seq-number SP mailbox append-message
        if (!id || ['ATOM', 'SEQUENCE'].indexOf(id.type) < 0 || !isSeqNumber(String(id.value))) {
            connection.sendStatus(parsed, data, 'BAD', command + ' expects a message number, a mailbox name and a message', false, 'INVALID COMMAND');
            return callback();
        }

        const found = findMessage(connection, uidMode, id.value);
        if (found.error) {
            connection.sendStatus(
                parsed,
                data,
                found.error.command,
                found.error.text,
                found.error.code || false,
                found.error.command === 'BAD' ? 'INVALID COMMAND' : command + ' FAILED'
            );
            return callback();
        }
        const message = found.message;

        // RFC 8508 section 4.7: REPLACE takes a single message even with MULTIAPPEND. Nothing is
        // changed if the new message can not be appended (section 3.4)
        const prepared = prepareAppend(connection, parsed, data, pathArg, args, { command, maxMessages: 1, replaced: message });
        if (!prepared) {
            return callback();
        }

        const result = storeMessages(connection, prepared);

        // Hook for UIDPLUS to send APPENDUID in an untagged OK before the EXPUNGE
        // (RFC 8508 section 4.3). If UIDPLUS is not loaded, this is not sent
        connection.send(
            {
                tag: '*',
                command: 'OK',
                attributes: [
                    {
                        type: 'TEXT',
                        value: 'Replacement message saved'
                    }
                ],
                skipResponse: true
            },
            'REPLACE APPENDUID',
            parsed,
            data,
            result
        );

        // only the replaced message is expunged, not every \Deleted message (RFC 8508 section 3.4).
        // When the new message went to the selected mailbox, it was already announced with EXISTS
        connection.expungeSpecificMessages(connection.selectedMailbox as Mailbox, [message], false, true);

        connection.sendStatus(parsed, data, 'OK', command + ' completed', false, command);
        callback();
    };

    // Refuse the literal of the new message when the message to replace is already known to be
    // invalid, unless earlier commands are still running and could change the selected mailbox
    server.literalFilters.push((connection: IMAPConnection, command: string, line: string) => {
        if ((command !== 'REPLACE' && command !== 'UID REPLACE') || connection.isBusy()) {
            return false;
        }
        const match = line.match(/^\S+ (?:UID )?REPLACE ([^ ]+) /i);
        return (match && isSeqNumber(match[1]) && findMessage(connection, command === 'UID REPLACE', match[1]).error) || false;
    });

    // RFC 8508 section 3.5: valid only in the selected state, the second argument is the target mailbox
    // the message can be a literal8 with BINARY: RFC 8508 section 6 uses append-message, whose append-data
    // is a literal8 too (RFC 4466 section 2.7)
    // REPLACE takes a message sequence number, UID REPLACE a UID
    const options = { states: states.SELECTED, mailboxArguments: [1], literal8: 'BINARY', appendMessage: true };
    server.setCommandHandler('REPLACE', replaceHandler.bind(null, false), Object.assign({ sequenceSet: 0 }, options));
    server.setCommandHandler('UID REPLACE', replaceHandler.bind(null, true), options);
}

/**
 * Finds the message to replace in the selected mailbox
 *
 * @param {Object} connection IMAPConnection
 * @param {Boolean} uidMode If true, the value is a UID, otherwise a sequence number
 * @param {String} value seq-number, a number or "*"
 * @return {Object} `{ message }`, or `{ error: { command, text } }` if there is no such message
 */
function findMessage(
    connection: IMAPConnection,
    uidMode: boolean,
    value: any
): { message: Message; error?: undefined } | { message?: undefined; error: Refusal } {
    // sequence numbers refer to the message list this session knows about
    const messages = connection.getSessionMessages();
    let message: Message | undefined;
    if (uidMode) {
        // "*" is the UID of the last message (RFC 3501 section 9, seq-number)
        const uid = value === '*' ? (messages.length ? messages[messages.length - 1].uid : 0) : Number(value);
        message = messages.find((item: Message) => item.uid === uid);
    } else {
        const seq = value === '*' ? messages.length : Number(value);
        // RFC 3501 section 9, seq-number: a sequence number greater than the number of messages
        // (or "*" in an empty mailbox) gets a tagged BAD
        if (!seq || seq > messages.length) {
            return { error: { command: 'BAD', text: 'Invalid message sequence number' } };
        }
        message = messages[seq - 1];
    }

    // RFC 8508 section 3.2: NO - can't remove specified message
    if (!message || message.ghost) {
        return { error: { command: 'NO', text: 'No such message' } };
    }

    // the old message is expunged, which is not allowed after EXAMINE
    const readOnly = connection.readOnlyRefusal();
    if (readOnly) {
        return { error: readOnly };
    }

    return { message };
}
