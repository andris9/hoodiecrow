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
                assert.ok(resp.indexOf('* 1 FETCH (FLAGS (\\Seen) MODSEQ (3))') >= 0, resp);
                done();
            });
        });
    });
});
