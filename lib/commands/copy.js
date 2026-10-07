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

    if (['Selected'].indexOf(connection.state) < 0) {
        connection.send(
            {
                tag: parsed.tag,
                command: 'BAD',
                attributes: [
                    {
                        type: 'TEXT',
                        value: 'Select mailbox first'
                    }
                ]
            },
            command + ' FAILED',
            parsed,
            data
        );
        return callback();
    }

    const sequence = parsed.attributes[0].value;
    const path = parsed.attributes[1].value;
    const mailbox = connection.server.getMailbox(path);
    const range = connection.server.getMessageRange(connection.getSessionMessages(), sequence, isUid);

    if (!mailbox || mailbox.flags.indexOf('\\Noselect') >= 0) {
        connection.send(
            {
                tag: parsed.tag,
                command: 'NO',
                attributes: [].concat(
                    // TRYCREATE tells the client that CREATE would help (RFC 3501 section 6.4.7)
                    !mailbox
                        ? {
                              type: 'SECTION',
                              section: [
                                  {
                                      type: 'ATOM',
                                      value: 'TRYCREATE'
                                  }
                              ]
                          }
                        : [],
                    {
                        type: 'TEXT',
                        value: mailbox ? 'Target mailbox is not selectable' : 'Target mailbox does not exist'
                    }
                )
            },
            command + ' FAIL',
            parsed,
            data
        );
        return callback();
    }

    const sourceUids = [];
    const targetUids = [];
    range.forEach(rangeMessage => {
        const message = rangeMessage[1];
        if (message.ghost) {
            // already expunged by another session
            return;
        }
        const flags = [].concat(message.flags || []);
        const internaldate = message.internaldate;
        sourceUids.push(message.uid);

        const appendResult = connection.server.appendMessage(mailbox, flags, internaldate, message.raw);
        targetUids.push(appendResult.message.uid);
    });

    // Create extra context info for UIDPLUS
    const extra = {
        mailbox: mailbox,
        sourceUids: sourceUids,
        targetUids: targetUids
    };

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
        extra
    );
    callback();
}

module.exports.copyMessages = copyMessages;
