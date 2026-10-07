'use strict';

const net = require('net');
const tls = require('tls');

/**
 * @namespace Mockup module
 * @name mockup
 */
module.exports = runClientMockup;

/**
 * <p>Runs a batch of IMAP commands against a server, like a well behaved client would</p>
 *
 * <ul>
 * <li>a command is sent only after the tagged response of the previous command arrived
 *     (RFC 3501 section 5.5 forbids pipelining in many cases)</li>
 * <li>the data of a synchronizing literal ({n}) is sent only after the server's "+"
 *     continuation request (RFC 3501 section 4.3)</li>
 * <li>when the server sends a "+" continuation request and the command has no literal
 *     data left, the next entry of the command list is sent as the continuation data
 *     (an AUTHENTICATE response, or DONE to end IDLE)</li>
 * <li>after the tagged response of a STARTTLS command the connection is upgraded to TLS</li>
 * <li>after the last command the connection is closed and the callback gets the transcript</li>
 * </ul>
 *
 * <pre>
 * var cmds = ["A1 CAPABILITY", "A2 STARTTLS", "A3 LOGIN username password", "A4 LOGOUT"];
 * runClientMockup(143, "localhost", cmds, false, function(resp){
 *     console.log("Final:", resp.toString("utf-8").trim());
 * });
 * </pre>
 *
 * @memberOf mockup
 * @param {Number} port Port number
 * @param {String} host Hostname to connect to
 * @param {Array} commands Command list to be sent to server, as binary strings
 * @param {Boolean} [debug] if set to true log all input/output
 * @param {Function} callback Callback function to run on completion, gets everything the server sent as a Buffer
 */
function runClientMockup(port, host, commands, debug, callback) {
    host = host || 'localhost';
    port = port || 143;
    const queue = Array.isArray(commands) ? splitLiterals(commands) : [];

    const responses = [];
    let buffer = '';
    // tag of the command waiting for its tagged response
    let currentTag = null;
    let currentCommand = '';
    let lastResponse = '';
    let greeted = false;
    let finished = false;

    let socket = net.connect(port, host);

    const log = (prefix, str) => {
        if (debug) {
            console.log(prefix + ' ' + str.replace(/\r?\n$/, ''));
        }
    };

    const write = text => {
        log('C:', text);
        socket.write(text, 'binary');
    };

    const finish = () => {
        if (finished) {
            return;
        }
        finished = true;
        if (typeof callback === 'function') {
            callback(Buffer.concat(responses));
        }
    };

    const sendNext = () => {
        // literal data that the previous command did not get to send is dropped
        while (queue.length && queue[0].continuation) {
            queue.shift();
        }
        if (!queue.length) {
            currentTag = null;
            socket.end();
            return;
        }
        const next = queue.shift();
        currentCommand = next.text;
        currentTag = next.text.split(' ').shift();
        write(next.text + (next.last ? '\r\n' : ''));
    };

    // literal data for the current command, or a continuation line such as DONE
    const onContinuation = () => {
        if (!queue.length) {
            return;
        }
        const next = queue.shift();
        write(next.text + (next.last ? '\r\n' : ''));
    };

    const upgrade = () => {
        const plain = socket;
        plain.removeAllListeners('data');
        plain.removeAllListeners('close');
        socket = tls.connect({ socket: plain, host, rejectUnauthorized: false }, () => {
            log('TLS', 'connection secured');
            sendNext();
        });
        attach(socket);
    };

    const onTagged = () => {
        if (/^\S+ STARTTLS$/i.test(currentCommand) && /^\S+ OK/i.test(lastResponse)) {
            upgrade();
            return;
        }
        sendNext();
    };

    // Splits the received data into complete responses, a response may contain literals
    const processBuffer = () => {
        let pos = 0;
        for (;;) {
            let end = pos;
            let complete = false;
            for (;;) {
                const lineEnd = buffer.indexOf('\r\n', end);
                if (lineEnd < 0) {
                    break;
                }
                const literal = buffer.slice(end, lineEnd).match(/\{(\d+)\}$/);
                if (!literal) {
                    end = lineEnd + 2;
                    complete = true;
                    break;
                }
                const size = Number(literal[1]);
                if (buffer.length < lineEnd + 2 + size) {
                    break;
                }
                end = lineEnd + 2 + size;
            }
            if (!complete) {
                break;
            }

            const response = buffer.slice(pos, end);
            pos = end;
            lastResponse = response;

            if (!greeted) {
                greeted = true;
                sendNext();
            } else if (response.charAt(0) === '+') {
                onContinuation();
            } else if (currentTag && response.substr(0, currentTag.length + 1) === currentTag + ' ') {
                onTagged();
            }
        }
        buffer = buffer.slice(pos);
    };

    function attach(sock) {
        sock.on('data', chunk => {
            responses.push(chunk);
            log('S:', chunk.toString('binary'));
            buffer += chunk.toString('binary');
            processBuffer();
        });
        sock.on('error', err => {
            log('Socket error:', err.message);
            // the close event follows and returns what was received so far
        });
        sock.on('close', finish);
    }

    attach(socket);
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
