"use strict";

// handles a search command
var makeSearch = require("./handlers/search");

module.exports = function(connection, parsed, data, callback) {

	// SEARCH only valid in a selected mailbox
    if (connection.state !== "Selected") {
        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "Select mailbox first"
            }]
        }, "SEARCH FAILED", parsed, data);
        return callback();
    }

		// must have something to search for
    if (!parsed.attributes || !parsed.attributes.length) {
        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "SEARCH expects search criteria, empty query given"
            }]
        }, "SEARCH FAILED", parsed, data);
        return callback();
    }

    var params;

		// make sure we have valid parameters in the search
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
        }, "SEARCH FAILED", parsed, data);
        return callback();
    }


				/*
    for (var i = 0, len = connection.notificationQueue.length; i < len; i++) {
        if (connection.notificationQueue[i].mailboxCopy) {
            messages = connection.notificationQueue[i].mailboxCopy;
            break;
        }
    }
				*/
		
		// 1- use makeSearch to create an appropriate query
		// 2- pass the search term to the connection
		var query = makeSearch(params,connection.server.searchHandlers);
		connection.search(query,function (err,data) {
			if (err) {
        connection.send({
            tag: parsed.tag,
            command: "NO",
            attributes: [{
                type: "TEXT",
                value: err
            }]
        }, "SEARCH FAILED", parsed, data);
        return callback();
			}
			if (data && data.list && data.list.length) {
        connection.send({
            tag: "*",
            command: "SEARCH",
            attributes: data.list.map(function(item) {
                return data.numbers[item.uid];
            })
        }, "SEARCH", parsed, data);
			}
	    connection.send({
	        tag: parsed.tag,
	        command: "OK",
	        attributes: [{
	            type: "TEXT",
	            value: "SEARCH completed"
	        }]
	    }, "SEARCH", parsed, data);
	    return callback();
		});


};