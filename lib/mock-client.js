"use strict";

var net = require("net"),
    tls = require("tls");

/**
 * @namespace Mockup module
 * @name mockup
 */
module.exports = runClientMockup;

/**
 * <p>Runs a batch of commands against a server</p>
 *
 * <pre>
 * var cmds = ["A1 CAPABILITY", "A2 STARTTLS", "A3 LOGIN username password", "LOGOUT"];
 * runClientMockup(143, "localhost", cmds, function(resp){
 *     console.log("Final:", resp.toString("utf-8").trim());
 * });
 * </pre>
 *
 * @memberOf mockup
 * @param {Number} port Port number
 * @param {String} host Hostname to connect to
 * @param {Array} commands Command list to be sent to server
 * @param {Function} callback Callback function to run on completion,
 *        has the last response from the server as a param
 * @param {Boolean} [debug] if set to true log all input/output
 */
function runClientMockup(port, host, commands, debug, callback) {

    host = host || "localhost";
    port = port || 25;
    commands = Array.isArray(commands) ? commands : [];

    var ignore_data = false,
        responses = [];

    var socket = net.connect(port, host),
        command = "",
        callbackSent = false;

    socket.on("connect", function() {
        socket.on("close", function() {
            if (callbackSent) {
                return;
            }
            callbackSent = true;
            if (typeof callback === "function") {
                callback(Buffer.concat(responses));
            }
        });

        socket.on("data", function(chunk) {
            if (ignore_data) {
                return;
            }

            responses.push(chunk);
            if (debug) {
                console.log("S: " + chunk.toString("utf-8").trim());
            }

            if (!commands.length) {
                return;
            }

            if (command.match(/^[a-z0-9]+ STARTTLS$/i)) {
                // wait until server sends response to the STARTTLS command
                if (!/Server ready/.test(Buffer.concat(responses).toString())) {
                    return;
                }

                ignore_data = true;
                if (debug) {
                    console.log("Initiated TLS connection");
                }

                socket.removeAllListeners("data");
                var secureSocket = tls.connect({
                    rejectUnauthorized: false,
                    socket: socket,
                    host: host
                }, function() {
                    ignore_data = false;

                    if (debug) {
                        console.log("TLS connection secured");
                    }

                    secureSocket.on("data", function(chunk) {
                        responses.push(chunk);
                        if (debug) {
                            console.log("(Secure) S: " + chunk.toString("utf-8").trim());
                        }

                        if (!commands.length) {
                            return;
                        }

                        command = commands.shift();
                        secureSocket.write(command + "\r\n");
                        if (debug) {
                            console.log("(Secure) C: " + command);
                        }
                    });

                    secureSocket.on("close", function() {
                        if (callbackSent) {
                            return;
                        }
                        callbackSent = true;
                        if (typeof callback === "function") {
                            callback(Buffer.concat(responses));
                        }
                    });

                    command = commands.shift();
                    if (debug) {
                        console.log("(Secure) C: " + command);
                    }
                    secureSocket.write(command + "\r\n");
                });

            } else {
                command = commands.shift();
                socket.write(command + "\r\n");
                if (debug) {
                    console.log("C: " + command);
                }
            }
        });
    });
}
