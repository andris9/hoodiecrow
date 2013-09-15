"use strict";

module.exports = function(server){
    // Register capability, always usable
    server.registerCapability("SASL-IR", function(connection){
        return connection.state == "Not Authenticated";
    });
};
