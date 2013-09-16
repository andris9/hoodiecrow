"use strict";

var storeHandlers = {};

module.exports = storeHandlers;

storeHandlers["+FLAGS"] = function(connection, message, flags){
    [].concat(flags).forEach(function(flag){
        flag = flag.value || flag;
        if(flag.charAt(0) == "\\" && connection.server.systemFlags.indexOf(flag) < 0){
            throw new Error("Invalid system flag " + flag);
        }

        if(message.flags.indexOf(flag) < 0){
            message.flags.push(flag);
        }
    });
};

storeHandlers["-FLAGS"] = function(connection, message, flags){
    [].concat(flags).forEach(function(flag){
        flag = flag.value || flag;
        if(flag.charAt(0) == "\\" && connection.server.systemFlags.indexOf(flag) < 0){
            throw new Error("Invalid system flag " + flag);
        }

        if(message.flags.indexOf(flag) >= 0){
            for(var i=0; i<message.flags.length; i++){
                if(message.flags[i] == flag){
                    message.flags.splice(i, 1);
                    break;
                }
            }
        }
    });
};