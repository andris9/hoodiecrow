"use strict";

/**
 * @help Adds UNSELECT [RFC3691] capability
 */

module.exports = function(server) {

    server.registerCapability("UNSELECT");

    server.setCommandHandler("UNSELECT", function(connection, parsed, data, callback) {
        if (parsed.attributes) {
            connection.send({
                tag: parsed.tag,
                command: "BAD",
                attributes: [{
                    type: "TEXT",
                    value: "UNSELECT does not take any arguments"
                }]
            }, "INVALID COMMAND", parsed, data);
            return callback();
        }

        if (connection.state !== "Selected") {
            connection.send({
                tag: parsed.tag,
                command: "BAD",
                attributes: [{
                    type: "TEXT",
                    value: "Select a mailbox first"
                }]
            }, "UNSELECT FAILED", parsed, data);
            return callback();
        }

        connection.send({
            tag: parsed.tag,
            command: "OK",
            attributes: [{
                type: "TEXT",
                value: "Mailbox closed"
            }]
        }, "CLOSE", parsed, data);

        connection.state = "Authenticated";

        connection.selectedMailbox = false;
        return callback();
    });
};