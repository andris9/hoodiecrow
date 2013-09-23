var hoodiecrow = require("../lib/server");

hoodiecrow({
    plugins: ["IDLE", myAwesomePlugin]
}).listen(1143);

// Plugin handler

function myAwesomePlugin(server){

    // Add a string to the capability listing
    server.registerCapability("XSUM");

    /**
     * Add a new command XSUM
     * If client runs this command, the response is a sum of all
     * numeric arguments provided
     *
     * A1 XSUM 1 2 3 4 5
     * * XSUM 15
     * A1 OK SUM completed
     *
     * @param {Object} connection - Session instance
     * @param {Object} parsed - Input from the client in structured form
     * @param {String} data - Input command as a binary string
     * @param {Function} callback - callback function to run
     */
    server.setCommandHandler("XSUM", function(connection, parsed, data, callback){

        // Send untagged XSUM response
        connection.send({
            tag: "*",
            command: "XSUM",
            attributes:[
                [].concat(parsed.attributes || []).reduce(function(prev, cur){
                    return prev + Number(cur.value);
                }, 0)
            ]
        }, "XSUM", parsed, data);

        // Send tagged OK response
        connection.send({
            tag: parsed.tag,
            command: "OK",
            attributes:[
                {type: "TEXT", value: "XSUM completed"}
            ]
        }, "XSUM", parsed, data);
        callback();
    });
}