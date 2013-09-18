"use strict";

module.exports = function(server){
    server.registerCapability("LITERAL+");
    server.literalPlus = true;
};
