var packageData = require("../../package");

module.exports = function(server){

    // Add ID to capability listing
    server.addCapability("ID", function(connection){
        // always allow
        return true;
    });

    // Add handler for ID command
    server.addCommandHandler("ID", function(connection, tag, data, callback){
        if(!connection.checkSupport("ID")){
            connection.send(tag, "BAD Unknown command: ID");
            return callback();
        }

        connection.send("*", buildIDString(connection));
        
        connection.processNotices(); // show untagged responses like EXPUNGED etc.
        connection.send(tag, "OK Success");

        callback();
    });

}

function buildIDString(connection){
    var id = {
        name: packageData.name,
        vendor: packageData.author,
        "support-url": "http://andrisreinman.com",
        version: packageData.version,
        "remote-host": connection.socket.remoteAddress
    };

    return "ID (" + Object.keys(id).map(function(key){
        return [connection.escapeString(key), connection.escapeString(id[key])].join(" ");
    }).join(" ") + ")";
};