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
                value: "UID COPY expects sequence set and a mailbox name"
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
        }, "UID COPY FAILED", parsed, data);
        return callback();
    }

    var sequence = parsed.attributes[0].value,
        path = parsed.attributes[1].value,
        mailbox = connection.server.getMailbox(path),
        range = connection.server.getMessageRange(connection.selectedMailbox, sequence, true);

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

    range.forEach(function(rangeMessage) {
        var message = rangeMessage[1],
            flags = [].concat(message.flags || []),
            internaldate = message.internaldate;

        connection.server.appendMessage(mailbox, flags, internaldate, message.raw, connection);
    });

    connection.send({
        tag: parsed.tag,
        command: "OK",
        attributes: [{
            type: "TEXT",
            value: "UID COPY Completed"
        }]
    }, "UID COPY", parsed, data);
    callback();
};