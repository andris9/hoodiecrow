"use strict";

module.exports = function(connection, parsed, data, callback) {

    if (parsed.attributes) {
        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "CLOSE does not take any arguments"
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
                value: "Select a mailbox first"
            }]
        }, "CLOSE FAILED", parsed, data);
        return callback();
    }

    connection.expungeDeleted(connection.selectedMailbox, true,function (err,data) {
	    connection.send({
	        tag: parsed.tag,
	        command: "OK",
	        attributes: [{
	            type: "TEXT",
	            value: "Mailbox closed"
	        }]
	    }, "CLOSE", parsed, data);

	    connection.state = "Authenticated";
	    connection.selectedMailbox = false;
	    return callback();
    });

};