"use strict";

module.exports = function(connection, parsed, data, callback) {
    var args = [].concat(parsed.attributes || []),
        path, flags, internaldate, raw;

    if (["Authenticated", "Selected"].indexOf(connection.state) < 0) {
        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "Log in first"
            }]
        }, "LIST FAILED", parsed, data);
        return callback();
    }

    if (args.length > 4 || args.length < 2) {
        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "APPEND takes 2 - 4 arguments"
            }]
        }, "INVALID COMMAND", parsed, data);
        return callback();
    }

    path = args.shift();
    raw = args.pop();

    if (Array.isArray(args[0])) {
        flags = args.shift();
    }
    internaldate = args.shift();

    if (!raw || raw.type !== "LITERAL") {
        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "Invalid message source argument"
            }]
        }, "INVALID COMMAND", parsed, data);
        return callback();
    }

    if (internaldate && (internaldate.type !== "STRING" || !connection.server.validateInternalDate(internaldate.value))) {
        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "Invalid internaldate argument"
            }]
        }, "INVALID COMMAND", parsed, data);
        return callback();
    }

    if (!path || ["STRING", "ATOM"].indexOf(path.type) < 0) {
        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "Invalid mailbox argument"
            }]
        }, "INVALID COMMAND", parsed, data);
        return callback();
    }

    if (flags) {
        for (var i = 0, len = flags.length; i < len; i++) {
            if (!flags[i] || ["STRING", "ATOM"].indexOf(flags[i].type) < 0) {
                connection.send({
                    tag: parsed.tag,
                    command: "BAD",
                    attributes: [{
                        type: "TEXT",
                        value: "Invalid flags argument"
                    }]
                }, "INVALID COMMAND", parsed, data);
                return callback();
            }
        }
    }


		//flags, internaldate, raw, ignoreConnection
		connection.createMessage(path.value,{flags:(flags || []).map(function(flag) {
	        return flag.value;
	    }), internaldate: internaldate && internaldate.value, raw: raw.value, ignoreConnection:connection},function (err,data) {
				if (err === "invalid mailbox") {
	        connection.send({
	            tag: parsed.tag,
	            command: "BAD",
	            attributes: [{
	                type: "TEXT",
	                value: "Invalid mailbox argument"
	            }]
	        }, "INVALID COMMAND", parsed, data);
	        return callback();
				} 
	    	
				connection.send({
	        tag: parsed.tag,
	        command: "OK",
	        attributes: [{
	            type: "TEXT",
	            value: "APPEND Completed"
	        }]
	    }, "APPEND", parsed, data);
	    callback();
		});
};