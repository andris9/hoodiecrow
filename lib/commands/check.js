"use strict";

module.exports = function(connection, parsed, data, callback) {
    if (parsed.attributes) {
        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "CHECK does not take any arguments"
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
    }, "CHECK completed", parsed, data);

    callback();
};