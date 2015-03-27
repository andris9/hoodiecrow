"use strict";

/**
 * @help Disables LOGIN support for unencrypted connections
 */

module.exports = function(server) {

    server.registerCapability("LOGINDISABLED", function(connection) {
        return !connection.secureConnection && connection.state === "Not Authenticated";
    });

    // Retrieve actual LOGIN handler
    // Will be run if conditions are met
    var oldHandler = server.getCommandHandler("LOGIN");

    // Override LOGIN
    server.setCommandHandler("LOGIN", function(connection, parsed, data, callback) {
        // If the connection is unsecure, do not allow LOGIN
        if (!connection.secureConnection) {
            connection.send({
                tag: parsed.tag,
                command: "BAD",
                attributes: [{
                    type: "TEXT",
                    value: "Run STARTTLS first"
                }]
            }, "INVALID COMMAND", parsed, data);
            return callback();
        }

        // Reroute command to actual LOGIN handler
        oldHandler(connection, parsed, data, callback);
    });
};