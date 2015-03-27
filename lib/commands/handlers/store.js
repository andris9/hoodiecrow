"use strict";

var storeHandlers = {};

module.exports = storeHandlers;

function normalizeSystemFlag(flag) {
    if (flag.charAt(0) === "\\") {
        flag = flag.charAt(0) + flag.charAt(1).toUpperCase() + flag.substr(2).toLowerCase();
    }
    return flag;
}

function checkSystemFlags(connection, flag) {
    if (flag.charAt(0) === "\\" && connection.server.systemFlags.indexOf(flag) < 0) {
        throw new Error("Invalid system flag " + flag);
    }
}

function setFlags(connection, message, flags) {
    var messageFlags = [];
    [].concat(flags).forEach(function(flag) {
        flag = normalizeSystemFlag(flag.value || flag);
        checkSystemFlags(connection, flag);

        // Ignore if it is not in allowed list and only permament flags are allowed to use
        if (connection.selectedMailbox.permanentFlags.indexOf(flag) < 0 && !connection.selectedMailbox.allowPermanentFlags) {
            return;
        }

        if (messageFlags.indexOf(flag) < 0) {
            messageFlags.push(flag);
        }
    });
    message.flags = messageFlags;
}

function addFlags(connection, message, flags) {
    [].concat(flags).forEach(function(flag) {
        flag = normalizeSystemFlag(flag.value || flag);
        checkSystemFlags(connection, flag);

        // Ignore if it is not in allowed list and only permament flags are allowed to use
        if (connection.selectedMailbox.permanentFlags.indexOf(flag) < 0 && !connection.selectedMailbox.allowPermanentFlags) {
            return;
        }

        if (message.flags.indexOf(flag) < 0) {
            message.flags.push(flag);
        }
    });
}

function removeFlags(connection, message, flags) {
    [].concat(flags).forEach(function(flag) {
        flag = normalizeSystemFlag(flag.value || flag);
        checkSystemFlags(connection, flag);

        if (message.flags.indexOf(flag) >= 0) {
            for (var i = 0; i < message.flags.length; i++) {
                if (message.flags[i] === flag) {
                    message.flags.splice(i, 1);
                    break;
                }
            }
        }
    });
}

function sendUpdate(connection, parsed, data, index, message) {
    var resp = [{
            type: "ATOM",
            value: "FLAGS"
        },
        message.flags.map(function(flag) {
            return {
                type: "ATOM",
                value: flag
            };
        })
    ];

    if ((parsed.command || "").toUpperCase() === "UID STORE") {
        resp.push({
            type: "ATOM",
            value: "UID"
        });
        resp.push(message.uid);
    }

    connection.send({
        tag: "*",
        attributes: [
            index, {
                type: "ATOM",
                value: "FETCH"
            },
            resp
        ]
    }, "FLAG UPDATE", parsed, data, message);
}

storeHandlers.FLAGS = function(connection, message, flags, index, parsed, data) {
    setFlags(connection, message, flags);
    sendUpdate(connection, parsed, data, index, message);
};

storeHandlers["+FLAGS"] = function(connection, message, flags, index, parsed, data) {
    addFlags(connection, message, flags);
    sendUpdate(connection, parsed, data, index, message);
};

storeHandlers["-FLAGS"] = function(connection, message, flags, index, parsed, data) {
    removeFlags(connection, message, flags);
    sendUpdate(connection, parsed, data, index, message);
};

storeHandlers["FLAGS.SILENT"] = function(connection, message, flags) {
    setFlags(connection, message, flags);
};

storeHandlers["+FLAGS.SILENT"] = function(connection, message, flags) {
    addFlags(connection, message, flags);
};

storeHandlers["-FLAGS.SILENT"] = function(connection, message, flags) {
    removeFlags(connection, message, flags);
};