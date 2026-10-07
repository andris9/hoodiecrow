'use strict';

module.exports = function (connection, parsed, data, callback) {
    return copyMessages(connection, parsed, data, callback, false);
};

/**
 * Shared implementation of COPY and UID COPY
 *
 * @param {Boolean} isUid If true, the sequence set holds UID values
 */
function copyMessages(connection, parsed, data, callback, isUid) {
    const command = isUid ? 'UID COPY' : 'COPY';

    if (
        !parsed.attributes ||
        parsed.attributes.length !== 2 ||
        !parsed.attributes[0] ||
        ['ATOM', 'SEQUENCE'].indexOf(parsed.attributes[0].type) < 0 ||
        !parsed.attributes[1] ||
        ['ATOM', 'STRING', 'LITERAL'].indexOf(parsed.attributes[1].type) < 0
    ) {
        connection.send(
            {
                tag: parsed.tag,
                command: 'BAD',
                attributes: [
                    {
                        type: 'TEXT',
                        value: command + ' expects sequence set and a mailbox name'
                    }
                ]
            },
            'INVALID COMMAND',
            parsed,
            data
        );
        return callback();
    }

    const result = copyToMailbox(connection, parsed, data, isUid, command + ' FAIL');
    if (!result) {
        return callback();
    }

    // the result is the extra context info for UIDPLUS
    connection.send(
        {
            tag: parsed.tag,
            command: 'OK',
            attributes: [
                {
                    type: 'TEXT',
                    value: command + ' Completed'
                }
            ]
        },
        command,
        parsed,
        data,
        result
    );
    callback();
}

/**
 * Copies messages from the selected mailbox to another one, the copy step of COPY and MOVE.
 * Sends a tagged NO and returns false if the target mailbox can not be used.
 *
 * @param {Object} connection IMAP connection
 * @param {Object} parsed Parsed command, with the sequence set and the mailbox name as arguments
 * @param {String} data Raw command
 * @param {Boolean} isUid If true, the sequence set holds UID values
 * @param {String} failDescription Description for the failure response
 * @param {Boolean} [isMove] If true, the messages are moved, the caller expunges them afterwards
 * @return {Object|false} `{ mailbox, sourceUids, targetUids, messages }`, where messages lists the copied source messages
 */
function copyToMailbox(connection, parsed, data, isUid, failDescription, isMove) {
    const range = connection.limitRange(parsed, connection.getMessageRange(parsed.attributes[0].value, isUid));
    if (!isUid) {
        connection.checkSequenceNumbers(parsed.attributes[0].value);
    }
    const mailbox = connection.getTargetMailbox(parsed.attributes[1].value, parsed, data, failDescription);
    if (!mailbox) {
        return false;
    }

    // messages already expunged by another session are skipped
    const messages = range.map(rangeMessage => rangeMessage[1]).filter(message => !message.ghost);

    if (!connection.checkAppend(mailbox, messages, parsed, data, failDescription, { move: !!isMove, source: connection.selectedMailbox })) {
        return false;
    }

    const sourceUids = [];
    const targetUids = [];
    // a range that is processed from the highest UID down (parsed.highestFirst) is still copied in UID order,
    // so the new UIDs follow the order of the source UIDs (RFC 9738 section 3.1 MOVE example)
    (parsed.highestFirst ? messages.slice().reverse() : messages).forEach(message => {
        sourceUids.push(message.uid);
        targetUids.push(connection.server.copyMessage(mailbox, message).message.uid);
    });

    return {
        mailbox,
        sourceUids,
        targetUids,
        messages
    };
}

module.exports.copyMessages = copyMessages;
module.exports.copyToMailbox = copyToMailbox;
