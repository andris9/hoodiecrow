"use strict";

var fetchHandlers = require("./handlers/fetch");

module.exports = function(connection, parsed, data, callback) {

    if (!parsed.attributes ||
        parsed.attributes.length !== 2 ||
        !parsed.attributes[0] ||
        ["ATOM", "SEQUENCE"].indexOf(parsed.attributes[0].type) < 0 ||
        !parsed.attributes[1] ||
        (["ATOM"].indexOf(parsed.attributes[1].type) < 0 && !Array.isArray(parsed.attributes[1]))
    ) {

        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "FETCH expects sequence set and message item names"
            }]
        }, "INVALID COMMAND", parsed, data);
        return callback();
    }

    if (connection.state !== "Selected") {
        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "Select mailbox first"
            }]
        }, "FETCH FAILED", parsed, data);
        return callback();
    }

    var messages = connection.selectedMailbox.messages;
    for (var i = 0, len = connection.notificationQueue.length; i < len; i++) {
        if (connection.notificationQueue[i].mailboxCopy) {
            messages = connection.notificationQueue[i].mailboxCopy;
            break;
        }
    }

    var range = connection.server.getMessageRange(messages, parsed.attributes[0].value, false),
        params = [].concat(parsed.attributes[1] || []),
        macros = {
            "ALL": ["FLAGS", "INTERNALDATE", "RFC822.SIZE", "ENVELOPE"],
            "FAST": ["FLAGS", "INTERNALDATE", "RFC822.SIZE"],
            "FULL": ["FLAGS", "INTERNALDATE", "RFC822.SIZE", "ENVELOPE", "BODY"]
        };

    if (parsed.attributes[1].type === "ATOM" && macros.hasOwnProperty(parsed.attributes[1].value.toUpperCase())) {
        params = macros[parsed.attributes[1].value.toUpperCase()];
    }

    try {
        var flagsExist = false,
            forceSeen = false;

        params.forEach(function(param, i) {
            if (!param || (typeof param !== "string" && param.type !== "ATOM")) {
                throw new Error("Invalid FETCH argument #" + (i + 1));
            }

            if (typeof param === "string") {
                param = params[i] = {
                    type: "ATOM",
                    value: param
                };
            }

            if (param.value.toUpperCase() === "FLAGS") {
                flagsExist = true;
            }

            if (!connection.readOnly) {
                if (param.value.toUpperCase() === "BODY" && param.section) {
                    forceSeen = true;
                } else if (["RFC822", "RFC822.HEADER"].indexOf(param.value.toUpperCase()) >= 0) {
                    forceSeen = true;
                }
            }
        });

        if (forceSeen && !flagsExist) {
            params.push({
                type: "ATOM",
                value: "FLAGS"
            });
        }

        range.forEach(function(rangeMessage) {
            var name, key, handler, response = [],
                value, i, len;
            for (i = 0, len = connection.server.fetchFilters.length; i < len; i++) {
                if (!connection.server.fetchFilters[i](connection, rangeMessage[1], parsed, rangeMessage[0])) {
                    return;
                }
            }

            if (forceSeen && rangeMessage[1].flags.indexOf("\\Seen") < 0) {
                rangeMessage[1].flags.push("\\Seen");
            }

            for (i = 0, len = params.length; i < len; i++) {
                key = (params[i].value || "").toUpperCase();

                handler = connection.server.fetchHandlers[key] || fetchHandlers[key];
                if (!handler) {
                    throw new Error("Invalid FETCH argument " + (key ? " " + key : "#" + (i + 1)));
                }

                value = handler(connection, rangeMessage[1], params[i]);

                name = typeof params[i] === "string" ? {
                    type: "ATOM",
                    value: key
                } : params[i];
                name.value = name.value.replace(/\.PEEK\b/i, "");
                response.push(name);
                response.push(value);
            }

            connection.send({
                tag: "*",
                attributes: [rangeMessage[0], {
                    type: "ATOM",
                    value: "FETCH"
                }, response]
            }, "FETCH", parsed, data);
        });
    } catch (E) {
        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: E.message
            }]
        }, "FETCH FAILED", parsed, data);
        return callback();
    }

    connection.send({
        tag: parsed.tag,
        command: "OK",
        attributes: [{
            type: "TEXT",
            value: "FETCH Completed"
        }]
    }, "FETCH", parsed, data);
    return callback();
};