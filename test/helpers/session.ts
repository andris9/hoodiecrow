import net from 'node:net';
import assert from 'node:assert';
import { afterEach } from 'node:test';
import { validateThen } from './validate-responses.js';
import { splitResponses, splitAtLiterals } from '../../src/framing.js';
import DeflateLayer from '../../src/deflate-layer.js';
import type { AddressInfo } from 'node:net';
import type { TestContext } from './index.js';

/** An interactive IMAP session of openSession() */
export interface Session {
    run(command: string, cb: (output: string) => void, waitTag?: string): void;
    expect(pattern: RegExp, cb: (output: string) => void): void;
    buffered(): string;
    raw(data: string | Buffer): void;
    whenClosed(cb: (output: string) => void): void;
    close(): void;
}

interface Waiting {
    match: (line: string) => boolean;
    callback: (output: string) => void;
}

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
function openSession(port: number, callback: (session: Session) => void): void {
    const socket = net.connect(port, 'localhost');
    let buffer = '';
    let waiting: Waiting | null = null;
    let layer: DeflateLayer | null = null;
    let compressTag: string | null = null;

    const write = (data: string | Buffer) => {
        if (layer) {
            layer.write(typeof data === 'string' ? Buffer.from(data, 'binary') : data);
        } else {
            socket.write(typeof data === 'string' ? Buffer.from(data, 'binary') : data);
        }
    };
    // UTF-8 in quoted strings is valid once an earlier chunk enabled UTF8=ACCEPT, message numbers are
    // invalid once an earlier chunk enabled UIDONLY
    const enabled = { utf8: false, uidonly: false };

    let pending: (string | Buffer)[] = [];

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
                write(pending.shift() as string | Buffer);
                return;
            }
            if (waiting.match(first)) {
                const output = buffer.substr(0, response.end);
                buffer = buffer.substr(response.end);
                const cb = waiting.callback;
                waiting = null;
                if (compressTag && first.substr(0, compressTag.length + 4) === compressTag + ' OK ') {
                    // everything after the CRLF of the tagged OK is compressed
                    layer = new DeflateLayer({
                        writeRaw: chunk => {
                            socket.write(chunk);
                        },
                        onData
                    });
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

    const session: Session = {
        run(command, cb, waitTag) {
            // waitTag lets a test send several pipelined commands and wait for the last one
            const tag = waitTag || (command.split(' ')[0] as string);
            // literal data waits for the continuation request (RFC 3501 section 4.3)
            pending = splitAtLiterals(command + '\r\n');
            waiting = { match: line => line.substr(0, tag.length + 1) === tag + ' ', callback: cb };
            if (/^\S+ COMPRESS DEFLATE$/i.test(command)) {
                compressTag = tag;
            }
            write(pending.shift() as string | Buffer);
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

    function onData(chunk: Buffer) {
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
function useSessions(ctx: TestContext) {
    let sessions: Session[] = [];
    let tagCounter = 0;

    afterEach(() => {
        sessions.forEach(session => session.close());
        sessions = [];
    });

    const connect = () => new Promise<Session>(resolve => openSession((ctx.server.address() as AddressInfo).port, resolve));

    return async (mailbox?: string, examine?: boolean) => {
        const session = await connect();
        sessions.push(session);
        const cmd = (line: string) => new Promise<string>(done => session.run('T' + ++tagCounter + ' ' + line, done));
        assert.match(await cmd('LOGIN testuser testpass'), /^T\d+ OK/m);
        if (mailbox) {
            const output = await cmd((examine ? 'EXAMINE ' : 'SELECT ') + mailbox);
            assert.match(output, examine ? /^T\d+ OK \[READ-ONLY\]/m : /^T\d+ OK \[READ-WRITE\]/m);
        }
        return { session, cmd };
    };
}

export { openSession, useSessions };
