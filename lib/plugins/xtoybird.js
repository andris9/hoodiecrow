"use strict";

var util = require("util");

module.exports = function(server){

    server.setCommandHandler("XTOYBIRD", function(connection, parsed, data, callback){
        if(parsed.attributes){
            switch((parsed.attributes[0].value || "").toUpperCase()){
                case "SERVER":
                    connection.send({
                        tag: "*",
                        command: "OK",
                        attributes:[
                            {type: "SECTION", section:[{type: "ATOM", value: "DUMPVAL"}]},
                            {type: "LITERAL", value: util.inspect(server, false, 22)}
                        ]
                    }, "CONNECTION STATUS", parsed, data);
                    break;
                case "CONNECTION":
                    connection.send({
                        tag: "*",
                        command: "OK",
                        attributes:[
                            {type: "SECTION", section:[{type: "ATOM", value: "DUMPVAL"}]},
                            {type: "LITERAL", value: util.inspect(connection, false, 22)}
                        ]
                    }, "CONNECTION STATUS", parsed, data);
                    break;
                case "STORAGE":
                    connection.send({
                        tag: "*",
                        command: "OK",
                        attributes:[
                            {type: "SECTION", section:[{type: "ATOM", value: "JSON"}]},
                            {type: "LITERAL", value: JSON.stringify(connection.server.storage, false, 4)}
                        ]
                    }, "CONNECTION STATUS", parsed, data);
                    break;
                default:
                    connection.send({
                        tag: parsed.tag,
                        command: "BAD",
                        attributes:[
                            {type: "TEXT", value: "Unknown command"}
                        ]
                    }, "INVALID COMMAND", parsed, data);
                    return callback();
            }
        }

        connection.send({
            tag: parsed.tag,
            command: "OK",
            attributes:[
                {type: "TEXT", value: "XTOYBIRD Completed"}
            ]
        }, "XTOYBIRD", parsed, data);
        return callback();
    });

};
