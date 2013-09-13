"use strict";

module.exports = function(connection, parsed, data, callback){
    connection.send({
        tag: parsed.tag,
        command: "OK",
        attributes:[
            {type: "TEXT", value: "Not Implemented"}
        ]
    }, "FETCH", parsed, data);
    return callback();
};
