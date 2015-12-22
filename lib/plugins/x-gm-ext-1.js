"use strict";
var async = require('async'), _ = require('lodash');

// X-GM-MSGID is a 64 bit unsigned number and requires
// extra handling
var Big = require("big.js");

// Sample value from Gmail IMAP extensions API page
// https://developers.google.com/gmail/imap_extensions
// Used as default, if server.options["HIGHESTX-GM-MSGID"]
// is missing
var SEED = "1278455344230334865";

/**
 * @help Adds Gmail specific X-GM-EXT-1 capability
 * @help Status:
 * @help   X-GM-RAW command is not going to be supported
 * @help   X-GM-MSGID is OK
 * @help   X-GM-LABELS is partially supported. You can fetch
 * @help       and store labels but they do not have any
 * @help       required side effects (the message does not
 * @help       get copied to or removed from another mailbox)
 * @help   X-GM-THRID Missing, have to figure out threading first
 */

module.exports = function(server) {

    server["HIGHESTX-GM-MSGID"] = new Big(server.options["HIGHESTX-GM-MSGID"] || SEED);

    // set X-GM-MSGID values when message is created / initialized
    server.messageHandlers.push(function(message, mailbox) {
        var labels;
        if (!message.properties["X-GM-MSGID"]) {
            server["HIGHESTX-GM-MSGID"] = server["HIGHESTX-GM-MSGID"].plus(1);
						message.properties["X-GM-MSGID"] = server["HIGHESTX-GM-MSGID"].toString();
        }

        // Ensure message has an array of labels
        message.properties["X-GM-LABELS"] = [].concat(message.properties["X-GM-LABELS"] || []);

        if (mailbox.path.toUpperCase() === "INBOX") {
            labels = ["\\Inbox"];
        } else if (mailbox["special-use"] && mailbox["special-use"].length) {
            labels = [].concat(mailbox["special-use"]);
        } else {
            labels = [mailbox.path];
        }

        labels.forEach(function(label) {
            server.ensureFlag(message.properties["X-GM-LABELS"], label);
        });
    });

    // Retrieve X-GM-MSGID values with FETCH
    server.fetchHandlers["X-GM-MSGID"] = function(message) {
        return {
            type: "ATOM",
            value: message.properties["X-GM-MSGID"]
        };
    };

    // Retrieve X-GM-LABELS values with FETCH
    server.fetchHandlers["X-GM-LABELS"] = function(message) {
        return message.properties["X-GM-LABELS"].map(function(label) {
            return {
                type: "ATOM",
                value: label
            };
        });
    };

    server.searchHandlers["X-GM-MSGID"] = function(message, sequence, xGmMsgid) {
        return message.properties["X-GM-MSGID"] === xGmMsgid;
    };

    server.storeHandlers["X-GM-LABELS"] = function(connection, message, isUid, flags, parsed, data, cb) {
			var props = {};
			props["X-GM-LABELS"] = _.pluck(flags,"value");
			async.waterfall([
				function (cb) {
			    connection.replaceProperties(message, isUid, props, cb);
				},
				function (msgs,cb) {
	        sendLabelUpdate(connection, parsed, data, msgs, cb);
				}
			],cb);
    };
		// connection, messages, isUid, flags, parsed, data, cb
    server.storeHandlers["+X-GM-LABELS"] = function(connection, message, isUid, flags, parsed, data, cb) {
			var props = {};
			props["X-GM-LABELS"] = _.pluck(flags,"value");
			async.waterfall([
				function (cb) {
			    connection.addProperties(message, isUid, props, cb);
				},
				function (msgs,cb) {
	        sendLabelUpdate(connection, parsed, data, msgs, cb);
				}
			],cb);
    };

    server.storeHandlers["-X-GM-LABELS"] = function(connection, message, isUid, flags, parsed, data, cb) {
			var props = {};
			props["X-GM-LABELS"] = _.pluck(flags,"value");
			async.waterfall([
				function (cb) {
			    connection.removeProperties(message, isUid, props, cb);
				},
				function (msgs,cb) {
	        sendLabelUpdate(connection, parsed, data, msgs, cb);
				}
			],cb);
    };
};




function sendLabelUpdate(connection, parsed, data, messages, cb) {
	_.each(messages,function (message) {
    var resp = [{
            type: "ATOM",
            value: "X-GM-LABELS"
        },
        message.properties["X-GM-LABELS"].map(function(label) {
            return {
                type: "ATOM",
                value: label
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
            message.index, {
                type: "ATOM",
                value: "FETCH"
            },
            resp
        ]
    }, "FLAG UPDATE", parsed, data, message);
	});
	return cb();
}