"use strict";

module.exports = function(connection, parsed, data, callback) {
    if (parsed.attributes) {
        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "CAPABILITY does not take any arguments"
            }]
        }, "INVALID COMMAND", parsed, data);
        return callback();
    }

    var capabilities = ["IMAP4rev1"];

    Object.keys(connection.server.capabilities).forEach(function(key) {
        if (connection.server.capabilities[key](connection)) {
            capabilities.push(key);
        }
    });

    connection.send({
        tag: "*",
        command: "CAPABILITY",
        attributes: capabilities.map(function(capability) {
            return {
                type: "TEXT",
                value: capability
            };
        })
    }, "CAPABILITY LIST", parsed, data, capabilities);

    connection.send({
        tag: parsed.tag,
        command: "OK",
        attributes: [{
            type: "TEXT",
            value: "Completed"
        }]
    }, "CAPABILITY COMPLETED", parsed, data, capabilities);

    callback();
};