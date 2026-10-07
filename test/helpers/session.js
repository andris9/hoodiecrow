'use strict';

const net = require('net');
const { validateThen } = require('./validate-responses');
const { splitResponses, splitAtLiterals } = require('../../lib/framing');

/**
 * Opens an interactive IMAP session, for tests that interleave commands from several connections.
 *
 * `session.run(command, callback)` sends one tagged command line and calls back with everything the
 * server sent until the tagged response for it arrived. `session.close()` ends the connection.
 *
 * @param {Number} port Server port
 * @param {Function} callback Called with the session once the greeting has arrived
 */
function openSession(port, callback) {
    const socket = net.connect(port, 'localhost');
    let buffer = '';
    let waiting = null;

    let pending = [];

    const check = () => {
        if (!waiting) {
            return;
        }
        const framed = splitResponses(buffer);
        for (const response of framed.responses) {
            const first = buffer.slice(response.start, response.lines[0].end);
            if (pending.length && first.charAt(0) === '+') {
                // a continuation request for the literal data, it is not part of the output
                buffer = buffer.slice(0, response.start) + buffer.slice(response.end);
                socket.write(pending.shift(), 'binary');
                return;
            }
            if (waiting.match(first)) {
                const output = buffer.substr(0, response.end);
                buffer = buffer.substr(response.end);
                const cb = waiting.callback;
                waiting = null;
                // every chunk ends with a complete tagged response, so it can be validated on its own
                validateThen(output, () => cb(output));
                return;
            }
        }
    };

    const session = {
        run(command, cb, waitTag) {
            // waitTag lets a test send several pipelined commands and wait for the last one
            const tag = waitTag || command.split(' ').shift();
            // literal data waits for the continuation request (RFC 3501 section 4.3)
            pending = splitAtLiterals(command + '\r\n');
            waiting = { match: line => line.substr(0, tag.length + 1) === tag + ' ', callback: cb };
            socket.write(pending.shift(), 'binary');
            check();
        },
        close() {
            socket.end();
        }
    };

    socket.on('data', chunk => {
        buffer += chunk.toString('binary');
        check();
    });

    waiting = { match: line => /^\* OK/.test(line), callback: () => callback(session) };
}

module.exports = { openSession };
