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
                value: "LIST expects 2 string arguments"
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
        }, "LIST FAILED", parsed, data);
        return callback();
    }

    if (!parsed.attributes[1].value) {
        // empty reference lists separator only
				connection.userMailbox.namespace(parsed.attributes[1].value, function (err,ns) {
					if (ns) {
            connection.send({
                tag: "*",
                command: "LIST",
                attributes: [
                    [{
                        type: "ATOM",
                        value: "\\Noselect"
                    }],
                    ns.separator,
                    ""
                ]
            }, "LIST ITEM", parsed, data);
        	}
			    connection.send({
			        tag: parsed.tag,
			        command: "OK",
			        attributes: [{
			            type: "TEXT",
			            value: "Completed"
			        }]
			    }, "LIST", parsed, data);
					callback();
				});
    } else {
				connection.matchFolders(parsed.attributes[0].value,parsed.attributes[1].value,function (err,folders) {
	        folders.forEach(function(folder) {
	            connection.send({
	                tag: "*",
	                command: "LIST",
	                attributes: [
	                    folder.flags.map(function(flag) {
	                        return {
	                            type: "ATOM",
	                            value: flag
	                        };
	                    }),
	                    folder.separator,
	                    folder.path
	                ]
	            }, "LIST ITEM", parsed, data, folder);
	        });
			    connection.send({
			        tag: parsed.tag,
			        command: "OK",
			        attributes: [{
			            type: "TEXT",
			            value: "Completed"
			        }]
			    }, "LIST", parsed, data);
			    return callback();
				});
    }

};