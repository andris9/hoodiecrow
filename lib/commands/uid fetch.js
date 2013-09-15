"use strict";

// TODO: Implement missing FETCH handlers
// TODO: Mark messages as \Seen when BODY[..] or RFC822 is requested and mailbox is not readOnly

var fetchHandlers = {},
    mimeParser = require("../mimeparser"),
    bodystructure = require("../bodystructure"),
    envelope = require("../envelope");

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

fetchHandlers.UID = function(connection, message){
    return message.uid;
};

fetchHandlers.FLAGS = function(connection, message){
    return message.flags.map(function(flag){
        return {type: "ATOM", value: flag};
    });
};

fetchHandlers.BODYSTRUCTURE = function(connection, message){
    if(!message.parsed){
        message.parsed = mimeParser(message.raw);
    }
    return bodystructure(message.parsed, {upperCaseKeys: true, skipContentLocation: true});
};

fetchHandlers.ENVELOPE = function(connection, message){
    if(!message.parsed){
        message.parsed = mimeParser(message.raw);
    }
    return envelope(message.parsed.parsedHeader);
};

fetchHandlers["BODY.PEEK"] = fetchHandlers.BODY = function(connection, message, query){
    var partial, start, length;
    if(!message.parsed){
        message.parsed = mimeParser(message.raw);
    }

    if(!query.section){
        return bodystructure(message.parsed, {body: true, upperCaseKeys: true});
    }

    var value, keyList;
    if(!query.section.length){
        value = message.raw;
    }else{
        if(query.section[0].type != "ATOM"){
            throw new Error("Invalid BODY[<section>] identifier" + (query.section[0].value ? " " + query.section[0].type : ""));
        }
        switch(query.section[0].value.toUpperCase()){

            case "HEADER":
                if(query.section.length > 1){
                    throw new Error("HEADER does not take any arguments");
                }
                value = (message.parsed.header || []).join("\r\n") + "\r\n\r\n";
                break;

            case "HEADER.FIELDS":
                if(query.section.length != 2 && !Array.isArray(query.section[1])){
                    throw new Error("HEADER.FIELDS expects a list of header fields");
                }
                value = "";
                keyList = [];
                query.section[1].forEach(function(queryKey){
                    if(["ATOM", "STRING", "LITERAL"].indexOf(queryKey.type) < 0){
                        throw new Error("Invalid header field name in list");
                    }
                    queryKey.type = "ATOM"; // ensure that literals are not passed back in the response
                    keyList.push(queryKey.value.toUpperCase());
                });

                (message.parsed.header || []).forEach(function(line){
                    var parts = line.split(":"),
                        key = (parts.shift() || "").toUpperCase().trim();
                    if(keyList.indexOf(key) >= 0){
                        value += line + "\r\n";
                    }
                });

                value += "\r\n";
                break;

            case "HEADER.FIELDS.NOT":
                if(query.section.length != 2 && !Array.isArray(query.section[1])){
                    throw new Error("HEADER.FIELDS.NOT expects a list of header fields");
                }
                value = "";
                keyList = [];
                query.section[1].forEach(function(queryKey){
                    if(["ATOM", "STRING", "LITERAL"].indexOf(queryKey.type) < 0){
                        throw new Error("Invalid header field name in list");
                    }
                    queryKey.type = "ATOM"; // ensure that literals are not passed back in the response
                    keyList.push(queryKey.value.toUpperCase());
                });

                (message.parsed.header || []).forEach(function(line){
                    var parts = line.split(":"),
                        key = (parts.shift() || "").toUpperCase().trim();
                    if(keyList.indexOf(key) < 0){
                        value += line + "\r\n";
                    }
                });

                value += "\r\n";
                break;

            default:
                throw new Error("Not implemented: " + query.section[0].value);
        }
    }

    if(query.partial){
        partial = [].concat(query.partial || []);
        start = partial.shift() || 0;
        length = partial.pop();
        value = value.substr(start, length ? length : 0);
        if(query.partial.length == 2 && query.partial[1] > value.length){
            query.partial.pop();
        }
    }

    return {type: "LITERAL", value: value};
};

fetchHandlers.INTERNALDATE = function(connection, message){
    return message.internaldate;
};

fetchHandlers.RFC822 = function(connection, message){
    return {type: "LITERAL", value: message.raw};
};

fetchHandlers["RFC822.SIZE"] = function(connection, message){
    return message.raw.length;
};

fetchHandlers["RFC822.HEADER"] = function(connection, message){
    if(!message.parsed){
        message.parsed = mimeParser(message.raw);
    }
    return {
        type: "LITERAL",
        value: (message.parsed.header || []).join("\r\n") + "\r\n\r\n"
    };
};
