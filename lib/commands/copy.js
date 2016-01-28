"use strict";

module.exports = function(connection, parsed, data, callback) {

    if (!parsed.attributes ||
        parsed.attributes.length !== 2 ||
        !parsed.attributes[0] ||
        ["ATOM", "SEQUENCE"].indexOf(parsed.attributes[0].type) < 0 ||
        !parsed.attributes[1] ||
        ["ATOM", "STRING"].indexOf(parsed.attributes[1].type) < 0
    ) {

        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "COPY expects sequence set and a mailbox name"
            }]
        }, "INVALID COMMAND", parsed, data);
        return callback();
    }

    if (["Selected"].indexOf(connection.state) < 0) {
        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "Select mailbox first"
            }]
        }, "COPY FAILED", parsed, data);
        return callback();
    }

    var sequence = parsed.attributes[0].value,
        path = parsed.attributes[1].value,
        mailbox = connection.server.getMailbox(path),
        range = connection.server.getMessageRange(connection.selectedMailbox, sequence, false);

    if (!mailbox) {
        connection.send({
            tag: parsed.tag,
            command: "NO",
            attributes: [{
                type: "TEXT",
                value: "Target mailbox does not exist"
            }]
        }, "COPY FAIL", parsed, data);
        return callback();
    }

    var sourceUids = [],
        targetUids = [];
    range.forEach(function(rangeMessage) {
        var message = rangeMessage[1],
            flags = [].concat(message.flags || []),
            internaldate = message.internaldate;
        sourceUids.push(message.uid);

        var appendResult = connection.server.appendMessage(mailbox, flags, internaldate, message.raw, connection);
        targetUids.push(appendResult.message.uid);
    });

    // Create extra context info for UIDPLUS
    var extra = {
      mailbox: mailbox,
      sourceUids: sourceUids,
      targetUids: targetUids
    };

    connection.send({
        tag: parsed.tag,
        command: "OK",
        attributes: [{
            type: "TEXT",
            value: "COPY Completed"
        }]
    }, "COPY", parsed, data, extra);
    callback();
};
