"use strict";

module.exports = function(connection, parsed, data, callback) {

    if (!parsed.attributes ||
        parsed.attributes.length !== 1 ||
        !parsed.attributes[0] ||
        ["STRING", "LITERAL", "ATOM"].indexOf(parsed.attributes[0].type) < 0
    ) {

        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "SELECT expects 1 mailbox argument"
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
        }, "SELECT FAILED", parsed, data);
        return callback();
    }

    var path = parsed.attributes[0].value,
        mailbox = connection.server.getMailbox(path);

    if (!mailbox || mailbox.flags.indexOf("\\Noselect") >= 0) {
        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "Invalid mailbox name"
            }]
        }, "SELECT FAILED", parsed, data);
        return callback();
    }

    connection.state = "Selected";
    connection.selectedMailbox = mailbox;
    connection.readOnly = false;

    connection.notificationQueue = [];

    var status = connection.server.getStatus(mailbox),
        permanentFlags = status.permanentFlags.map(function(flag) {
            return {
                type: "ATOM",
                value: flag
            };
        });

    connection.send({
        tag: "*",
        command: "FLAGS",
        attributes: [permanentFlags]
    }, "SELECT FLAGS", parsed, data);

    if (mailbox.allowPermanentFlags) {
        permanentFlags.push({
            type: "TEXT",
            value: "\\*"
        });
    }

    connection.send({
        tag: "*",
        command: "OK",
        attributes: [{
            type: "SECTION",
            section: [{
                    type: "ATOM",
                    value: "PERMANENTFLAGS"
                },
                permanentFlags
            ]
        }]
    }, "SELECT PERMANENTFLAGS", parsed, data);

    connection.send({
        tag: "*",
        attributes: [
            mailbox.messages.length, {
                type: "ATOM",
                value: "EXISTS"
            }
        ]
    }, "SELECT EXISTS", parsed, data);

    connection.send({
        tag: "*",
        attributes: [
            status.flags["\\Recent"] || 0, {
                type: "ATOM",
                value: "RECENT"
            }
        ]
    }, "SELECT RECENT", parsed, data);

    connection.send({
        tag: "*",
        command: "OK",
        attributes: [{
            type: "SECTION",
            section: [{
                    type: "ATOM",
                    value: "UIDVALIDITY"
                },
                mailbox.uidvalidity
            ]
        }]
    }, "SELECT UIDVALIDITY", parsed, data);

    connection.send({
        tag: "*",
        command: "OK",
        attributes: [{
            type: "SECTION",
            section: [{
                    type: "ATOM",
                    value: "UIDNEXT"
                },
                mailbox.uidnext
            ]
        }]
    }, "SELECT UIDNEXT", parsed, data);

    connection.send({
        tag: parsed.tag,
        command: "OK",
        attributes: [{
            type: "SECTION",
            section: [{
                type: "ATOM",
                value: "READ-WRITE"
            }]
        }, {
            type: "TEXT",
            value: "Completed"
        }]
    }, "SELECT", parsed, data);
    return callback();
};