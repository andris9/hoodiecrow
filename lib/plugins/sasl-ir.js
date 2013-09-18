"use strict";

/**
 * @help Enables SASL-IR [RFC4959] capability
 */

module.exports = function(server){
    // Register capability, always usable
    server.registerCapability("SASL-IR", function(connection){
        return connection.state == "Not Authenticated";
    });
};
