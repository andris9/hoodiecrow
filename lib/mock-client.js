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
    commands = Array.isArray(commands) ? splitLiterals(commands) : [];

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

    let currentTag = false;

    // Returns the next part to send, or false if the client has to wait. A synchronizing
    // literal is only sent after the server asked for it with a "+" continuation request
    // (RFC 3501 section 4.3), and the rest of a command is dropped if the server answered
    // the command instead.
    const nextCommand = chunk => {
        const str = chunk.toString('binary');
        while (commands.length && commands[0].continuation) {
            if (/(^|\r\n)\+/.test(str)) {
                return commands.shift();
            }
            if (currentTag && new RegExp('(^|\\r\\n)' + currentTag.replace(/[^\w]/g, '\\$&') + ' ').test(str)) {
                while (commands.length && commands[0].continuation) {
                    commands.shift();
                }
                break;
            }
            return false;
        }
        if (!commands.length) {
            return false;
        }
        const next = commands.shift();
        currentTag = next.text.split(' ').shift();
        return next;
    };

    socket.on('connect', () => {
        socket.on('data', chunk => {
            if (ignore_data) {
                return;
            }

            responses.push(chunk);
            if (debug) {
                console.log('S: ' + chunk.toString('utf-8').trim());
            }

            if (command.match(/^[a-z0-9]+ STARTTLS$/i) && commands.length) {
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

                            const next = nextCommand(chunk);
                            if (next === false) {
                                return;
                            }

                            command = next.text;
                            secureSocket.write(next.text + (next.last ? '\r\n' : ''), 'binary');
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

                        const next = commands.shift();
                        command = next.text;
                        if (debug) {
                            console.log('(Secure) C: ' + command);
                        }
                        secureSocket.write(next.text + (next.last ? '\r\n' : ''), 'binary');
                    }
                );
            } else {
                const next = nextCommand(chunk);
                if (next === false) {
                    return;
                }
                command = next.text;
                socket.write(next.text + (next.last ? '\r\n' : ''), 'binary');
                if (debug) {
                    console.log('C: ' + command);
                }
            }
        });
    });
}

/**
 * Splits commands at synchronizing literals, so that literal data can wait for the
 * continuation request
 *
 * @param {Array} commands Command strings
 * @return {Array} Parts to send, as {text, last, continuation}
 */
function splitLiterals(commands) {
    const parts = [];
    commands.forEach(command => {
        const pieces = String(command).split(/(?<=\{\d+\}\r\n)/);
        pieces.forEach((text, i) => {
            parts.push({ text, last: i === pieces.length - 1, continuation: i > 0 });
        });
    });
    return parts;
}
