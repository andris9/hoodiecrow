"use strict";

/**
 * @help Enables SPECIAL-USE [RFC6154] capability
 * @help Mailboxes need to have a "special-use"
 * @help property (String or Array) that will be used
 * @help as extra flag for LIST and LSUB responses
 */

module.exports = function(server) {
    // Register capability
    server.registerCapability("SPECIAL-USE");

    var listHandler = server.getCommandHandler("LIST");

    server.setCommandHandler("LIST", function(connection, parsed, data, callback) {
        var i;
        if (parsed.attributes && Array.isArray(parsed.attributes[0])) {
            for (i = parsed.attributes[0].length - 1; i >= 0; i--) {
                if (parsed.attributes[0][i] && parsed.attributes[0][i].type === "ATOM" &&
                    parsed.attributes[0][i].value.toUpperCase() === "SPECIAL-USE") {

                    parsed.attributes[0].splice(i, 1);
                    parsed.listSpecialUseOnly = true;
                }
            }
            // remove parameter if no other memebers were left
            if (!parsed.attributes[0].length) {
                parsed.attributes.splice(0, 1);
            }
        }

        if (parsed.attributes && parsed.attributes[2] &&
            parsed.attributes[2].type === "ATOM" &&
            parsed.attributes[2].value.toUpperCase() === "RETURN" &&
            Array.isArray(parsed.attributes[3])) {

            for (i = parsed.attributes[3].length - 1; i >= 0; i--) {
                if (parsed.attributes[3][i] && parsed.attributes[3][i].type === "ATOM" &&
                    parsed.attributes[3][i].value.toUpperCase() === "SPECIAL-USE") {

                    parsed.attributes[3].splice(i, 1);
                    parsed.listSpecialUseFlags = true;
                }
            }

            // Remove RETURN (List) if no members were left
            if (!parsed.attributes[3].length) {
                parsed.attributes.splice(2, 2);
            }
        }

        listHandler(connection, parsed, data, callback);
    });

    server.outputHandlers.push(function(connection, response, description, parsed, data, folder) {
        var specialUseList = [].concat(folder && folder["special-use"] || []).map(function(specialUse) {
            return {
                type: "ATOM",
                value: specialUse
            };
        });

        if (
            (description === "LIST ITEM" || description === "LSUB ITEM") &&
            folder &&
            response.attributes &&
            Array.isArray(response.attributes[0])) {

            if (folder["special-use"] && specialUseList.length) {
                if (parsed.listSpecialUseFlags) {
                    // Show only special use flag
                    response.attributes[0] = specialUseList;
                } else {
                    response.attributes[0] = response.attributes[0].concat(specialUseList);
                }
            } else {
                if (parsed.listSpecialUseFlags) {
                    // No flags to display
                    response.attributes[0] = [];
                }
                if (parsed.listSpecialUseOnly) {
                    // Do not show this response
                    response.skipResponse = true;
                }
            }
        }
    });
};