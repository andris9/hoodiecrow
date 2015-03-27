"use strict";

var makeSearch = require("./handlers/search");

module.exports = function(connection, parsed, data, callback) {
    if (connection.state !== "Selected") {
        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "Select mailbox first"
            }]
        }, "UID SEARCH FAILED", parsed, data);
        return callback();
    }

    if (!parsed.attributes || !parsed.attributes.length) {
        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "UID SEARCH expects search criteria, empty query given"
            }]
        }, "UID SEARCH FAILED", parsed, data);
        return callback();
    }

    var params;

    try {
        params = parsed.attributes.map(function(argument, i) {
            if (["STRING", "ATOM", "LITERAL", "SEQUENCE"].indexOf(argument.type) < 0) {
                throw new Error("Invalid search criteria argument #" + (i + 1));
            }
            return argument.value;
        });
    } catch (E) {
        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: E.message
            }]
        }, "UID SEARCH FAILED", parsed, data);
        return callback();
    }

    var messages = connection.selectedMailbox.messages,
        searchResult;

    try {
        searchResult = makeSearch(connection, messages, params);
    } catch (E) {
        connection.send({
            tag: parsed.tag,
            command: "NO",
            attributes: [{
                type: "TEXT",
                value: E.message
            }]
        }, "UID SEARCH FAILED", parsed, data);
        return callback();
    }

    if (searchResult && searchResult.list && searchResult.list.length) {
        connection.send({
            tag: "*",
            command: "SEARCH",
            attributes: searchResult.list.map(function(item) {
                return item.uid;
            })
        }, "UID SEARCH", parsed, data);
    }

    connection.send({
        tag: parsed.tag,
        command: "OK",
        attributes: [{
            type: "TEXT",
            value: "UID SEARCH completed"
        }]
    }, "UID SEARCH", parsed, data);
    return callback();
};