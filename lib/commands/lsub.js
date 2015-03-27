"use strict";

module.exports = function(connection, parsed, data, callback) {

    if (!parsed.attributes ||
        parsed.attributes.length !== 2 ||
        !parsed.attributes[0] ||
        ["STRING", "LITERAL", "ATOM"].indexOf(parsed.attributes[0].type) < 0 ||
        !parsed.attributes[1] ||
        ["STRING", "LITERAL", "ATOM"].indexOf(parsed.attributes[1].type) < 0
    ) {

        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "LSUB expects 2 string arguments"
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
        }, "LSUB FAILED", parsed, data);
        return callback();
    }

    var folders = connection.server.matchFolders(parsed.attributes[0].value, parsed.attributes[1].value);

    folders.forEach(function(folder) {
        if (folder.subscribed) {
            connection.send({
                tag: "*",
                command: "LSUB",
                attributes: [
                    folder.flags.map(function(flag) {
                        return {
                            type: "ATOM",
                            value: flag
                        };
                    }),
                    connection.server.storage[folder.namespace].separator,
                    folder.path
                ]
            }, "LSUB ITEM", parsed, data, folder);
        }
    });

    connection.send({
        tag: parsed.tag,
        command: "OK",
        attributes: [{
            type: "TEXT",
            value: "Completed"
        }]
    }, "LSUB", parsed, data);

    return callback();
};