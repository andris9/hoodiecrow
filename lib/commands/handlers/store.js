"use strict";

var _ = require('lodash'), async = require('async'), storeHandlers = {};

module.exports = storeHandlers;


function sendUpdate(connection, parsed, data, messages, callback) {
	_.each(messages,function (message) {
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
            message.id, {
                type: "ATOM",
                value: "FETCH"
            },
            resp
        ]
    }, "FLAG UPDATE", parsed, data, message);
	});
	return callback();
}

storeHandlers.FLAGS = function(connection, messages, flags, parsed, data, cb) {
	async.waterfall([
		function (cb) {
	    connection.replaceFlags(messages, _.pluck(flags,"value"), cb);
		},
		function (msgs,cb) {
	    sendUpdate(connection, parsed, data, msgs, cb);
		}
	],cb);
};

storeHandlers["+FLAGS"] = function(connection, messages, flags, parsed, data, cb) {
	async.waterfall([
		function (cb) {
	    connection.addFlags(messages, _.pluck(flags,"value"), cb);
		},
		function (msgs,cb) {
	    sendUpdate(connection, parsed, data, msgs, cb);
		}
	],cb);
};

storeHandlers["-FLAGS"] = function(connection, messages, flags, parsed, data, cb) {
	async.waterfall([
		function (cb) {
	    connection.removeFlags(messages, _.pluck(flags,"value"), cb);
		},
		function (msgs,cb) {
	    sendUpdate(connection, parsed, data, msgs, cb);
		}
	],cb);
};

storeHandlers["FLAGS.SILENT"] = function(connection, messages, flags, parsed, data, cb) {
    connection.replaceFlags(messages, _.pluck(flags,"value"), cb);
};

storeHandlers["+FLAGS.SILENT"] = function(connection, messages, flags, parsed, data, cb) {
  connection.addFlags(messages, _.pluck(flags,"value"), cb);
};

storeHandlers["-FLAGS.SILENT"] = function(connection, messages, flags, parsed, data, cb) {
    connection.removeFlags(messages, _.pluck(flags,"value"), cb);
};