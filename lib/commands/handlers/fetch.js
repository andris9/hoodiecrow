"use strict";

// TODO: Implement missing FETCH handlers

var fetchHandlers = {},
    mimeParser = require("../../mimeparser"),
    bodystructure = require("../../bodystructure"),
    envelope = require("../../envelope");

module.exports = fetchHandlers;

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
