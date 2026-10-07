'use strict';

// UNAUTHENTICATE, RFC 8437 (https://www.rfc-editor.org/rfc/rfc8437.txt)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const zlib = require('node:zlib');
const { setupServer } = require('./helpers');
const { openSession } = require('./helpers/session');
const { validateThen } = require('./helpers/validate-responses');
const DeflateLayer = require('../lib/deflate-layer');

const PLAIN_IR = 'A9 AUTHENTICATE PLAIN ' + Buffer.from('\x00testuser\x00testpass').toString('base64');

function storage() {
    return {
        INBOX: {
            messages: [{ raw: 'Subject: one\r\n\r\nOne\r\n' }, { raw: 'Subject: two\r\n\r\nTwo\r\n' }]
        },
        '': {}
    };
}

describe('UNAUTHENTICATE', () => {
    const ctx = setupServer(() => ({
        plugins: ['UNAUTHENTICATE', 'AUTH-PLAIN', 'SASL-IR', 'ENABLE', 'CONDSTORE', 'COMPRESS', 'IDLE', 'SEARCHRES'],
        storage: storage()
    }));

    it('is advertised', (t, done) => {
        ctx.run(['A1 CAPABILITY', 'A2 LOGIN testuser testpass', 'A3 CAPABILITY'], resp => {
            assert.match(resp.toString('binary'), /^\* CAPABILITY .*UNAUTHENTICATE[ \r]/m);
            done();
        });
    });

    // RFC 8437 section 3: transition 7 of the state machine, back to the Not Authenticated state
    it('returns to the Not Authenticated state', (t, done) => {
        ctx.run(
            [
                'A1 LOGIN testuser testpass',
                'A2 SELECT INBOX',
                'A3 UNAUTHENTICATE',
                'A4 CAPABILITY',
                'A5 SELECT INBOX',
                'A6 FETCH 1 FLAGS',
                'A7 LOGIN testuser testpass',
                'A8 SELECT INBOX'
            ],
            resp => {
                resp = resp.toString('binary');
                assert.match(resp, /^A3 OK /m);
                // the capabilities of the Not Authenticated state are back
                assert.match(resp, /^\* CAPABILITY .*AUTH=PLAIN/m);
                assert.match(resp, /^A5 BAD /m);
                assert.match(resp, /^A6 BAD /m);
                assert.match(resp, /^A7 OK /m);
                assert.match(resp, /^A8 OK /m);
                done();
            }
        );
    });

    // RFC 8437 section 3: the mailbox ceases to be selected, but no expunge event is generated
    it('closes the selected mailbox without expunging', (t, done) => {
        ctx.run(
            [
                'A1 LOGIN testuser testpass',
                'A2 SELECT INBOX',
                'A3 STORE 1 +FLAGS.SILENT (\\Deleted)',
                'A4 UNAUTHENTICATE',
                'A5 LOGIN testuser testpass',
                'A6 SELECT INBOX'
            ],
            resp => {
                resp = resp.toString('binary');
                const afterReset = resp.substr(resp.indexOf('A4 OK'));
                assert.doesNotMatch(afterReset, /EXPUNGE/);
                assert.match(afterReset, /^\* 2 EXISTS$/m);
                assert.match(resp, /^A6 OK /m);
                done();
            }
        );
    });

    // RFC 8437 section 4.1: ENABLEd extensions cease to be enabled and CONDSTORE behaves as if
    // no CONDSTORE enabling command was issued. ENABLE is allowed again in the new session
    it('resets ENABLE and CONDSTORE', (t, done) => {
        ctx.run(
            [
                'A1 LOGIN testuser testpass',
                'A2 ENABLE CONDSTORE',
                'A3 SELECT INBOX',
                'A4 STORE 1 +FLAGS (\\Seen)',
                'A5 UNAUTHENTICATE',
                'A6 LOGIN testuser testpass',
                'A7 SELECT INBOX',
                'A8 STORE 1 +FLAGS (\\Flagged)',
                'A9 SELECT INBOX (CONDSTORE)',
                'B1 UNAUTHENTICATE',
                'B2 LOGIN testuser testpass',
                'B3 SELECT INBOX',
                'B4 STORE 1 -FLAGS (\\Flagged)',
                'C1 UNAUTHENTICATE',
                'C2 LOGIN testuser testpass',
                'C3 ENABLE CONDSTORE',
                'C4 SELECT INBOX',
                'C5 STORE 1 +FLAGS (\\Answered)'
            ],
            resp => {
                resp = resp.toString('binary');
                const lines = resp.split('\r\n');
                const fetchAfter = tag => lines[lines.findIndex(line => line.startsWith(tag + ' OK')) - 1];
                assert.match(fetchAfter('A4'), /MODSEQ/);
                assert.doesNotMatch(fetchAfter('A8'), /MODSEQ/);
                // SELECT (CONDSTORE) enabled CONDSTORE for the session that ended
                assert.doesNotMatch(fetchAfter('B4'), /MODSEQ/);
                assert.match(resp, /^\* ENABLED CONDSTORE\r\nC3 OK /m);
                assert.match(fetchAfter('C5'), /MODSEQ/);
                done();
            }
        );
    });

    // RFC 8437 section 4.1: saved search results are discarded, "$" is the empty set. SELECT resets
    // the result as well, so the state is checked on the connection itself
    it('discards the SEARCHRES result', (t, done) => {
        openSession(ctx.server.address().port, session => {
            session.run('A1 LOGIN testuser testpass', () => {
                session.run('A2 SELECT INBOX', () => {
                    session.run('A3 SEARCH RETURN (SAVE) ALL', () => {
                        const [connection] = ctx.server.connections;
                        assert.strictEqual(connection.searchResult.size, 2);
                        session.run('A4 UNAUTHENTICATE', resp => {
                            assert.match(resp, /^A4 OK /m);
                            assert.strictEqual(connection.searchResult, null);
                            session.close();
                            done();
                        });
                    });
                });
            });
        });
    });

    // RFC 8437 section 3: without a security layer UNAUTHENTICATE may be pipelined with AUTHENTICATE
    it('accepts AUTHENTICATE pipelined after UNAUTHENTICATE', (t, done) => {
        openSession(ctx.server.address().port, session => {
            session.run('L1 LOGIN testuser testpass', () => {
                session.run(
                    'A1 SELECT INBOX\r\nA2 UNAUTHENTICATE\r\n' + PLAIN_IR + '\r\nA3 SELECT INBOX',
                    resp => {
                        assert.match(resp, /^A2 OK /m);
                        assert.match(resp, /^A9 OK /m);
                        assert.match(resp, /^A3 OK /m);
                        session.close();
                        done();
                    },
                    'A3'
                );
            });
        });
    });

    it('can not be used before login or with arguments', (t, done) => {
        ctx.run(['A1 UNAUTHENTICATE', 'A2 LOGIN testuser testpass', 'A3 UNAUTHENTICATE now', 'A4 NOOP'], resp => {
            resp = resp.toString('binary');
            assert.match(resp, /^A1 BAD /m);
            assert.match(resp, /^A3 BAD /m);
            assert.match(resp, /^A4 OK /m);
            done();
        });
    });

    // RFC 8437 section 4.1: the server ends its compression after the CRLF of the OK, the client
    // after the CRLF of UNAUTHENTICATE, and COMPRESS can be used again in the next session
    it('ends COMPRESS', (t, done) => {
        ctx.run(
            [
                'A1 LOGIN testuser testpass',
                'A2 COMPRESS DEFLATE',
                'A3 SELECT INBOX',
                'A4 UNAUTHENTICATE',
                'A5 CAPABILITY',
                'A6 LOGIN testuser testpass',
                'A7 COMPRESS DEFLATE',
                'A8 SELECT INBOX',
                'A9 LOGOUT'
            ],
            resp => {
                resp = resp.toString('binary');
                for (const tag of ['A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9']) {
                    assert.match(resp, new RegExp('^' + tag + ' OK ', 'm'));
                }
                done();
            }
        );
    });

    // a client that pipelines a plain LOGIN right after its compressed UNAUTHENTICATE, it ends its
    // DEFLATE stream with a final block or just stops after a sync flush
    const pipelinedAfterCompression = finishStream => async () => {
        const socket = net.connect(ctx.server.address().port, 'localhost');
        let plain = '';
        let text = '';
        let inbound = null;
        const waitFor = regex =>
            new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Timeout waiting for ' + regex + ' in ' + JSON.stringify(plain + text))), 3000);
                const check = () => {
                    if (regex.test(plain + text)) {
                        clearTimeout(timer);
                        resolve();
                    } else {
                        setTimeout(check, 2);
                    }
                };
                check();
            });

        socket.on('data', chunk => {
            if (inbound) {
                inbound.receive(chunk);
            } else {
                plain += chunk.toString('binary');
            }
        });

        await waitFor(/^\* OK .*\r\n/m);
        socket.write('A1 LOGIN testuser testpass\r\n');
        await waitFor(/^A1 OK .*\r\n/m);
        socket.write('A2 COMPRESS DEFLATE\r\n');
        await waitFor(/^A2 OK .*\r\n/m);

        // the server ends its compression after the OK of UNAUTHENTICATE, the layer reads past it
        inbound = new DeflateLayer({
            writeRaw: () => false,
            onData: chunk => {
                text += chunk.toString('binary');
                if (/^A4 OK .*\r\n/m.test(text)) {
                    inbound.endInput();
                }
            }
        });
        const deflate = zlib.createDeflateRaw();
        const output = [];
        deflate.on('data', chunk => output.push(chunk));
        const flush = () => new Promise(resolve => deflate.flush(zlib.constants.Z_SYNC_FLUSH, resolve));

        deflate.write('A3 SELECT INBOX\r\n');
        await flush();
        socket.write(Buffer.concat(output.splice(0)));
        await waitFor(/^A3 OK .*\r\n/m);

        deflate.write('A4 UNAUTHENTICATE\r\n');
        await flush();
        if (finishStream) {
            await new Promise(resolve => {
                deflate.once('end', resolve);
                deflate.end();
            });
        }
        // the end of the compressed data and the plain commands in one write
        socket.write(Buffer.concat([...output.splice(0), Buffer.from('A5 LOGIN testuser testpass\r\nA6 SELECT INBOX\r\n')]));

        await waitFor(/^A6 OK .*\r\n/m);
        socket.destroy();
        inbound.destroy();

        const all = plain + text;
        assert.match(all, /^A4 OK /m);
        assert.match(all, /^A5 OK /m);
        await new Promise(resolve => validateThen(all, resolve));
    };

    it('handles plain input right after the final block of the compressed UNAUTHENTICATE', pipelinedAfterCompression(true));
    it('handles plain input right after the sync flush of the compressed UNAUTHENTICATE', pipelinedAfterCompression(false));
});

describe('UNAUTHENTICATE without the plugin', () => {
    const ctx = setupServer(() => ({ storage: storage() }));

    it('is an unknown command', (t, done) => {
        ctx.run(['A1 LOGIN testuser testpass', 'A2 UNAUTHENTICATE', 'A3 SELECT INBOX'], resp => {
            resp = resp.toString('binary');
            assert.doesNotMatch(resp, /^\* CAPABILITY .*UNAUTHENTICATE/m);
            assert.match(resp, /^A2 BAD /m);
            assert.match(resp, /^A3 OK /m);
            done();
        });
    });
});
