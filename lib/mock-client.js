'use strict';

const net = require('net');
const tls = require('tls');

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
    host = host || 'localhost';
    port = port || 25;
    commands = Array.isArray(commands) ? commands : [];

    let ignore_data = false;
    const responses = [];

    const socket = net.connect(port, host);
    let command = '';
    let callbackSent = false;

    socket.on('error', err => {
        if (debug) {
            console.log('Socket error: ' + err.message);
        }
        // the close event follows and returns what was received so far
    });

    socket.on('close', () => {
        if (callbackSent) {
            return;
        }
        callbackSent = true;
        if (typeof callback === 'function') {
            callback(Buffer.concat(responses));
        }
    });

    socket.on('connect', () => {
        socket.on('data', chunk => {
            if (ignore_data) {
                return;
            }

            responses.push(chunk);
            if (debug) {
                console.log('S: ' + chunk.toString('utf-8').trim());
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
                    console.log('Initiated TLS connection');
                }

                socket.removeAllListeners('data');
                const secureSocket = tls.connect(
                    {
                        rejectUnauthorized: false,
                        socket: socket,
                        host: host
                    },
                    () => {
                        ignore_data = false;

                        if (debug) {
                            console.log('TLS connection secured');
                        }

                        secureSocket.on('data', chunk => {
                            responses.push(chunk);
                            if (debug) {
                                console.log('(Secure) S: ' + chunk.toString('utf-8').trim());
                            }

                            if (!commands.length) {
                                return;
                            }

                            command = commands.shift();
                            secureSocket.write(command + '\r\n');
                            if (debug) {
                                console.log('(Secure) C: ' + command);
                            }
                        });

                        secureSocket.on('close', () => {
                            if (callbackSent) {
                                return;
                            }
                            callbackSent = true;
                            if (typeof callback === 'function') {
                                callback(Buffer.concat(responses));
                            }
                        });

                        command = commands.shift();
                        if (debug) {
                            console.log('(Secure) C: ' + command);
                        }
                        secureSocket.write(command + '\r\n');
                    }
                );
            } else {
                command = commands.shift();
                socket.write(command + '\r\n');
                if (debug) {
                    console.log('C: ' + command);
                }
            }
        });
    });
}
