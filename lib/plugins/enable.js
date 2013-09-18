"use strict";

/**
 * @help Adds ENABLE capability [RFC5161]
 * @help Must be loaded before any plugin that requires ENABLE support
 */

module.exports = function(server){

    server.registerCapability("ENABLE");

    server.enableAvailable = [];
    server.connectionHandlers.push(function(connection){
        connection.enabled = [];
    });

    server.setCommandHandler("ENABLE", function(connection, parsed, data, callback){
        var capability, i, len;

        if(!parsed.attributes){
            connection.send({
                tag: parsed.tag,
                command: "BAD",
                attributes:[
                    {type: "TEXT", value: "ENABLE expects capability list"}
                ]
            }, "INVALID COMMAND", parsed, data);
            return callback();
        }

        for(i=0, len = parsed.attributes.length; i<len; i++){
            if(parsed.attributes[i].type != "ATOM"){
                connection.send({
                    tag: parsed.tag,
                    command: "BAD",
                    attributes:[
                        {type: "TEXT", value: "Attribute nr "+ (i+1) + " is not an ATOM"}
                    ]
                }, "INVALID COMMAND", parsed, data);
                return callback();
            }
        }

        for(i=0, len = parsed.attributes.length; i<len; i++){
            capability = parsed.attributes[i].value.toUpperCase();
            if(connection.enabled.indexOf(capability) < 0 && server.enableAvailable.indexOf(capability) >= 0){
                connection.enabled.push(capability);
            }
        }

        connection.send({
            tag: parsed.tag,
            command: "OK",
            attributes:[
                {type: "TEXT", value: "ENABLE completed"}
            ]
        }, "ENABLE", parsed, data);

        return callback();
    });
};
