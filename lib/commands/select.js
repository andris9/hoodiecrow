"use strict";

module.exports = function(connection, parsed, data, callback){

    if(!parsed.attributes ||
        parsed.attributes.length != 1 ||
        ["STRING", "LITERAL", "ATOM"].indexOf(parsed.attributes[0].type) < 0
        ){

        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes:[
                {type: "TEXT", value: "SELECT expects 1 mailbox argument"}
            ]
        }, "INVALID COMMAND", parsed, data);
        return callback();
    }

    if(["Authenticated", "Selected"].indexOf(connection.state) < 0){
        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes:[
                {type: "TEXT", value: "Log in first"}
            ]
        }, "SEELCT FAILED", parsed, data);
        return callback();
    }

    var path = parsed.attributes[0].value,
        mailbox = connection.server.folderCache[path];

    if(!mailbox || mailbox.flags.indexOf("\\NoSelect") >= 0){
        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes:[
                {type: "TEXT", value: "Invalid mailbox name"}
            ]
        }, "SELECT FAILED", parsed, data);
        return callback();
    }

    connection.state = "Selected";
    connection.selectedMailbox = mailbox;
    connection.readOnly = false;

    connection.send({
        tag: parsed.tag,
        command: "OK",
        attributes:[
            {type:"SECTION", section:[{type:"ATOM", value: "READ-WRITE"}]},
            {type: "TEXT", value: "Completed"}
        ]
    }, "SEELCT", parsed, data);
    return callback();
};
