"use strict";

/**
 * @help Enables CREATE-SPECIAL-USE [RFC6154] capability
 * @help Allowed special flags can be set with server
 * @help option "special-use"
 */

module.exports = function(server) {
    // Register capability
    server.registerCapability("CREATE-SPECIAL-USE");

    var createHandler = server.getCommandHandler("CREATE"),
        allowedList = [].concat(server.options["special-use"] || [
            "\\Archive", "\\Drafts", "\\Flagged", "\\Junk", "\\Sent", "\\Trash"
        ]);

    server.setCommandHandler("CREATE", function(connection, parsed, data, callback) {
        var i, len, specialUseList, mailboxSpecialUse = [];
        if (parsed.attributes && Array.isArray(parsed.attributes[1])) {
            for (i = 0; i < parsed.attributes[1].length; i += 2) {
                if (parsed.attributes[1][i] && parsed.attributes[1][i].type === "ATOM" &&
                    parsed.attributes[1][i].value.toUpperCase() === "USE" &&
                    Array.isArray(parsed.attributes[1][i + 1])) {

                    specialUseList = parsed.attributes[1][i + 1];
                    parsed.attributes[1].splice(i, 2);
                    i -= 2;
                }
            }

            // Remove extra arguments if no members were left
            if (!parsed.attributes[1].length) {
                parsed.attributes.splice(1, 1);
            }
        }

        if (specialUseList) {
            for (i = 0, len = specialUseList.length; i < len; i++) {
                if (["ATOM", "STRING", "LITERAL"].indexOf(specialUseList[i].type) < 0) {
                    connection.send({
                        tag: parsed.tag,
                        command: "BAD",
                        attributes: [{
                            type: "TEXT",
                            value: "Invalid syntax for special use flag #" + (i + 1)
                        }]
                    }, "CREATE-SPECIAL-USE FAILED", parsed, data);
                    return callback();
                }
                if (allowedList.indexOf(specialUseList[i].value) < 0) {
                    connection.send({
                        tag: parsed.tag,
                        command: "NO",
                        attributes: [{
                            type: "SECTION",
                            section: [{
                                type: "ATOM",
                                value: "USEATTR"
                            }]
                        }, {
                            type: "TEXT",
                            value: specialUseList[i].value + " not supported"
                        }]
                    }, "CREATE-SPECIAL-USE FAILED", parsed, data);
                    return callback();
                }
                if (mailboxSpecialUse.indexOf(specialUseList[i].value) < 0) {
                    mailboxSpecialUse.push(specialUseList[i].value);
                }
            }
        }

        if (mailboxSpecialUse) {
            parsed.mailboxSpecialUse = mailboxSpecialUse;
        }

        createHandler(connection, parsed, data, callback);
    });

    server.outputHandlers.push(function(connection, response, description, parsed, data, folder) {
        if (description === "CREATE" && folder && parsed.mailboxSpecialUse) {
            folder["special-use"] = parsed.mailboxSpecialUse;
        }
    });
};