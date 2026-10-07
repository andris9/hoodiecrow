'use strict';

const net = require('net');

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
        if (pending.length && /(^|\r\n)\+[^\r\n]*\r\n$/.test(buffer)) {
            buffer = buffer.replace(/\+[^\r\n]*\r\n$/, '');
            socket.write(pending.shift());
            return;
        }
        const match = buffer.match(waiting.pattern);
        if (match) {
            const end = match.index + match[0].length;
            const output = buffer.substr(0, end);
            buffer = buffer.substr(end);
            const cb = waiting.callback;
            waiting = null;
            cb(output);
        }
    };

    const session = {
        run(command, cb) {
            const tag = command.split(' ').shift();
            // literal data waits for the continuation request (RFC 3501 section 4.3)
            pending = (command + '\r\n').split(/(?<=\{\d+\}\r\n)/);
            waiting = { pattern: new RegExp('(^|\\r\\n)' + tag + ' [^\\r\\n]*\\r\\n'), callback: cb };
            socket.write(pending.shift());
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

    waiting = { pattern: /^\* OK[^\r\n]*\r\n/, callback: () => callback(session) };
}

module.exports = { openSession };
