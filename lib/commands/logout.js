"use strict";

module.exports = function(connection, parsed, data, callback) {

    if (parsed.attributes) {
        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "LOGOUT does not take any arguments"
            }]
        }, "INVALID COMMAND", parsed, data);
        return callback();
    }

    connection.state = "Logout";

    connection.send({
        tag: "*",
        command: "BYE",
        attributes: [{
            type: "TEXT",
            value: "LOGOUT received"
        }]
    }, "LOGOUT UNTAGGED", parsed, data);

    connection.send({
        tag: parsed.tag,
        command: "OK",
        attributes: [{
            type: "TEXT",
            value: "Completed"
        }]
    }, "LOGOUT COMPLETED", parsed, data);

    connection.socket.end();

    callback();
};