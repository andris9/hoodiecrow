'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const tls = require('node:tls');
const hoodiecrow = require('../lib/server');
const { setupServer } = require('./helpers');

describe('Command processing', () => {
    const ctx = setupServer(() => ({
        plugins: [
            server => {
                server.setCommandHandler('XCRASH', () => {
                    throw new Error('boom');
                });
            }
        ],
        storage: {
            INBOX: {
                messages: [{ raw: 'Subject: hello 1\r\n\r\nWorld 1!' }, { raw: 'Subject: hello 2\r\n\r\nWorld 2!' }]
            }
        }
    }));

    it('A handler that throws does not stall the connection', (t, done) => {
        const cmds = ['A1 XCRASH', 'A2 NOOP', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\nA1 NO [SERVERBUG]') >= 0);
            assert.ok(resp.indexOf('\r\nA2 OK') >= 0);
            done();
        });
    });

    it('Invalid sequence sets are rejected', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 FETCH 0 FLAGS', 'A4 FETCH abc FLAGS', 'A5 FETCH 2 FLAGS', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\nA3 BAD') >= 0);
            assert.ok(resp.indexOf('\r\nA4 BAD') >= 0);
            assert.ok(resp.indexOf('* 1 FETCH') < 0);
            assert.ok(resp.indexOf('\r\n* 2 FETCH (FLAGS ())\r\nA5 OK') >= 0);
            done();
        });
    });

    it('Large literals are refused before login', (t, done) => {
        const cmds = ['A1 LOGIN {100000}', 'A2 NOOP', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('+ Go ahead') < 0);
            assert.ok(resp.indexOf('\r\nA1 BAD Literal too large') >= 0);
            assert.ok(resp.indexOf('\r\nA2 OK') >= 0);
            done();
        });
    });

    it('Non-synchronizing literals need LITERAL+', (t, done) => {
        const cmds = ['A1 LOGIN {8+}\r\ntestuser {8+}\r\ntestpass', 'A2 NOOP', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\nA1 BAD') >= 0);
            assert.ok(resp.indexOf('\r\nA1 OK') < 0);
            done();
        });
    });

    it('Too long command lines are rejected', (t, done) => {
        const cmds = ['A1 NOOP ' + 'x'.repeat(1100 * 1024), 'A2 NOOP', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('* BAD Command line too long') >= 0);
            assert.ok(resp.indexOf('\r\nA2 OK') >= 0);
            done();
        });
    });

    it('server.close() closes open connections', (t, done) => {
        const socket = net.connect(ctx.server.address().port, 'localhost');
        socket.once('data', () => {
            const server = ctx.server;
            // the afterEach hook closes the server again, so use a fresh one for it
            ctx.server = hoodiecrow();
            ctx.server.listen(0, () => {
                server.close(() => done());
            });
        });
        socket.on('error', () => false);
    });
});

describe('STARTTLS', () => {
    const ctx = setupServer(() => ({
        plugins: ['STARTTLS']
    }));

    it('Ignores commands pipelined after STARTTLS', (t, done) => {
        const socket = net.connect(ctx.server.address().port, 'localhost');
        let plain = '';
        let secure = '';

        socket.once('data', () => {
            socket.on('data', chunk => {
                plain += chunk.toString();
                if (/\r\nA1 OK|^A1 OK/.test(plain)) {
                    socket.removeAllListeners('data');
                    const secureSocket = tls.connect({ socket, rejectUnauthorized: false }, () => {
                        secureSocket.write('A3 SELECT INBOX\r\nA4 LOGOUT\r\n');
                    });
                    secureSocket.on('data', chunk => {
                        secure += chunk.toString();
                    });
                    secureSocket.on('close', () => {
                        // the plaintext LOGIN was never executed
                        assert.ok(plain.indexOf('A2 ') < 0);
                        assert.ok(secure.indexOf('A2 ') < 0);
                        assert.ok(secure.indexOf('\r\nA3 BAD') >= 0 || secure.indexOf('A3 BAD') === 0);
                        done();
                    });
                }
            });
            socket.write('A1 STARTTLS\r\nA2 LOGIN testuser testpass\r\n');
        });
    });

    it('STARTTLS is refused after login', (t, done) => {
        // the mock client would try to upgrade after any STARTTLS, so use a plain socket
        const socket = net.connect(ctx.server.address().port, 'localhost');
        let resp = '';
        socket.on('data', chunk => {
            resp += chunk.toString();
        });
        socket.on('close', () => {
            assert.ok(resp.indexOf('\r\nA2 BAD') >= 0);
            done();
        });
        socket.write('A1 LOGIN testuser testpass\r\nA2 STARTTLS\r\nA3 LOGOUT\r\n');
    });
});

describe('Storage', () => {
    it('Does not modify the storage and users objects it was given', (t, done) => {
        const storage = {
            INBOX: {
                messages: [{ raw: 'Subject: hello\r\n\r\nWorld' }]
            }
        };
        const users = { testuser: { password: 'testpass' } };
        const server = hoodiecrow({ storage, users });

        server.appendMessage('INBOX', [], false, 'Subject: second\r\n\r\nWorld');
        server.users.other = { password: 'other' };

        assert.strictEqual(storage.INBOX.messages.length, 1);
        assert.strictEqual(typeof storage.INBOX.messages[0].uid, 'undefined');
        assert.deepStrictEqual(Object.keys(users), ['testuser']);
        assert.strictEqual(hoodiecrow({ storage }).getMailbox('INBOX').messages.length, 1);
        done();
    });

    it('Indexes INBOX subfolders from storage', (t, done) => {
        const server = hoodiecrow({
            storage: {
                INBOX: {
                    folders: {
                        child: {}
                    }
                },
                '': {}
            }
        });

        assert.ok(server.getMailbox('INBOX/child'));
        assert.deepStrictEqual(
            server.matchFolders('', '*').map(folder => folder.path),
            ['INBOX', 'INBOX/child']
        );
        done();
    });

    it('Keeps messages ordered by UID', (t, done) => {
        const server = hoodiecrow({
            storage: {
                INBOX: {
                    messages: [{ raw: 'a', uid: 5 }, { raw: 'b', uid: 2 }, { raw: 'c' }]
                }
            }
        });

        assert.deepStrictEqual(
            server.getMailbox('INBOX').messages.map(message => message.uid),
            [2, 5, 6]
        );
        assert.throws(
            () =>
                hoodiecrow({
                    storage: {
                        INBOX: {
                            messages: [
                                { raw: 'a', uid: 1 },
                                { raw: 'b', uid: 1 }
                            ]
                        }
                    }
                }),
            /Duplicate UID/
        );
        done();
    });

    it('Stores message sources as binary strings', (t, done) => {
        const server = hoodiecrow({
            storage: {
                INBOX: {
                    messages: [{ raw: 'Subject: €\r\n\r\n€' }, { raw: Buffer.from('Subject: ä\r\n\r\nä') }, {}]
                }
            }
        });

        const messages = server.getMailbox('INBOX').messages;
        assert.strictEqual(messages[0].raw, Buffer.from('Subject: €\r\n\r\n€').toString('binary'));
        assert.strictEqual(messages[1].raw, Buffer.from('Subject: ä\r\n\r\nä').toString('binary'));
        assert.strictEqual(messages[2].raw, '');
        done();
    });

    it('Uses a sensible default namespace separator', (t, done) => {
        const server = hoodiecrow({
            storage: {
                INBOX: {},
                '': {},
                'INBOX.': { type: 'shared' },
                '#news': { type: 'shared' }
            }
        });

        assert.strictEqual(server.storage['INBOX.'].separator, '.');
        assert.strictEqual(server.storage['#news'].separator, '/');
        done();
    });

    it('Formats INTERNALDATE in half hour timezones', (t, done) => {
        const server = hoodiecrow();
        const date = new Date(2020, 0, 2, 3, 4, 5);
        // India, UTC+05:30
        date.getTimezoneOffset = () => -330;
        assert.strictEqual(server.formatInternalDate(date), '02-Jan-2020 03:04:05 +0530');
        date.getTimezoneOffset = () => 210;
        assert.strictEqual(server.formatInternalDate(date), '02-Jan-2020 03:04:05 -0330');
        assert.ok(server.validateInternalDate(server.formatInternalDate(date)));
        done();
    });
});
