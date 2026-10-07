'use strict';

// X-GM-MSGID is a 64 bit unsigned number, so it is tracked as a BigInt

// Sample value from Gmail IMAP extensions API page
// https://developers.google.com/workspace/gmail/imap/imap-extensions
// Used as default, if server.options["HIGHESTX-GM-MSGID"]
// is missing
const SEED = '1278455344230334865';

/**
 * @help Adds Gmail specific X-GM-EXT-1 capability
 * @help Status:
 * @help   X-GM-RAW command is not going to be supported
 * @help   X-GM-MSGID is OK
 * @help   X-GM-LABELS is partially supported. You can fetch
 * @help       and store labels but they do not have any
 * @help       required side effects (the message does not
 * @help       get copied to or removed from another mailbox)
 * @help   X-GM-THRID is the X-GM-MSGID of the message unless storage
 * @help       sets an X-GM-THRID value, so every message is its own
 * @help       thread unless the fixture groups messages
 */

module.exports = function (server) {
    server.registerCapability('X-GM-EXT-1');

    server['HIGHESTX-GM-MSGID'] = BigInt(server.options['HIGHESTX-GM-MSGID'] || SEED);

    // set X-GM-MSGID values when message is created / initialized
    server.messageHandlers.push((connection, message, mailbox) => {
        let labels;

        if (!message['X-GM-MSGID']) {
            server['HIGHESTX-GM-MSGID'] += 1n;
            message['X-GM-MSGID'] = server['HIGHESTX-GM-MSGID'].toString();
        } else if (/^\d+$/.test(message['X-GM-MSGID']) && BigInt(message['X-GM-MSGID']) > server['HIGHESTX-GM-MSGID']) {
            // Storage might be shared with another server instance, do not reuse existing values
            server['HIGHESTX-GM-MSGID'] = BigInt(message['X-GM-MSGID']);
        }

        // A message starts its own thread unless storage puts it into one
        if (!message['X-GM-THRID']) {
            message['X-GM-THRID'] = message['X-GM-MSGID'];
        }

        // Ensure message has an array of labels
        message['X-GM-LABELS'] = [].concat(message['X-GM-LABELS'] || []);

        if (mailbox.path.toUpperCase() === 'INBOX') {
            labels = ['\\Inbox'];
        } else if (mailbox['special-use'] && mailbox['special-use'].length) {
            labels = [].concat(mailbox['special-use']);
        } else {
            labels = [mailbox.path];
        }

        labels.forEach(label => {
            server.ensureFlag(message['X-GM-LABELS'], label);
        });
    });

    // Retrieve X-GM-MSGID values with FETCH
    server.fetchHandlers['X-GM-MSGID'] = function (connection, message) {
        return {
            type: 'ATOM',
            value: message['X-GM-MSGID']
        };
    };

    // Retrieve X-GM-LABELS values with FETCH
    server.fetchHandlers['X-GM-LABELS'] = function (connection, message) {
        return message['X-GM-LABELS'].map(label => {
            return {
                type: 'ATOM',
                value: label
            };
        });
    };

    server.searchHandlers['X-GM-MSGID'] = function (connection, message, sequence, xGmMsgid) {
        return message['X-GM-MSGID'] === xGmMsgid;
    };

    // Retrieve X-GM-THRID values with FETCH
    server.fetchHandlers['X-GM-THRID'] = function (connection, message) {
        return {
            type: 'ATOM',
            value: message['X-GM-THRID']
        };
    };

    server.searchHandlers['X-GM-THRID'] = function (connection, message, sequence, xGmThrid) {
        return message['X-GM-THRID'] === xGmThrid;
    };

    const setLabels = (message, flags) => {
        message['X-GM-LABELS'] = [];
        addLabels(message, flags);
    };

    const addLabels = (message, flags) => {
        flags.forEach(flag => {
            flag = ((flag && flag.value) || flag).toString();
            server.ensureFlag(message['X-GM-LABELS'], flag);
        });
    };

    const removeLabels = (message, flags) => {
        flags.forEach(flag => {
            flag = ((flag && flag.value) || flag).toString();
            server.removeFlag(message['X-GM-LABELS'], flag);
        });
    };

    [
        ['X-GM-LABELS', setLabels],
        ['+X-GM-LABELS', addLabels],
        ['-X-GM-LABELS', removeLabels]
    ].forEach(([name, update]) => {
        server.storeHandlers[name] = function (connection, message, flags, index, parsed, data) {
            update(message, flags);
            sendLabelUpdate(connection, parsed, data, index, message);
        };

        server.storeHandlers[name + '.SILENT'] = function (connection, message, flags) {
            update(message, flags);
        };
    });

    // Gmail keeps the same X-GM-MSGID for a message in every mailbox, so copies get the value of the source message
    server.outputHandlers.push((connection, response, description, parsed, data, extra) => {
        if (
            !extra ||
            !extra.mailbox ||
            !Array.isArray(extra.mailbox.messages) ||
            !Array.isArray(extra.sourceUids) ||
            !Array.isArray(extra.targetUids) ||
            !connection.selectedMailbox
        ) {
            return;
        }

        extra.sourceUids.forEach((sourceUid, i) => {
            const source = connection.selectedMailbox.messages.find(message => message.uid === sourceUid);
            const target = extra.mailbox.messages.find(message => message.uid === extra.targetUids[i]);
            if (source && target && source['X-GM-MSGID']) {
                target['X-GM-MSGID'] = source['X-GM-MSGID'];
                target['X-GM-THRID'] = source['X-GM-THRID'];
            }
        });
    });
};

function sendLabelUpdate(connection, parsed, data, index, message) {
    const resp = [
        {
            type: 'ATOM',
            value: 'X-GM-LABELS'
        },
        message['X-GM-LABELS'].map(label => {
            return {
                type: 'ATOM',
                value: label
            };
        })
    ];

    if ((parsed.command || '').toUpperCase() === 'UID STORE') {
        resp.push({
            type: 'ATOM',
            value: 'UID'
        });
        resp.push(message.uid);
    }

    connection.send(
        {
            tag: '*',
            attributes: [
                index,
                {
                    type: 'ATOM',
                    value: 'FETCH'
                },
                resp
            ]
        },
        'FLAG UPDATE',
        parsed,
        data,
        message
    );
}
