"use strict";

module.exports = function(connection, parsed, data, callback) {

    // LOGIN expects 2 string params - username and password
    if (!parsed.attributes ||
        parsed.attributes.length !== 2 ||
        !parsed.attributes[0] ||
        !parsed.attributes[1] ||
        ["STRING", "LITERAL", "ATOM"].indexOf(parsed.attributes[0].type) < 0 ||
        ["STRING", "LITERAL", "ATOM"].indexOf(parsed.attributes[1].type) < 0
    ) {

        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "LOGIN takes 2 string arguments"
            }]
        }, "INVALID COMMAND", parsed, data);
        return callback();
    }

    if (connection.state !== "Not Authenticated") {
        connection.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "Already authenticated, identity change not allowed"
            }]
        }, "LOGIN FAILED", parsed, data);
        return callback();
    }

    var users = connection.server.users,
        username = parsed.attributes[0].value,
        password = parsed.attributes[1].value;

    if (!users.hasOwnProperty(username) || users[username].password !== password) {
        connection.send({
            tag: parsed.tag,
            command: "NO",
            attributes: [{
                type: "TEXT",
                value: "Login failed: authentication failure"
            }]
        }, "LOGIN FAILED", parsed, data);
        return callback();
    }

    connection.state = "Authenticated";

    connection.send({
        tag: parsed.tag,
        command: "OK",
        attributes: [{
            type: "TEXT",
            value: "User logged in"
        }]
    }, "LOGIN SUCCESS", parsed, data);

    callback();
};