"use strict";

var storeHandlers = require("./handlers/store");

module.exports = function(connection, parsed, data, callback) {
    if (!parsed.attributes ||
        parsed.attributes.length !== 3 ||
        !parsed.attributes[0] ||
        ["ATOM", "SEQUENCE"].indexOf(parsed.attributes[0].type) < 0 ||
        !parsed.attributes[1] ||
        (["ATOM"].indexOf(parsed.attributes[1].type) < 0) ||
        !parsed.attributes[2] ||
        !(["ATOM", "STRING"].indexOf(parsed.attributes[2].type) >= 0 || Array.isArray(parsed.attributes[2]))
    ) {

        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "UID STORE expects sequence set, item name and item value"
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
        }, "UID STORE FAILED", parsed, data);
        return callback();
    }

    var range = connection.server.getMessageRange(connection.selectedMailbox, parsed.attributes[0].value, true),
        itemName = (parsed.attributes[1].value || "").toUpperCase(),
        itemValue = [].concat(parsed.attributes[2] || []),
        affected = [];

    try {

        itemValue.forEach(function(item, i) {
            if (!item || ["STRING", "ATOM"].indexOf(item.type) < 0) {
                throw new Error("Invalid item value #" + (i + 1));
            }
        });

        range.forEach(function(rangeMessage) {

            for (var i = 0, len = connection.server.storeFilters.length; i < len; i++) {
                if (!connection.server.storeFilters[i](connection, rangeMessage[1], parsed, rangeMessage[0])) {
                    return;
                }
            }

            var handler = connection.server.storeHandlers[itemName] || storeHandlers[itemName];
            if (!handler) {
                throw new Error("Invalid STORE argument " + itemName);
            }

            handler(connection, rangeMessage[1], itemValue, rangeMessage[0], parsed, data);
            affected.push(rangeMessage[1]);
        });

    } catch (E) {
        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: E.message
            }]
        }, "UID STORE FAILED", parsed, data);
        return callback();
    }

    connection.send({
        tag: parsed.tag,
        command: "OK",
        attributes: [{
            type: "TEXT",
            value: "UID STORE completed"
        }]
    }, "UID STORE COMPLETE", parsed, data, range);

    callback();
};