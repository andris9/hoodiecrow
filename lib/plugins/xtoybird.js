"use strict";

/**
 * @help Custom plugin to allow programmatic control of the server
 * @help Available commands:
 * @help  XTOYBIRD SERVER dumps server internals
 * @help  XTOYBIRD CONNECTION dumps connection internals
 * @help  XTOYBIRD STORAGE dumps storage as JSON
 * @help  XTOYBIRD USERADD "username" "password" adds or updates user
 * @help  XTOYBIRD USERDEL "username" removes an user
 * @help  XTOYBIRD SHUTDOWN Closes the server after the last client
 * @help                  disconnects. New connections are rejected.
 */

var util = require("util");

module.exports = function(server) {
    var username, password, message;

    server.setCommandHandler("XTOYBIRD", function(connection, parsed, data, callback) {
        if (parsed.attributes) {
            switch ((parsed.attributes[0].value || "").toUpperCase()) {
                case "SERVER":
                    connection.send({
                        tag: "*",
                        command: "XTOYBIRD",
                        attributes: [{
                            type: "SECTION",
                            section: [{
                                type: "ATOM",
                                value: "XDUMPVAL"
                            }]
                        }, {
                            type: "LITERAL",
                            value: util.inspect(server, false, 22)
                        }]
                    }, "CONNECTION STATUS", parsed, data);
                    break;


                case "CONNECTION":
                    connection.send({
                        tag: "*",
                        command: "XTOYBIRD",
                        attributes: [{
                            type: "SECTION",
                            section: [{
                                type: "ATOM",
                                value: "XDUMPVAL"
                            }]
                        }, {
                            type: "LITERAL",
                            value: util.inspect(connection, false, 22)
                        }]
                    }, "CONNECTION STATUS", parsed, data);
                    break;

                case "STORAGE":
                    connection.send({
                        tag: "*",
                        command: "XTOYBIRD",
                        attributes: [{
                            type: "SECTION",
                            section: [{
                                type: "ATOM",
                                value: "XJSONDUMP"
                            }]
                        }, {
                            type: "LITERAL",
                            value: JSON.stringify(connection.server.storage, false, 4)
                        }]
                    }, "CONNECTION STATUS", parsed, data);
                    break;

                case "USERADD":
                    username = parsed.attributes[1].value || "";
                    password = parsed.attributes[2].value || "";

                    if (connection.server.users[username]) {
                        connection.server.users[username].password = password;
                        message = "updated";
                    } else {
                        connection.server.users[username] = {
                            password: password
                        };
                        message = "added";
                    }

                    connection.send({
                        tag: "*",
                        command: "XTOYBIRD",
                        attributes: [{
                            type: "SECTION",
                            section: [{
                                type: "ATOM",
                                value: "XUSER"
                            }]
                        }, {
                            type: "TEXT",
                            value: "User '" + username + "' " + message + " successfully"
                        }]
                    }, "CONNECTION USERADD", parsed, data);
                    break;

                case "USERDEL":
                    username = parsed.attributes[1].value || "";

                    if (connection.server.users[username]) {
                        delete connection.server.users[username];
                        message = "succeeded";
                    } else {
                        message = "failed (no such user)";
                    }

                    connection.send({
                        tag: "*",
                        command: "XTOYBIRD",
                        attributes: [{
                            type: "SECTION",
                            section: [{
                                type: "ATOM",
                                value: "XUSER"
                            }]
                        }, {
                            type: "TEXT",
                            value: "Removing user '" + username + "' " + message
                        }]
                    }, "CONNECTION USERDEL", parsed, data);
                    break;

                case "SHUTDOWN":
                    connection.send({
                        tag: "*",
                        command: "OK",
                        attributes: [{
                            type: "SECTION",
                            section: [{
                                type: "ATOM",
                                value: "ALERT"
                            }]
                        }, {
                            type: "TEXT",
                            value: "System scheduled for shutdown"
                        }]
                    }, "CONNECTION SHUTDOWN", parsed, data);

                    connection.server.close();
                    break;

                default:
                    connection.send({
                        tag: parsed.tag,
                        command: "BAD",
                        attributes: [{
                            type: "TEXT",
                            value: "Unknown command"
                        }]
                    }, "INVALID COMMAND", parsed, data);
                    return callback();
            }
        }

        connection.send({
            tag: parsed.tag,
            command: "OK",
            attributes: [{
                type: "TEXT",
                value: "XTOYBIRD Completed"
            }]
        }, "XTOYBIRD", parsed, data);
        return callback();
    });

};