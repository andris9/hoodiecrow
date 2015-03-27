"use strict";

/**
 * @help Adds ID [RFC2971] capability
 */

module.exports = function(server) {

    // Register capability, always usable
    server.registerCapability("ID");

    // Add ID command
    server.setCommandHandler("ID", function(connection, parsed, data, callback) {
        var clientList = {},
            serverList = null,
            list, i, len, key;

        // Require exactly 1 attribute (NIL or parameter list)
        if (!parsed.attributes || parsed.attributes.length !== 1) {
            return sendError("ID expects 1 attribute", connection, parsed, data, callback);
        }
        list = parsed.attributes[0];
        if (list && !Array.isArray(list) || (list && list.length % 2)) {
            return sendError("ID expects valid parameter list", connection, parsed, data, callback);
        }

        // Build client ID object and check validity of the values
        if (list && list.length) {
            for (i = 0, len = list.length; i < len; i++) {
                if (i % 2 === 0) {
                    // Handle keys (always strings)
                    if (list[i] && ["STRING", "LITERAL"].indexOf(list[i].type) >= 0) {
                        key = list[i].value;
                    } else {
                        return sendError("ID expects valid parameter list", connection, parsed, data, callback);
                    }
                } else {
                    // Handle values (string or NIL)
                    if (!list[i] || ["STRING", "LITERAL"].indexOf(list[i].type) >= 0) {
                        clientList[key] = list[i] && list[i].value || null;
                    } else {
                        return sendError("ID expects valid parameter list", connection, parsed, data, callback);
                    }
                }
            }
        }

        // Build response object from server options
        if (server.options.id) {
            serverList = [];
            Object.keys(server.options.id).forEach(function(key) {
                serverList.push({
                    type: "STRING",
                    value: key
                });
                serverList.push({
                    type: "STRING",
                    value: (server.options.id[key] || "").toString()
                });
            });
        }

        // Send untagged ID response
        connection.send({
            tag: "*",
            command: "ID",
            attributes: [
                serverList
            ]
        }, "ID", parsed, data, clientList);

        // Send tagged response
        connection.send({
            tag: parsed.tag,
            command: "OK",
            attributes: [{
                type: "TEXT",
                value: "ID command completed"
            }]
        }, "ID", parsed, data, clientList);

        callback();
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