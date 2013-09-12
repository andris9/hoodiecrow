"use strict";

module.exports = function(server){

    // Register AUTH=PLAIN capability for non authenticated state
    server.registerCapability("AUTH=PLAIN", function(connection){
        return connection.state == "Not Authenticated";
    });

    // Retrieve previous handler for AUTHENTICATE
    // request will be forwarded to old handler, if the command is not AUTHENTICATE PLAIN
    var oldHandler = server.getCommandHandler("AUTHENTICATE");

    server.setCommandHandler("AUTHENTICATE", function(connection, parsed, data, callback){

        // Not allowed if already logged in
        if(connection.state != "Not Authenticated"){
            connection.send({
                tag: parsed.tag,
                command: "BAD",
                attributes:[
                    {type: "TEXT", value: "Already authenticated, identity change not allowed"}
                ]
            }, "AUTHENTICATE PLAIN FAILED", parsed, data, "AUTHENTICATE PLAIN");
            return callback();
        }

        // Check if the first param is PLAIN
        if(parsed.attributes &&
            parsed.attributes[0].type == "ATOM" && (parsed.attributes[0].value || "").toUpperCase() == "PLAIN"){

            // If this is the old style api, send + and wait for password
            if(parsed.attributes.length == 1){

                // Temporarily redirect client input to this function
                connection.inputHandler = function(str){

                    // Stop listening to any other user input
                    connection.inputHandler = false;

                    var input = new Buffer(str, "base64").toString().split("\x00"),
                        users = connection.server.users,
                        username = input[1] || "",
                        password = input[2] || "";

                    if(!users.hasOwnProperty(username) || users[username].password != password){
                        connection.send({
                            tag: parsed.tag,
                            command: "NO",
                            attributes:[
                                {type: "TEXT", value: "Login failed: authentication failure"}
                            ]
                        }, "AUTHENTICATE PLAIN FAILED", parsed, data, "AUTHENTICATE PLAIN");
                        return callback();
                    }

                    connection.state = "Authenticated";

                    connection.send({
                        tag: parsed.tag,
                        command: "OK",
                        attributes:[
                            {type: "TEXT", value: "User logged in"}
                        ]
                    }, "AUTHENTICATE PLAIN SUCCESS", parsed, data, "AUTHENTICATE PLAIN");
                };

                // Send a + to the client
                if(connection.socket && !connection.socket.destroyed){
                    connection.socket.write("+\r\n");
                }

            }else if(parsed.attributes.length == 2 &&
                // second argument must be Base64 string
                ["ATOM", "STRING", "LITERAL"].indexOf(parsed.attributes[1].type) >= 0){

                var input = new Buffer(parsed.attributes[1].value, "base64").toString().split("\x00"),
                    users = connection.server.users,
                    username = input[1] || "",
                    password = input[2] || "";

                if(!users.hasOwnProperty(username) || users[username].password != password){
                    connection.send({
                        tag: parsed.tag,
                        command: "NO",
                        attributes:[
                            {type: "TEXT", value: "Login failed: authentication failure"}
                        ]
                    }, "AUTHENTICATE PLAIN FAILED", parsed, data, "AUTHENTICATE PLAIN");
                    return callback();
                }

                connection.state = "Authenticated";

                connection.send({
                    tag: parsed.tag,
                    command: "OK",
                    attributes:[
                        {type: "TEXT", value: "User logged in"}
                    ]
                }, "AUTHENTICATE PLAIN SUCCESS", parsed, data, "AUTHENTICATE PLAIN");

            }else{
                // Not correct AUTH=PLAIN
                connection.send({
                    tag: parsed.tag,
                    command: "BAD",
                    attributes:[
                        {type: "TEXT", value: "Invalid attributes for AUTHENTICATE PLAIN"}
                    ]
                }, "AUTHENTICATE PLAIN FAILED", parsed, data, "AUTHENTICATE PLAIN");
            }

        }else if(oldHandler){
            // Use previous version of AUTHENTICATE
            oldHandler(connection, parsed, data, callback);
        }else{
            connection.send({
                tag: parsed.tag,
                command: "BAD",
                attributes:[
                    {type: "TEXT", value: "Invalid attributes for AUTHENTICATE"}
                ]
            }, "AUTHENTICATE FAILED", parsed, data, "AUTHENTICATE");
        }

        return callback();
    });
};
