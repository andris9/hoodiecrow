'use strict';

const net = require('net');
const assert = require('node:assert');
const { afterEach } = require('node:test');
const { validateThen } = require('./validate-responses');
const { splitResponses, splitAtLiterals } = require('../../lib/framing');
const DeflateLayer = require('../../lib/deflate-layer');

/**
 * Opens an interactive IMAP session, for tests that interleave commands from several connections.
 *
 * `session.run(command, callback)` sends one tagged command line and calls back with everything the
 * server sent until the tagged response for it arrived. `session.expect(pattern, callback)` waits for an
 * unsolicited response instead. `session.close()` ends the connection.
 * After a tagged OK to `COMPRESS DEFLATE` the session compresses in both directions (RFC 4978), the
 * output it calls back with is decompressed. `session.raw` sends octets as they are.
 *
 * @param {Number} port Server port
 * @param {Function} callback Called with the session once the greeting has arrived
 */
function openSession(port, callback) {
    const socket = net.connect(port, 'localhost');
    let buffer = '';
    let waiting = null;
    let layer = null;
    let compressTag = null;

    const write = data => {
        if (layer) {
            layer.write(Buffer.from(data, 'binary'));
        } else {
            socket.write(data, 'binary');
        }
    };
    // UTF-8 in quoted strings is valid once an earlier chunk enabled UTF8=ACCEPT, message numbers are
    // invalid once an earlier chunk enabled UIDONLY
    const enabled = { utf8: false, uidonly: false };

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
                write(pending.shift());
                return;
            }
            if (waiting.match(first)) {
                const output = buffer.substr(0, response.end);
                buffer = buffer.substr(response.end);
                const cb = waiting.callback;
                waiting = null;
                if (compressTag && first.substr(0, compressTag.length + 4) === compressTag + ' OK ') {
                    // everything after the CRLF of the tagged OK is compressed
                    layer = new DeflateLayer({ writeRaw: chunk => socket.write(chunk), onData });
                    const rest = buffer;
                    buffer = '';
                    if (rest) {
                        layer.receive(Buffer.from(rest, 'binary'));
                    }
                }
                compressTag = null;
                // every chunk ends with a complete tagged response, so it can be validated on its own
                validateThen(
                    output,
                    responses => {
                        enabled.utf8 = responses.utf8;
                        enabled.uidonly = responses.uidonly;
                        cb(output);
                    },
                    Object.assign({}, enabled)
                );
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
            if (/^\S+ COMPRESS DEFLATE$/i.test(command)) {
                compressTag = tag;
            }
            write(pending.shift());
            check();
        },
        // waits for an unsolicited response whose first line matches `pattern`, calls back with everything
        // that arrived up to and including it (RFC 5465 NOTIFY sends responses between commands)
        expect(pattern, cb) {
            waiting = { match: line => pattern.test(line), callback: cb };
            check();
        },
        // the output that arrived since the last response a test waited for
        buffered() {
            return buffer;
        },
        raw(data) {
            socket.write(data);
        },
        // calls back once the server has closed the connection, with the output that was not waited for
        whenClosed(cb) {
            if (socket.closed) {
                return cb(buffer);
            }
            socket.once('close', () => cb(buffer));
        },
        close() {
            if (layer) {
                layer.end(() => socket.end());
            } else {
                socket.end();
            }
        }
    };

    function onData(chunk) {
        buffer += chunk.toString('binary');
        check();
    }

    socket.on('data', chunk => (layer ? layer.receive(chunk) : onData(chunk)));
    // the server closes leftover connections after every test
    socket.on('error', () => false);
    waiting = { match: line => /^\* OK/.test(line), callback: () => callback(session) };
}

/**
 * Registers logged in sessions for the tests of the enclosing `describe` block, they are closed after every test.
 *
 * `open(mailbox, examine)` opens a session, logs in and selects (or examines) `mailbox` if set, and resolves with
 * `{ session, cmd }`. `cmd(line)` sends a command with a fresh tag (T1, T2 ...) and resolves with everything the
 * server sent up to and including the tagged response, `session` is the openSession() session.
 *
 * @param {Object} ctx Test context from setupServer()
 * @return {Function} open
 */
function useSessions(ctx) {
    let sessions = [];
    let tagCounter = 0;

    afterEach(() => {
        sessions.forEach(session => session.close());
        sessions = [];
    });

    const connect = () => new Promise(resolve => openSession(ctx.server.address().port, resolve));

    return async (mailbox, examine) => {
        const session = await connect();
        sessions.push(session);
        const cmd = line => new Promise(done => session.run('T' + ++tagCounter + ' ' + line, done));
        assert.match(await cmd('LOGIN testuser testpass'), /^T\d+ OK/m);
        if (mailbox) {
            const output = await cmd((examine ? 'EXAMINE ' : 'SELECT ') + mailbox);
            assert.match(output, examine ? /^T\d+ OK \[READ-ONLY\]/m : /^T\d+ OK \[READ-WRITE\]/m);
        }
        return { session, cmd };
    };
}

module.exports = { openSession, useSessions };
