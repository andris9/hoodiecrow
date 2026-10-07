'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const tls = require('node:tls');
const imapkit = require('../lib/server');
const { setupServer } = require('./helpers');

describe('Command processing', () => {
    const ctx = setupServer(() => ({
        plugins: [
            server => {
                server.setCommandHandler('XCRASH', () => {
                    throw new Error('boom');
                });
                // RFC 3501 section 9: x-command = "X" atom
                server.setCommandHandler('X-PING.V2', (connection, parsed, data, callback) => {
                    connection.sendStatus(parsed, data, 'OK', 'Pong ' + ((parsed.attributes || [])[0] || {}).value);
                    callback();
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

    // RFC 3501 section 9: command names are atoms, x-command = "X" atom, auth-type = atom
    it('Accepts atom chars in command names', (t, done) => {
        const cmds = ['A1 X-PING.V2 hello', 'A2 X-PING.V2 {3}\r\nabc', 'A3 X-NOPE', 'A4 AUTHENTICATE PLAIN-CLIENTTOKEN', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.match(resp, /^A1 OK Pong hello\r$/m);
            assert.match(resp, /^A2 OK Pong abc\r$/m);
            assert.match(resp, /^A3 BAD Invalid command X-NOPE\r$/m);
            assert.match(resp, /^A4 NO Unsupported authentication mechanism\r$/m);
            done();
        });
    });

    // command names never select files outside lib/commands
    it('Only loads the built-in command handlers', (t, done) => {
        assert.strictEqual(ctx.server.getCommandHandler('../commands/fetch'), false);
        assert.strictEqual(ctx.server.getCommandHandler('../server'), false);
        assert.strictEqual(ctx.server.getCommandHandler('TOSTRING'), false);
        assert.strictEqual(typeof ctx.server.getCommandHandler('uid fetch'), 'function');

        const cmds = ['A1 ../server', 'A2 ../../package {3}\r\nabc', 'ZZ LOGOUT'];
        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.match(resp, /^A1 BAD Invalid command \.\.\/server\r$/m);
            // the literal of an unknown command is refused without a continuation request
            assert.match(resp, /^A2 BAD /m);
            assert.doesNotMatch(resp, /^\+ /m);
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

    it('Accepts * in sequence sets and wildcards in LIST patterns', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 FETCH * FLAGS', 'A4 FETCH 1,* UID', 'A5 LIST "" IN*', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\n* 2 FETCH (FLAGS ())\r\nA3 OK') >= 0);
            assert.ok(resp.indexOf('\r\n* 1 FETCH (UID 1)\r\n* 2 FETCH (UID 2)\r\nA4 OK') >= 0);
            assert.ok(resp.indexOf('\r\nA5 OK') >= 0);
            assert.ok(resp.indexOf('"INBOX"') >= 0);
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
            ctx.server = imapkit();
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

    // RFC 9051 section 6.2.1: once a client issues STARTTLS, it MUST NOT issue further commands until it has seen
    // the response. TLS is not started then, so no plaintext input can be read as if it came through TLS
    it('Refuses STARTTLS with pipelined commands and runs none of them', (t, done) => {
        const socket = net.connect(ctx.server.address().port, 'localhost');
        let resp = '';
        let loggedOut = false;
        socket.on('data', chunk => {
            resp += chunk.toString();
            if (!loggedOut && /^A3 /m.test(resp)) {
                // sent after the refusals were seen, so it runs
                loggedOut = true;
                socket.write('A4 LOGOUT\r\n');
            }
        });
        socket.on('close', () => {
            assert.match(resp, /^A1 BAD Commands must not be pipelined after STARTTLS\r$/m);
            // the client meant these to run under TLS, so they do not run in plaintext
            assert.match(resp, /^A2 BAD Commands must not be pipelined after STARTTLS\r$/m);
            assert.match(resp, /^A3 BAD Commands must not be pipelined after STARTTLS\r$/m);
            assert.doesNotMatch(resp, /logged in/i);
            assert.match(resp, /^A4 OK /m);
            done();
        });
        socket.once('data', () => {
            socket.write('A1 STARTTLS\r\nA2 LOGIN testuser testpass\r\nA3 APPEND INBOX {3}\r\n');
        });
    });

    it('Starts TLS right after the tagged OK of STARTTLS', (t, done) => {
        const socket = net.connect(ctx.server.address().port, 'localhost');
        let plain = '';
        let secure = '';
        socket.once('data', () => {
            socket.on('data', chunk => {
                plain += chunk.toString();
                if (/^A1 OK/m.test(plain)) {
                    socket.removeAllListeners('data');
                    const secureSocket = tls.connect({ socket, rejectUnauthorized: false }, () => {
                        secureSocket.write('A2 CAPABILITY\r\nA3 LOGOUT\r\n');
                    });
                    secureSocket.on('data', chunk => {
                        secure += chunk.toString();
                    });
                    secureSocket.on('close', () => {
                        assert.match(secure, /^A2 OK /m);
                        // STARTTLS is not offered on a secure connection
                        assert.doesNotMatch(secure, /STARTTLS/);
                        done();
                    });
                }
            });
            socket.write('A1 STARTTLS\r\n');
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
        const server = imapkit({ storage, users });

        server.appendMessage('INBOX', [], false, 'Subject: second\r\n\r\nWorld');
        server.users.other = { password: 'other' };

        assert.strictEqual(storage.INBOX.messages.length, 1);
        assert.strictEqual(typeof storage.INBOX.messages[0].uid, 'undefined');
        assert.deepStrictEqual(Object.keys(users), ['testuser']);
        assert.strictEqual(imapkit({ storage }).getMailbox('INBOX').messages.length, 1);
        done();
    });

    it('Indexes INBOX subfolders from storage', (t, done) => {
        const server = imapkit({
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
        const server = imapkit({
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
                imapkit({
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
        const server = imapkit({
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

    it('Resolves the namespace, separator and parent of mailbox names', () => {
        const server = imapkit({
            storage: {
                INBOX: {},
                'INBOX.': { folders: { Sent: {}, Work: { folders: { Done: {} } } } },
                '#shared/': { type: 'shared', folders: { Team: {} } }
            }
        });

        assert.strictEqual(server.getMailboxNamespace('inbox'), 'INBOX');
        assert.strictEqual(server.getMailboxNamespace('INBOX.Missing'), 'INBOX.');
        assert.strictEqual(server.getMailboxNamespace('#shared/Team'), '#shared/');
        assert.strictEqual(server.getMailboxNamespace('Elsewhere'), false);

        assert.ok(server.isPersonal('INBOX'));
        assert.ok(server.isPersonal('INBOX.Missing'));
        assert.ok(server.isPersonal(server.getMailbox('INBOX.Work.Done')));
        assert.ok(!server.isPersonal('#shared/Team'));
        assert.ok(!server.isPersonal('Elsewhere'));

        assert.strictEqual(server.getSeparator('INBOX'), '.');
        assert.strictEqual(server.getSeparator('#shared/Team'), '/');

        assert.strictEqual(server.getParentPath('INBOX.Work.Done'), 'INBOX.Work');
        assert.strictEqual(server.getParentPath('INBOX.Work.'), 'INBOX');
        assert.strictEqual(server.getParentPath('INBOX'), false);
        // the namespace prefix is not a mailbox name
        assert.strictEqual(server.getParentPath('#shared/Team'), false);

        assert.deepStrictEqual(
            server.getDescendants('INBOX.Work').map(mailbox => mailbox.path),
            ['INBOX.Work.Done']
        );
        assert.deepStrictEqual(
            server
                .getDescendants('INBOX')
                .map(mailbox => mailbox.path)
                .sort(),
            ['INBOX.Sent', 'INBOX.Work', 'INBOX.Work.Done']
        );

        assert.deepStrictEqual(server.listAttributes(server.getMailbox('INBOX.Work'), { subscribed: true, hasChildren: true }), [
            '\\Subscribed',
            '\\HasChildren'
        ]);
        assert.deepStrictEqual(server.listAttributes({ flags: ['\\Noselect', '\\HasNoChildren'] }, { exists: false, extra: ['\\NoAccess'] }), [
            '\\NonExistent',
            '\\NoAccess',
            '\\HasNoChildren'
        ]);
        assert.deepStrictEqual(server.listAttributes({ flags: ['\\Noinferiors'] }, {}), ['\\Noinferiors']);
    });

    it('Uses a sensible default namespace separator', (t, done) => {
        const server = imapkit({
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
        const server = imapkit();
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
