"use strict";

/**
 * @help Partially implemented CONDSTORE [RFC4551] support
 */

module.exports = function(server) {

    // Register capability, always usable
    server.registerCapability("CONDSTORE");
    if (Array.isArray(server.enableAvailable)) {
        server.enableAvailable.push("CONDSTORE");
    }

    // set modseq values when message is created / initialized
    server.messageHandlers.push(function(connection, message, mailbox) {
        if (!message.MODSEQ) {
            mailbox.HIGHESTMODSEQ = (mailbox.HIGHESTMODSEQ || 0) + 1;
            message.MODSEQ = mailbox.HIGHESTMODSEQ;
        }
    });

    server.allowedStatus.push("HIGHESTMODSEQ");

    // Override SELECT and EXAMINE to add
    var selectHandler = server.getCommandHandler("SELECT"),
        examineHandler = server.getCommandHandler("EXAMINE"),
        closeHandler = server.getCommandHandler("CLOSE"),
        fetchHandler = server.getCommandHandler("FETCH"),
        uidFetchHandler = server.getCommandHandler("UID FETCH"),
        storeHandler = server.getCommandHandler("STORE"),
        uidStoreHandler = server.getCommandHandler("UID STORE"),

        condstoreHandler = function(prevHandler, connection, parsed, data, callback) {
            if (hasCondstoreOption(parsed.attributes && parsed.attributes[1], parsed.attributes, 1)) {
                connection.sessionCondstore = true;
            } else if ("sessionCondstore" in connection) {
                connection.sessionCondstore = false;
            }
            prevHandler(connection, parsed, data, callback);
        };

    server.setCommandHandler("SELECT", function(connection, parsed, data, callback) {
        condstoreHandler(selectHandler, connection, parsed, data, callback);
    });

    server.setCommandHandler("EXAMINE", function(connection, parsed, data, callback) {
        condstoreHandler(examineHandler, connection, parsed, data, callback);
    });

    server.setCommandHandler("CLOSE", function(connection, parsed, data, callback) {
        if ("sessionCondstore" in connection) {
            connection.sessionCondstore = false;
        }
        closeHandler(connection, parsed, data, callback);
    });

    server.setCommandHandler("FETCH", function(connection, parsed, data, callback) {
        var changedsince = getCondstoreValue(parsed.attributes && parsed.attributes[2], "CHANGEDSINCE", parsed.attributes, 2);

        if (changedsince) {
            if (["ATOM", "STRING"].indexOf(changedsince.type) < 0 ||
                !changedsince.value.length ||
                isNaN(changedsince.value) ||
                Number(changedsince.value) < 0) {

                connection.send({
                    tag: parsed.tag,
                    command: "BAD",
                    attributes: [{
                        type: "TEXT",
                        value: "Invalid syntax for CHANGEDSINCE, number expected"
                    }]
                }, "CONDSTORE FAILED", parsed, data);
                return callback();
            }
            parsed.changedsince = Number(changedsince.value);
        }

        fetchHandler(connection, parsed, data, callback);
    });

    server.setCommandHandler("UID FETCH", function(connection, parsed, data, callback) {
        var changedsince = getCondstoreValue(parsed.attributes && parsed.attributes[2], "CHANGEDSINCE", parsed.attributes, 2);

        if (changedsince) {
            if (["ATOM", "STRING"].indexOf(changedsince.type) < 0 ||
                !changedsince.value.length ||
                isNaN(changedsince.value) ||
                Number(changedsince.value) < 0) {

                connection.send({
                    tag: parsed.tag,
                    command: "BAD",
                    attributes: [{
                        type: "TEXT",
                        value: "Invalid syntax for CHANGEDSINCE, number expected"
                    }]
                }, "CONDSTORE FAILED", parsed, data);
                return callback();
            }
            parsed.changedsince = Number(changedsince.value);
        }

        uidFetchHandler(connection, parsed, data, callback);
    });

    server.setCommandHandler("STORE", function(connection, parsed, data, callback) {
        var unchangedsince = getCondstoreValue(parsed.attributes && parsed.attributes[1], "UNCHANGEDSINCE", parsed.attributes, 1);

        if (unchangedsince) {
            if (["ATOM", "STRING"].indexOf(unchangedsince.type) < 0 ||
                !unchangedsince.value.length ||
                isNaN(unchangedsince.value) ||
                Number(unchangedsince.value) < 0) {

                connection.send({
                    tag: parsed.tag,
                    command: "BAD",
                    attributes: [{
                        type: "TEXT",
                        value: "Invalid syntax for UNCHANGEDSINCE, number expected"
                    }]
                }, "CONDSTORE FAILED", parsed, data);
                return callback();
            }
            parsed.unchangedsince = Number(unchangedsince.value);
        }

        storeHandler(connection, parsed, data, callback);
    });

    server.setCommandHandler("UID STORE", function(connection, parsed, data, callback) {
        var unchangedsince = getCondstoreValue(parsed.attributes && parsed.attributes[1], "UNCHANGEDSINCE", parsed.attributes, 1);

        if (unchangedsince) {
            if (["ATOM", "STRING"].indexOf(unchangedsince.type) < 0 ||
                !unchangedsince.value.length ||
                isNaN(unchangedsince.value) ||
                Number(unchangedsince.value) < 0) {

                connection.send({
                    tag: parsed.tag,
                    command: "BAD",
                    attributes: [{
                        type: "TEXT",
                        value: "Invalid syntax for UNCHANGEDSINCE, number expected"
                    }]
                }, "CONDSTORE FAILED", parsed, data);
                return callback();
            }
            parsed.unchangedsince = Number(unchangedsince.value);
        }

        uidStoreHandler(connection, parsed, data, callback);
    });

    server.fetchHandlers.MODSEQ = function(connection, message) {
        return [message.MODSEQ]; // Must be a list
    };

    server.fetchFilters.push(function(connection, message, parsed) {
        return "changedsince" in parsed ? parsed.changedsince < message.MODSEQ : true;
    });

    server.storeFilters.push(function(connection, message, parsed) {
        return "unchangedsince" in parsed ? parsed.unchangedsince >= message.MODSEQ : true;
    });

    server.outputHandlers.push(function(connection, response, description, parsed, data, affected) {
        if (!parsed) {
            return;
        }

        // Increase modseq if flags are updated
        if ((description === "STORE COMPLETE" || description === "UID STORE COMPLETE") && affected && affected.length) {
            affected.forEach(function(message) {
                message = Array.isArray(message) ? message[1] : message;
                connection.selectedMailbox.HIGHESTMODSEQ = (connection.selectedMailbox.HIGHESTMODSEQ || 0) + 1;
                message.MODSEQ = connection.selectedMailbox.HIGHESTMODSEQ;
            });
        }

        // Add CONDSTORE info if (CONDSTORE) option was used
        if (description === "EXAMINE" || description === "SELECT") {

            // (CONDSTORE) option was used, show notice
            if (connection.sessionCondstore) {
                if (response.attributes.slice(-1)[0].type !== "TEXT") {
                    response.attributes.push({
                        type: "TEXT",
                        value: "CONDSTORE is now enabled"
                    });
                } else {
                    response.attributes.slice(-1)[0].value += ", CONDSTORE is now enabled";
                }
            }

            // Send untagged info about highest modseq
            connection.send({
                tag: "*",
                command: "OK",
                attributes: [{
                    type: "SECTION",
                    section: [{
                            type: "ATOM",
                            value: "HIGHESTMODSEQ"
                        },
                        connection.selectedMailbox.HIGHESTMODSEQ || 0
                    ]
                }]
            }, "CONDSTORE INFO", parsed, data);
        }
    });
};

function hasCondstoreOption(attributes, parent, index) {
    if (!attributes) {
        return false;
    }
    var condstoreOption = false;
    if (Array.isArray(attributes)) {
        for (var i = attributes.length - 1; i >= 0; i--) {
            if (attributes[i] && attributes[i].type === "ATOM" && attributes[i].value.toUpperCase() === "CONDSTORE") {
                attributes.splice(i, 1);
                condstoreOption = true;
                break;
            }
        }

        // remove parameter if no other memebers were left
        if (!attributes.length) {
            parent.splice(index, 1);
        }
    }
    return !!condstoreOption;
}

function getCondstoreValue(attributes, name, parent, index) {
    if (!attributes) {
        return false;
    }
    var condstoreValue = false;
    if (Array.isArray(attributes)) {
        for (var i = 0; i < attributes.length; i += 2) {
            if (attributes[i] && attributes[i].type === "ATOM" && attributes[i].value.toUpperCase() === name.toUpperCase()) {
                condstoreValue = attributes[i + 1];
                attributes.splice(i, 2);
                break;
            }
        }

        // remove parameter if no other memebers were left
        if (!attributes.length) {
            parent.splice(index, 1);
        }
    }

    return condstoreValue;
}
