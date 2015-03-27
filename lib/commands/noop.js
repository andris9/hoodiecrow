"use strict";

module.exports = function(connection, parsed, data, callback) {
    if (parsed.attributes) {
        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "NOOP does not take any arguments"
            }]
        }, "INVALID COMMAND", parsed, data);
        return callback();
    }

    connection.send({
        tag: parsed.tag,
        command: "OK",
        attributes: [{
            type: "TEXT",
            value: "Completed"
        }]
    }, "NOOP completed", parsed, data);

    callback();
};