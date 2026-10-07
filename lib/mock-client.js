'use strict';

const net = require('net');
const tls = require('tls');
const { splitResponses, splitAtLiterals } = require('./framing');
const DeflateLayer = require('./deflate-layer');

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
 * <li>after the tagged OK of a COMPRESS DEFLATE command, data in both directions is compressed
 *     (RFC 4978). The client ends its compression after an UNAUTHENTICATE command, and expects
 *     the server to end its compression after the tagged OK (RFC 8437 section 4.1)</li>
 * <li>the callback gets the decompressed data</li>
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
    // COMPRESS=DEFLATE layer, once the server accepted COMPRESS
    let layer = null;

    const log = (prefix, str) => {
        if (debug) {
            console.log(prefix + ' ' + str.replace(/\r?\n$/, ''));
        }
    };

    const write = text => {
        log('C:', text);
        if (layer) {
            layer.write(Buffer.from(text, 'binary'));
        } else {
            socket.write(text, 'binary');
        }
    };

    const finish = () => {
        if (finished) {
            return;
        }
        finished = true;
        if (buffer) {
            // an incomplete response
            responses.push(Buffer.from(buffer, 'binary'));
        }
        if (layer) {
            layer.destroy();
        }
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
        currentCommand = next.text.replace(/\r\n$/, '');
        currentTag = currentCommand.split(' ').shift();
        write(next.text);
        if (layer && /^\S+ UNAUTHENTICATE$/i.test(currentCommand)) {
            // the client ends its compression after the CRLF of UNAUTHENTICATE (RFC 8437 section 4.1)
            layer.end();
        }
    };

    // literal data for the current command, or a continuation line such as DONE
    const onContinuation = () => {
        if (!queue.length) {
            return;
        }
        write(queue.shift().text);
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

    // everything after the CRLF of the tagged OK is compressed (RFC 4978 section 3)
    const startCompression = () => {
        layer = new DeflateLayer({
            writeRaw: chunk => socket.write(chunk),
            onData: onData,
            onError: err => {
                log('Compression error:', err.message);
                socket.destroy();
            }
        });
    };

    // returns true if compression starts after this response
    const onTagged = () => {
        let compress = false;
        if (/^\S+ OK/i.test(lastResponse)) {
            if (/^\S+ STARTTLS$/i.test(currentCommand)) {
                upgrade();
                return false;
            }
            if (/^\S+ COMPRESS DEFLATE$/i.test(currentCommand)) {
                startCompression();
                compress = true;
            } else if (layer && /^\S+ UNAUTHENTICATE$/i.test(currentCommand)) {
                // the server ends its compression after the CRLF of the OK
                layer.endInput();
            }
        }
        sendNext();
        return compress;
    };

    // Splits the received data into complete responses, a response may contain literals
    const processBuffer = () => {
        const framed = splitResponses(buffer);
        for (const response of framed.responses) {
            lastResponse = buffer.slice(response.start, response.end);
            responses.push(Buffer.from(lastResponse, 'binary'));

            if (!greeted) {
                greeted = true;
                sendNext();
            } else if (lastResponse.charAt(0) === '+') {
                onContinuation();
            } else if (currentTag && lastResponse.substr(0, currentTag.length + 1) === currentTag + ' ' && onTagged()) {
                // compression started, the rest of the data is compressed
                const rest = buffer.slice(response.end);
                buffer = '';
                if (rest) {
                    layer.receive(Buffer.from(rest, 'binary'));
                }
                return;
            }
        }
        buffer = buffer.slice(framed.end);
    };

    function onData(chunk) {
        log('S:', chunk.toString('binary'));
        buffer += chunk.toString('binary');
        processBuffer();
    }

    function attach(sock) {
        sock.on('data', chunk => {
            if (layer) {
                layer.receive(chunk);
            } else {
                onData(chunk);
            }
        });
        sock.on('error', err => {
            log('Socket error:', err.message);
            // the close event follows and returns what was received so far
        });
        // the last data may still be in the decompressor
        sock.on('close', () => (layer ? layer.whenIdle(finish) : finish()));
    }

    attach(socket);
}

/**
 * Splits commands at synchronizing literals, so that literal data can wait for the
 * continuation request
 *
 * @param {Array} commands Command strings
 * @return {Array} Parts to send, as {text, continuation}, the last part of a command ends with CRLF
 */
function splitLiterals(commands) {
    const parts = [];
    commands.forEach(command => {
        splitAtLiterals(String(command) + '\r\n').forEach((text, i) => {
            parts.push({ text, continuation: i > 0 });
        });
    });
    return parts;
}
