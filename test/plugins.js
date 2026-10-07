'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const hoodiecrow = require('../lib/server');
const { setupServer } = require('./helpers');

describe('Plugin loading', () => {
    it('throws on unknown plugin names', () => {
        assert.throws(() => hoodiecrow({ plugins: ['IDLE', 'NOSUCHPLUGIN'] }), /Unknown plugin "NOSUCHPLUGIN"/);
        assert.throws(() => hoodiecrow({ plugins: ['../commands/login'] }), /Unknown plugin/);
    });

    it('throws on invalid plugin values', () => {
        assert.throws(() => hoodiecrow({ plugins: [{}] }), /Invalid plugin/);
    });

    it('accepts capability spellings', () => {
        const server = hoodiecrow({ plugins: ['LITERAL+', 'AUTH=PLAIN', 'auth=xoauth2', ' idle '] });
        assert.ok(server.capabilities['LITERAL+']);
        assert.ok(server.capabilities['AUTH=PLAIN']);
        assert.ok(server.capabilities['AUTH=XOAUTH2']);
        assert.ok(server.capabilities.IDLE);
        assert.strictEqual(server.literalPlus, true);
    });

    it('loads repeated plugins only once', () => {
        let calls = 0;
        const custom = () => {
            calls++;
        };
        const server = hoodiecrow({ plugins: ['SPECIAL-USE', 'special-use', custom, custom, 'CONDSTORE', 'CONDSTORE'] });
        assert.strictEqual(calls, 1);
        assert.strictEqual(server.outputHandlers.length, 2);
        assert.strictEqual(server.allowedStatus.filter(item => item === 'HIGHESTMODSEQ').length, 1);
    });

    it('emits pluginsLoaded once every plugin is loaded', () => {
        const seen = [];
        const first = server => {
            server.once('pluginsLoaded', () => seen.push(typeof server.getCommandHandler('MOVE')));
        };
        let moveHandler;
        const last = server => {
            moveHandler = server.getCommandHandler('MOVE');
        };
        const server = hoodiecrow({ plugins: [first, 'UIDONLY', 'ACL', 'MOVE', last] });
        // the listener of the first plugin sees the commands of the plugins loaded after it
        assert.deepStrictEqual(seen, ['function']);
        // ACL wrapped MOVE and UIDONLY registered its output handler before any client connected
        assert.strictEqual(typeof moveHandler, 'function');
        assert.notStrictEqual(server.getCommandHandler('MOVE'), moveHandler);
        assert.ok(server.outputHandlers.length > 0);
    });

    describe('with repeated CONDSTORE', () => {
        const ctx = setupServer(() => ({
            plugins: ['CONDSTORE', 'CONDSTORE'],
            storage: {
                INBOX: {
                    messages: [{ raw: 'Subject: hello 1\r\n\r\nWorld 1!' }]
                }
            }
        }));

        it('SELECT (CONDSTORE) still works', (t, done) => {
            const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX (CONDSTORE)', 'A3 STORE 1 +FLAGS (\\Seen)', 'ZZ LOGOUT'];

            ctx.run(cmds, resp => {
                resp = resp.toString();
                assert.strictEqual((resp.match(/HIGHESTMODSEQ/g) || []).length, 1, resp);
                assert.ok(resp.indexOf('A2 OK [READ-WRITE] Completed, CONDSTORE is now enabled') >= 0, resp);
                assert.ok(resp.indexOf('* 1 FETCH (FLAGS (\\Seen) MODSEQ (3) UID 1)') >= 0, resp);
                done();
            });
        });
    });
});

describe('Plugin command options', () => {
    const ok = (connection, parsed, data, callback) => {
        connection.sendStatus(parsed, data, 'OK', 'Done');
        callback();
    };

    const ctx = setupServer(() => ({
        plugins: [
            server => {
                // a list of states is accepted as well
                server.setCommandHandler('XSTATES', ok, ['Authenticated', 'Selected']);
                server.setCommandHandler('XNOARGS', ok, { noArguments: true });
                server.setCommandHandler('XMAILBOX', ok, { mailboxArguments: [1] });
                // re-registering without options keeps the earlier options
                server.setCommandHandler('XNOARGS', ok);
            }
        ]
    }));

    it('applies states, no arguments and mailbox arguments', (t, done) => {
        const cmds = ['A1 XSTATES', 'A2 XNOARGS x', 'A3 XNOARGS', 'A4 XMAILBOX "a&" b', 'A5 XMAILBOX a "b&"', 'A6 XMAILBOX (x) b', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString('binary');
            assert.match(resp, /^A1 BAD XSTATES is not allowed in the Not Authenticated state\r$/m);
            assert.match(resp, /^A2 BAD XNOARGS does not take any arguments\r$/m);
            assert.match(resp, /^A3 OK Done\r$/m);
            // only the second argument is a mailbox name
            assert.match(resp, /^A4 OK Done\r$/m);
            assert.match(resp, /^A5 BAD Modified BASE64 in mailbox name must end with "-"/m);
            // arguments that are not strings are left to the handler
            assert.match(resp, /^A6 OK Done\r$/m);
            done();
        });
    });
});
