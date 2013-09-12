"use strict";

module.exports = function(connection, parsed, data, callback){
    connection.send({
        tag: parsed.tag,
        command: "OK",
        attributes:[
            {type: "TEXT", value: "Completed"}
        ]
    }, "NOOP completed", parsed, data);

    callback();
};
