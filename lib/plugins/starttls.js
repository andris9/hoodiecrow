"use strict";

/**
 * @help Adds STARTTLS command
 */

module.exports = function(server) {
    // Register capability, usable with unsecure connection
    server.registerCapability("STARTTLS", function(connection) {
        return !connection.secureConnection;
    });

    // Add STARTTLS command
    server.setCommandHandler("STARTTLS", function(connection, parsed, data, callback) {

        // does not take any arguments
        if (parsed.attributes) {
            return sendError("STARTTLS does not take any arguments", connection, parsed, data, callback);
        }

        // only works in insecure setting
        if (connection.secureConnection) {
            return sendError("Connection is already secured", connection, parsed, data, callback);
        }

        connection.send({
            tag: parsed.tag,
            command: "OK",
            attributes: [{
                type: "TEXT",
                value: "Server ready to start TLS negotiation"
            }]
        }, "STARTTLS INIT", parsed, data);

        connection.upgradeConnection(callback);
    });
};

function sendError(message, connection, parsed, data, callback) {
    connection.send({
        tag: parsed.tag,
        command: "BAD",
        attributes: [{
            type: "TEXT",
            value: message
        }]
    }, "INVALID COMMAND", parsed, data);
    return callback();
}