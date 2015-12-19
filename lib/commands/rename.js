"use strict";

module.exports = function(connection, parsed, data, callback) {

    if (!parsed.attributes ||
        parsed.attributes.length !== 2 ||
        !parsed.attributes[0] ||
        ["STRING", "LITERAL", "ATOM"].indexOf(parsed.attributes[0].type) < 0 ||
        !parsed.attributes[1] ||
        ["STRING", "LITERAL", "ATOM"].indexOf(parsed.attributes[1].type) < 0
    ) {

        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "RENAME expects mailbox source and destination names"
            }]
        }, "INVALID COMMAND", parsed, data);
        return callback();
    }

    if (["Authenticated", "Selected"].indexOf(connection.state) < 0) {
        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "Log in first"
            }]
        }, "CREATE FAILED", parsed, data);
        return callback();
    }

    var source = parsed.attributes[0].value,
		destination = parsed.attributes[1].value;
		
		connection.renameMailbox(source,destination,function (err,data) {
			if (err) {
        connection.send({
            tag: parsed.tag,
            command: "NO",
            attributes: [{
                type: "TEXT",
                value: err
            }]
        }, "RENAME FAILED", parsed, data);
        return callback();
			}
	    connection.send({
	        tag: parsed.tag,
	        command: "OK",
	        attributes: [{
	            type: "TEXT",
	            value: "RENAME completed"
	        }]
	    }, "RENAME", parsed, data, source);
	    return callback();
			
		});
};