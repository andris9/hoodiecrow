"use strict";

// TODO: Mark messages as \Seen when BODY[..] or RFC822 is requested and mailbox is not readOnly

var fetchHandlers = require("./handlers/fetch");

module.exports = function(connection, parsed, data, callback){

    if(!parsed.attributes ||
        parsed.attributes.length != 2 ||
        !parsed.attributes[0] ||
        ["ATOM", "SEQUENCE"].indexOf(parsed.attributes[0].type) < 0 ||
        !parsed.attributes[1] ||
        (["ATOM"].indexOf(parsed.attributes[1].type) < 0 && !Array.isArray(parsed.attributes[1]))
        ){

        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes:[
                {type: "TEXT", value: "UID FETCH expects sequence set and message item names"}
            ]
        }, "INVALID COMMAND", parsed, data);
        return callback();
    }

    if(connection.state != "Selected"){
        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes:[
                {type: "TEXT", value: "Select mailbox first"}
            ]
        }, "UID FETCH FAILED", parsed, data);
        return callback();
    }

    var messages = connection.server.getMessageRange(connection.selectedMailbox, parsed.attributes[0].value, true),
        params = [].concat(parsed.attributes[1] || []),
        macros = {
            "ALL": ["FLAGS", "INTERNALDATE", "RFC822.SIZE", "ENVELOPE"],
            "FAST": ["FLAGS", "INTERNALDATE", "RFC822.SIZE"],
            "FULL": ["FLAGS", "INTERNALDATE", "RFC822.SIZE", "ENVELOPE", "BODY"]
        };

    if(parsed.attributes[1].type == "ATOM" && macros.hasOwnProperty(parsed.attributes[1].value.toUpperCase())){
        params = macros[parsed.attributes[1].value.toUpperCase()];
    }

    try{
        messages.forEach(function(message){
            var key, handler, response = [], value, uid;

            for(var i=0, len = params.length; i<len; i++){
                key = ((typeof params[i] == "string" && params[i]) || (params[i].type == "ATOM" && params[i].value) || "").toUpperCase();
                handler = connection.server.fetchHandlers[key] || fetchHandlers[key];
                if(!handler){
                    throw new Error("Invalid UID FETCH argument"+(key ? " " + key : ""));
                }
                if(key == "UID"){
                    uid = true;
                }
                value = handler(connection, message[1], params[i]);

                response.push(typeof params[i] == "string" ? {type: "ATOM", value: key} : params[i]);
                response.push(value);
            }

            if(!uid){
                key = "UID";
                handler = connection.server.fetchHandlers[key] || fetchHandlers[key];
                value = handler(connection, message[1], params[i]);
                response.push({type: "ATOM", value: "UID"});
                response.push(value);
            }

            connection.send({
                tag: "*",
                attributes: [message[0], {type: "TEXT", value: "UID FETCH"}, response]
            }, "UID FETCH", parsed, data);
        });
    }catch(E){
        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes:[
                {type: "TEXT", value: E.message}
            ]
        }, "UID FETCH FAILED", parsed, data);
        return callback();
    }

    connection.send({
        tag: parsed.tag,
        command: "OK",
        attributes:[
            {type: "TEXT", value: "Not Implemented"}
        ]
    }, "UID FETCH", parsed, data);
    return callback();
};
