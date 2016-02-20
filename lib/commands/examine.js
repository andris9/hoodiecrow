"use strict";

module.exports = function(connection, parsed, data, callback) {

    if (!parsed.attributes ||
        parsed.attributes.length !== 1 ||
        !parsed.attributes[0] ||
        ["STRING", "LITERAL", "ATOM"].indexOf(parsed.attributes[0].type) < 0
    ) {

      connection.send({
          tag: parsed.tag,
          command: "BAD",
          attributes: [{
              type: "TEXT",
              value: "EXAMINE expects 1 mailbox argument"
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
        }, "EXAMINE FAILED", parsed, data);
        return callback();
    }

    var path = parsed.attributes[0].value;


    connection.examine(path,function (err,folder) {
			if (err) {
        connection.send({
            tag: parsed.tag,
            command: "NO",
            attributes: [{
                type: "TEXT",
                value: "Invalid mailbox name"
            }]
        }, "EXAMINE FAILED", parsed, data);
        return callback();
			}
	    connection.notificationQueue = [];

	    var permanentFlags = (folder.permanentFlags||[]).map(function(flag) {
	            return {
	                type: "ATOM",
	                value: flag
	            };
	        });

	    connection.send({
	        tag: "*",
	        command: "FLAGS",
	        attributes: [permanentFlags]
	    }, "EXAMINE FLAGS", parsed, data);

	    if (folder.allowPermanentFlags) {
	        permanentFlags.push({
	            type: "TEXT",
	            value: "\\*"
	        });
	    }

	    connection.send({
	        tag: "*",
	        command: "OK",
	        attributes: [{
	            type: "SECTION",
	            section: [{
	                    type: "ATOM",
	                    value: "PERMANENTFLAGS"
	                },
	                permanentFlags
	            ]
	        }]
	    }, "EXAMINE PERMANENTFLAGS", parsed, data);

	    connection.send({
	        tag: "*",
	        attributes: [
	            folder.messages, {
	                type: "ATOM",
	                value: "EXISTS"
	            }
	        ]
	    }, "EXAMINE EXISTS", parsed, data);

	    connection.send({
	        tag: "*",
	        attributes: [
	            folder.flags["\\Recent"] || 0, {
	                type: "ATOM",
	                value: "RECENT"
	            }
	        ]
	    }, "EXAMINE RECENT", parsed, data);

	    connection.send({
	        tag: "*",
	        command: "OK",
	        attributes: [{
	            type: "SECTION",
	            section: [{
	                    type: "ATOM",
	                    value: "UIDVALIDITY"
	                },
	                folder.uidvalidity
	            ]
	        }]
	    }, "EXAMINE UIDVALIDITY", parsed, data);

			if (folder.uidnext !== undefined) {
		    connection.send({
		        tag: "*",
		        command: "OK",
		        attributes: [{
		            type: "SECTION",
		            section: [{
		                    type: "ATOM",
		                    value: "UIDNEXT"
		                },
		                folder.uidnext
		            ]
		        }]
		    }, "EXAMINE UIDNEXT", parsed, data);
			}

	    connection.send({
	        tag: parsed.tag,
	        command: "OK",
	        attributes: [{
	            type: "SECTION",
	            section: [{
	                type: "ATOM",
	                value: "READ-ONLY"
	            }]
	        }, {
	            type: "TEXT",
	            value: "Completed"
	        }]
	    }, "EXAMINE", parsed, data);
	    callback();
    });
};




