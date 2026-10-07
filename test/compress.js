'use strict';

// COMPRESS=DEFLATE, RFC 4978 (https://www.rfc-editor.org/rfc/rfc4978.txt)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const zlib = require('node:zlib');
const { setupServer } = require('./helpers');
const { openSession } = require('./helpers/session');
const { validateThen } = require('./helpers/validate-responses');
const DeflateLayer = require('../lib/deflate-layer');

const BIG_BODY = Array.from({ length: 2000 }, (v, i) => 'Line ' + i + ' of a longer message body').join('\r\n') + '\r\n';
const BIG_MESSAGE = 'From: sender@example.com\r\nSubject: big\r\n\r\n' + BIG_BODY;

function storage() {
    return {
        INBOX: {
            messages: [{ raw: 'From: sender@example.com\r\nSubject: hello\r\n\r\nHello world\r\n' }, { raw: BIG_MESSAGE }]
        },
        '': {}
    };
}

/**
 * Logs in, sends COMPRESS DEFLATE and resolves with the raw socket once the tagged OK arrived. Talks
 * DEFLATE with zlib directly, not with the layer the server uses.
 */
function compressedSocket(port) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, 'localhost');
        const steps = [
            [/^\* OK .*\r\n$/, 'L1 LOGIN testuser testpass\r\n'],
            [/^L1 OK .*\r\n$/, 'C1 COMPRESS DEFLATE\r\n'],
            [/^C1 OK .*\r\n$/, false]
        ];
        let buffer = '';
        // every step waits for one response line, the server sends nothing else in between
        const onData = chunk => {
            buffer += chunk.toString('binary');
            const [expected, command] = steps[0];
            if (!/\r\n$/.test(buffer)) {
                return;
            }
            if (!expected.test(buffer)) {
                return reject(new Error('Unexpected response ' + JSON.stringify(buffer)));
            }
            buffer = '';
            steps.shift();
            if (command) {
                socket.write(command);
            } else {
                socket.removeListener('data', onData);
                resolve(socket);
            }
        };
        socket.on('data', onData);
    });
}

describe('COMPRESS=DEFLATE', () => {
    const ctx = setupServer(() => ({
        plugins: ['COMPRESS', 'IDLE', 'LITERALPLUS'],
        storage: storage()
    }));

    it('is advertised', (t, done) => {
        ctx.run(['A1 CAPABILITY'], resp => {
            assert.match(resp.toString('binary'), /^\* CAPABILITY .*COMPRESS=DEFLATE/m);
            done();
        });
    });

    // RFC 4978 section 3: the server compresses starting immediately after the CRLF of the tagged OK
    it('compresses responses and expects compressed commands after the tagged OK', async () => {
        const socket = await compressedSocket(ctx.server.address().port);
        const deflate = zlib.createDeflateRaw();
        const inflate = zlib.createInflateRaw();
        let raw = Buffer.alloc(0);
        let text = '';
        socket.on('data', chunk => {
            raw = Buffer.concat([raw, chunk]);
            inflate.write(chunk);
        });
        inflate.on('data', chunk => {
            text += chunk.toString('binary');
        });
        deflate.on('data', chunk => socket.write(chunk));

        deflate.write('C2 SELECT INBOX\r\nC3 UID FETCH 2 BODY[]\r\n');
        deflate.flush(zlib.constants.Z_SYNC_FLUSH);

        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('No compressed response: ' + JSON.stringify(text))), 3000);
            inflate.on('data', () => {
                if (/^C3 OK /m.test(text)) {
                    clearTimeout(timer);
                    resolve();
                }
            });
        });
        socket.destroy();

        assert.match(text, /^C2 OK \[READ-WRITE\]/m);
        assert.match(text, /^\* 2 FETCH \(BODY\[\] \{\d+\}\r\n/m);
        assert.ok(text.indexOf(BIG_BODY) >= 0);
        // the wire carries DEFLATE data, not the responses, and repetitive text compresses well
        assert.ok(raw.toString('binary').indexOf('FETCH') < 0);
        assert.ok(raw.length < text.length / 4, raw.length + ' vs ' + text.length);
        await new Promise(resolve => validateThen(text, resolve));
    });

    it('runs a whole session compressed', (t, done) => {
        ctx.run(
            [
                'A1 LOGIN testuser testpass',
                'A2 COMPRESS DEFLATE',
                'A3 SELECT INBOX',
                // a synchronizing literal waits for the continuation request, which is compressed too
                'A4 APPEND INBOX {14}\r\nSubject: x\r\n\r\n',
                'A5 APPEND INBOX {14+}\r\nSubject: y\r\n\r\n',
                'A6 FETCH 1:* (FLAGS RFC822.SIZE)',
                'A7 FETCH 2 BODY[]',
                'A8 NOOP',
                'ZZ LOGOUT'
            ],
            resp => {
                resp = resp.toString('binary');
                assert.match(resp, /^A2 OK DEFLATE active\r\n/m);
                assert.match(resp, /^\+ Go ahead\r\n/m);
                assert.match(resp, /^A4 OK /m);
                assert.match(resp, /^A5 OK /m);
                assert.match(resp, /^\* 4 FETCH \(FLAGS \(\\Recent\) RFC822\.SIZE 14\)$/m);
                assert.ok(resp.indexOf(BIG_BODY) >= 0);
                assert.match(resp, /^A8 OK /m);
                // the BYE and the tagged OK of LOGOUT are flushed before the connection closes
                assert.match(resp, /^\* BYE /m);
                assert.match(resp, /^ZZ OK /m);
                done();
            }
        );
    });

    // RFC 4978 section 3: BAD when COMPRESS is already active
    it('refuses a second COMPRESS', (t, done) => {
        ctx.run(['A1 LOGIN testuser testpass', 'A2 COMPRESS DEFLATE', 'A3 COMPRESS DEFLATE', 'A4 NOOP'], resp => {
            resp = resp.toString('binary');
            assert.match(resp, /^A3 BAD \[COMPRESSIONACTIVE\] /m);
            assert.match(resp, /^A4 OK /m);
            done();
        });
    });

    // RFC 4978 section 3: the client MUST NOT send further commands until it has seen the result of COMPRESS
    it('refuses COMPRESS with pipelined commands and stays uncompressed', (t, done) => {
        openSession(ctx.server.address().port, session => {
            session.run('L1 LOGIN testuser testpass', () => {
                session.raw('C1 COMPRESS DEFLATE\r\nC2 NOOP\r\n');
                session.run(
                    'C3 NOOP',
                    resp => {
                        assert.match(resp, /^C1 BAD /m);
                        assert.match(resp, /^C2 OK /m);
                        assert.match(resp, /^C3 OK /m);
                        session.close();
                        done();
                    },
                    'C3'
                );
            });
        });
    });

    it('sends notifications to an idling compressed session right away', (t, done) => {
        const port = ctx.server.address().port;
        openSession(port, idler => {
            idler.run('L1 LOGIN testuser testpass', () => {
                idler.run('C1 COMPRESS DEFLATE', resp => {
                    assert.match(resp, /^C1 OK /m);
                    idler.run('C2 SELECT INBOX', () => {
                        // the continuation request has to arrive before the other session appends
                        idler.run(
                            'C3 IDLE',
                            () => {
                                openSession(port, other => {
                                    other.run('L1 LOGIN testuser testpass', () => {
                                        other.run('O1 APPEND INBOX {14}\r\nSubject: z\r\n\r\n', () => {
                                            idler.run(
                                                'DONE',
                                                output => {
                                                    assert.match(output, /^\* 3 EXISTS$/m);
                                                    assert.match(output, /^C3 OK /m);
                                                    other.close();
                                                    idler.close();
                                                    done();
                                                },
                                                'C3'
                                            );
                                        });
                                    });
                                });
                            },
                            '+'
                        );
                    });
                });
            });
        });
    });

    it('closes the connection on invalid compressed data', async () => {
        const socket = await compressedSocket(ctx.server.address().port);
        const inflate = zlib.createInflateRaw();
        let text = '';
        inflate.on('data', chunk => {
            text += chunk.toString('binary');
        });
        socket.on('data', chunk => inflate.write(chunk));
        await new Promise(resolve => {
            // the server ends its DEFLATE stream before it closes the connection
            inflate.on('end', resolve);
            inflate.on('error', resolve);
            socket.on('close', () => inflate.end());
            // reserved block type 3 is not valid DEFLATE data (RFC 1951 section 3.2.3)
            socket.write(Buffer.from([0xff, 0xff, 0xff, 0xff]));
        });
        assert.match(text, /^\* BYE /m);
    });
});

describe('COMPRESS=DEFLATE without the plugin', () => {
    const ctx = setupServer(() => ({ storage: storage() }));

    it('is not advertised or accepted', (t, done) => {
        ctx.run(['A1 CAPABILITY', 'A2 LOGIN testuser testpass', 'A3 COMPRESS DEFLATE', 'A4 NOOP'], resp => {
            resp = resp.toString('binary');
            assert.doesNotMatch(resp, /COMPRESS=DEFLATE/);
            assert.match(resp, /^A3 BAD /m);
            assert.match(resp, /^A4 OK /m);
            done();
        });
    });
});

describe('DeflateLayer', () => {
    // a peer that ends its compression, then sends plain data, and how the layer finds the boundary
    const receive = (input, callback) => {
        const output = [];
        const layer = new DeflateLayer({
            writeRaw: () => false,
            onData: chunk => {
                const str = chunk.toString('binary');
                output.push(str);
                if (/UNAUTHENTICATE\r\n/.test(str)) {
                    layer.endInput();
                }
            }
        });
        // `more` tells that another chunk follows
        input((chunk, more) => {
            layer.receive(chunk);
            if (!more) {
                layer.whenIdle(() => callback(output.join('')));
            }
        });
    };

    const deflated = (text, flush, callback) => {
        const deflate = zlib.createDeflateRaw();
        const parts = [];
        deflate.on('data', chunk => parts.push(chunk));
        deflate.write(text);
        if (flush === 'finish') {
            deflate.on('end', () => callback(Buffer.concat(parts), deflate));
            deflate.end();
        } else {
            deflate.flush(zlib.constants.Z_SYNC_FLUSH, () => callback(Buffer.concat(parts), deflate));
        }
    };

    it('passes on plain data that follows a finished DEFLATE stream in the same chunk', (t, done) => {
        receive(
            deliver =>
                deflated('A1 NOOP\r\nA2 UNAUTHENTICATE\r\n', 'finish', data => {
                    deliver(Buffer.concat([data, Buffer.from('A3 LOGIN a b\r\n')]));
                }),
            output => {
                assert.strictEqual(output, 'A1 NOOP\r\nA2 UNAUTHENTICATE\r\nA3 LOGIN a b\r\n');
                done();
            }
        );
    });

    it('passes on plain data that follows a sync flush', (t, done) => {
        receive(
            deliver =>
                deflated('A2 UNAUTHENTICATE\r\n', 'sync', data => {
                    deliver(Buffer.concat([data, Buffer.from('A3 LOGIN a b\r\n')]));
                }),
            output => {
                assert.strictEqual(output, 'A2 UNAUTHENTICATE\r\nA3 LOGIN a b\r\n');
                done();
            }
        );
    });

    it('skips the empty final block that arrives after a sync flush', (t, done) => {
        receive(
            deliver =>
                deflated('A2 UNAUTHENTICATE\r\n', 'sync', (data, deflate) => {
                    deliver(data, true);
                    const rest = [];
                    deflate.on('data', chunk => rest.push(chunk));
                    deflate.on('end', () => deliver(Buffer.concat([...rest, Buffer.from('A3 LOGIN a b\r\n')])));
                    deflate.end();
                }),
            output => {
                assert.strictEqual(output, 'A2 UNAUTHENTICATE\r\nA3 LOGIN a b\r\n');
                done();
            }
        );
    });

    it('holds plain writes until the compressed data is out', (t, done) => {
        const written = [];
        const layer = new DeflateLayer({ writeRaw: chunk => written.push(chunk), onData: () => false });
        layer.write(Buffer.from('* first\r\n'));
        layer.end();
        layer.write(Buffer.from('* second\r\n'));
        layer.end(() => {
            const all = Buffer.concat(written);
            const plain = Buffer.from('* second\r\n');
            assert.ok(all.subarray(all.length - plain.length).equals(plain));
            assert.strictEqual(zlib.inflateRawSync(all.subarray(0, all.length - plain.length)).toString(), '* first\r\n');
            layer.destroy();
            done();
        });
    });
});
