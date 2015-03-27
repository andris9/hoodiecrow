"use strict";

/**
 * @help Enables LITERAL+ [RFC2088] capability
 */

module.exports = function(server) {
    server.registerCapability("LITERAL+");
    server.literalPlus = true;
};