"use strict";

module.exports = function(connection, parsed, data, callback){
    if(!parsed.attributes || parsed.attributes.length != 2){
        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes:[
                {type: "TEXT", value: "LOGIN takes 2 arguments"}
            ]
        }, "INVALID COMMAND", parsed, data, "LOGIN");
        return callback();
    }

    connection.send({
        tag: parsed.tag,
        command: "BAD",
        attributes:[
            {type: "TEXT", value: "Not implemented"}
        ]
    }, "LOGIN FAILED", parsed, data);

    callback();
};