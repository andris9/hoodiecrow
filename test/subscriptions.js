'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');

const tagged = (resp, tag) => (resp.match(new RegExp('^' + tag + ' (OK|NO|BAD)\\b', 'm')) || [])[1];

describe('SUBSCRIBE, UNSUBSCRIBE and LSUB', () => {
    const ctx = setupServer(() => ({
        storage: {
            INBOX: {},
            '': {
                folders: {
                    Unsubscribed: { subscribed: false },
                    Parent: {
                        flags: ['\\Noselect'],
                        folders: {
                            Child: { subscribed: false }
                        }
                    }
                }
            }
        }
    }));

    // RFC 3501 sections 6.3.6, 6.3.7 and 6.3.9
    it('subscribes and unsubscribes mailboxes', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 LSUB "" "*"',
            'A3 SUBSCRIBE Unsubscribed',
            'A4 LSUB "" "Unsub*"',
            'A5 UNSUBSCRIBE Unsubscribed',
            'A6 LSUB "" "Unsub*"',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(!/^\* LSUB .*"Unsubscribed"\r\nA2 OK/m.test(resp), resp);
            assert.strictEqual(tagged(resp, 'A3'), 'OK');
            assert.ok(/^\* LSUB \(\\HasNoChildren\) "\/" "Unsubscribed"\r\nA4 OK/m.test(resp), resp);
            assert.strictEqual(tagged(resp, 'A5'), 'OK');
            assert.ok(/^A5 OK[^\n]*\nA6 OK/m.test(resp.replace(/\r/g, '')), resp);
            done();
        });
    });

    it('refuses missing and \\Noselect mailboxes', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 SUBSCRIBE missing',
            'A3 SUBSCRIBE Parent',
            'A4 UNSUBSCRIBE Parent',
            'A5 UNSUBSCRIBE missing',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(/^A2 NO \[NONEXISTENT\]/m.test(resp), resp);
            assert.strictEqual(tagged(resp, 'A3'), 'NO');
            assert.strictEqual(tagged(resp, 'A4'), 'NO');
            // hoodiecrow treats removing a name that is not on the subscription list as done
            assert.strictEqual(tagged(resp, 'A5'), 'OK');
            done();
        });
    });
});

describe('DELETE', () => {
    const ctx = setupServer(() => ({
        storage: {
            INBOX: {},
            '': {
                folders: {
                    Empty: {}
                }
            },
            '#news.': {
                type: 'shared',
                separator: '.',
                folders: {
                    world: {}
                }
            }
        }
    }));

    // RFC 3501 section 6.3.4
    it('refuses INBOX, missing mailboxes and other namespaces', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 DELETE INBOX',
            'A3 DELETE missing',
            'A4 DELETE #news.world',
            'A5 DELETE Empty',
            'A6 DELETE Empty',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.strictEqual(tagged(resp, 'A2'), 'NO');
            assert.strictEqual(tagged(resp, 'A3'), 'NO');
            assert.strictEqual(tagged(resp, 'A4'), 'NO');
            assert.strictEqual(tagged(resp, 'A5'), 'OK');
            assert.strictEqual(tagged(resp, 'A6'), 'NO');
            done();
        });
    });
});

describe('SEARCH arguments', () => {
    const ctx = setupServer(() => ({
        storage: {
            INBOX: {
                messages: [{ raw: 'Subject: hello\r\n\r\nWorld' }]
            }
        }
    }));

    it('refuses missing and malformed criteria', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 SELECT INBOX',
            'A3 SEARCH',
            'A4 UID SEARCH',
            'A5 SEARCH NIL',
            'A6 SEARCH ()',
            'A7 SEARCH CHARSET',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            for (const tag of ['A3', 'A4', 'A5', 'A6', 'A7']) {
                assert.strictEqual(tagged(resp, tag), 'BAD', tag + '\n' + resp);
            }
            done();
        });
    });
});

describe('ENABLE arguments', () => {
    const ctx = setupServer(() => ({
        plugins: ['ENABLE', 'CONDSTORE']
    }));

    // RFC 5161 section 3.1: ENABLE takes one or more capability names
    it('refuses missing and non-atom arguments', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 ENABLE', 'A3 ENABLE "CONDSTORE"', 'A4 ENABLE UNKNOWN', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.strictEqual(tagged(resp, 'A2'), 'BAD');
            assert.strictEqual(tagged(resp, 'A3'), 'BAD');
            // unknown capabilities are ignored (RFC 5161 section 3.1)
            assert.ok(/^\* ENABLED\r\nA4 OK/m.test(resp), resp);
            done();
        });
    });
});

describe('STARTTLS on a secure connection', () => {
    const ctx = setupServer(() => ({
        plugins: ['STARTTLS'],
        secureConnection: true
    }));

    it('is not advertised and is refused', (t, done) => {
        const tls = require('node:tls');
        const socket = tls.connect({ port: ctx.server.address().port, host: 'localhost', rejectUnauthorized: false });
        let resp = '';
        socket.on('data', chunk => {
            resp += chunk.toString();
            if (/^A3 /m.test(resp)) {
                socket.end();
            }
        });
        socket.on('close', () => {
            assert.ok(!/^\* CAPABILITY .*STARTTLS/m.test(resp), resp);
            assert.strictEqual(tagged(resp, 'A2'), 'BAD');
            done();
        });
        socket.once('data', () => {
            socket.write('A1 CAPABILITY\r\n');
            socket.once('data', () => {
                socket.write('A2 STARTTLS\r\n');
                socket.once('data', () => {
                    socket.write('A3 LOGOUT\r\n');
                });
            });
        });
    });
});

describe('XTOYBIRD dumps', () => {
    const ctx = setupServer(() => ({
        plugins: ['XTOYBIRD']
    }));

    it('dumps server, connection and storage state', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 XTOYBIRD SERVER', 'A3 XTOYBIRD CONNECTION', 'A4 XTOYBIRD STORAGE', 'A5 XTOYBIRD FOO', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            for (const tag of ['A2', 'A3', 'A4']) {
                assert.strictEqual(tagged(resp, tag), 'OK', tag + '\n' + resp);
            }
            assert.ok(resp.indexOf('"INBOX"') >= 0, resp);
            assert.strictEqual(tagged(resp, 'A5'), 'BAD');
            done();
        });
    });

    it('SHUTDOWN closes the server', (t, done) => {
        const server = ctx.server;
        ctx.run(['A1 LOGIN testuser testpass', 'A2 XTOYBIRD SHUTDOWN'], resp => {
            resp = resp.toString();
            assert.ok(/^\* OK \[ALERT\]/m.test(resp), resp);
            assert.ok(!server.server.listening);
            // the afterEach hook closes the server again, so give it a fresh one
            ctx.server = require('../lib/server')();
            ctx.server.listen(0, () => done());
        });
    });
});
