"use strict";

module.exports = function(server){
    
    server.registerCapability("LOGINDISABLED", function(connection){
        return !connection.secureConnection && connection.state == "Not Authenticated";
    });

    var handler = require("../commands/login");

    server.setCommandHandler("LOGIN", function(connection, parsed, data, callback){
        if(!connection.secureConnection){
            connection.send({
                tag: parsed.tag,
                command: "BAD",
                attributes:[
                    {type: "TEXT", value: "Run STARTTLS first"}
                ]
            }, "INVALID COMMAND", parsed, data, "LOGIN");
            return callback();
        }

        // forward to real LOGIN
        handler(connection, parsed, data, callback);
    });
};