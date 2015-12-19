"use strict";
var _ = require('lodash');

/**
 * @help Adds NAMESPACE [RFC2342] capability
 */

module.exports = function(server) {

    // Register capability, always usable
    server.registerCapability("NAMESPACE");

    // Add NAMESPACE command
    server.setCommandHandler("NAMESPACE", function(connection, parsed, data, callback) {
        if (connection.state === "Not Authenticated") {
            connection.send({
                tag: parsed.tag,
                command: "NO",
                attributes: [{
                    type: "TEXT",
                    value: "Login first"
                }]
            }, "INVALID COMMAND", parsed, data);
            return callback();
        }
        if (parsed.attributes) {
            connection.send({
                tag: parsed.tag,
                command: "BAD",
                attributes: [{
                    type: "TEXT",
                    value: "Unexpected arguments to NAMESPACE"
                }]
            }, "INVALID COMMAND", parsed, data);
            return callback();
        }

				connection.namespace(function (err,list) {
					// convert into a format that imap can work with
					var converter = function (item) {
						return [item.name,item.separator];
					};
					list = list || {};
					list.personal = _.map(list.personal,converter);
					list.users = _.map(list.users,converter);
					list.shared = _.map(list.shared,converter);
					
	        connection.send({
	            tag: "*",
	            command: "NAMESPACE",
	            attributes: [
	                list && list.personal && list.personal.length ? list.personal : null,
	                list && list.users && list.users.length ? list.users : null,
	                list && list.shared && list.shared.length ? list.shared : null
	            ]
	        }, "NAMESPACE", parsed, data, list);

	        connection.send({
	            tag: parsed.tag,
	            command: "OK",
	            attributes: [{
	                type: "TEXT",
	                value: "Completed"
	            }]
	        }, "NAMESPACE", parsed, data, list);

	        return callback();
				});

    });
};