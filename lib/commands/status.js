"use strict";

module.exports = function(connection, parsed, data, callback) {

    if (!parsed.attributes ||
        parsed.attributes.length !== 2 ||
        !parsed.attributes[0] ||
        ["STRING", "LITERAL", "ATOM"].indexOf(parsed.attributes[0].type) < 0 ||
        !Array.isArray(parsed.attributes[1]) ||
        !parsed.attributes[1].length
    ) {

        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "STATUS expects mailbox argument and a list of status items"
            }]
        }, "INVALID COMMAND", parsed, data);
        return callback();
    }

    if (["Authenticated", "Selected"].indexOf(connection.state) < 0) {
        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "Log in first"
            }]
        }, "STATUS FAILED", parsed, data);
        return callback();
    }

    var path = parsed.attributes[0].value,
        mailbox = connection.server.getMailbox(path),
        status, response = [],
        item;

    if (!mailbox || mailbox.flags.indexOf("\\Noselect") >= 0) {
        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "Invalid mailbox name"
            }]
        }, "STATUS FAILED", parsed, data);
        return callback();
    }

    status = connection.server.getStatus(mailbox);

    for (var i = 0, len = parsed.attributes[1].length; i < len; i++) {
        item = parsed.attributes[1][i];
        if (!item || item.type !== "ATOM" || connection.server.allowedStatus.indexOf(item.value.toUpperCase()) < 0) {
            connection.send({
                tag: parsed.tag,
                command: "BAD",
                attributes: [{
                    type: "TEXT",
                    value: "Invalid status element (" + (i + 1) + ")"
                }]
            }, "STATUS FAILED", parsed, data);
            return callback();
        }

        response.push({
            type: "ATOM",
            value: item.value.toUpperCase()
        });
        switch (item.value.toUpperCase()) {
            case "MESSAGES":
                response.push(mailbox.messages.length);
                break;
            case "RECENT":
                response.push(status.flags["\\Recent"] || 0);
                break;
            case "UIDNEXT":
                response.push(mailbox.uidnext);
                break;
            case "UIDVALIDITY":
                response.push(mailbox.uidvalidity);
                break;
            case "UNSEEN":
                response.push(status.unseen || 0);
                break;
            default:
                response.push(mailbox[item.value.toUpperCase()]);
                break;
        }
    }

    connection.send({
        tag: "*",
        command: "STATUS",
        attributes: [{
                type: "ATOM",
                value: path
            },
            response
        ]
    }, "STATUS", parsed, data);

    connection.send({
        tag: parsed.tag,
        command: "OK",
        attributes: [{
            type: "TEXT",
            value: "Status completed"
        }]
    }, "STATUS", parsed, data);
    return callback();
};