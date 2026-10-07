'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');

describe('ID', () => {
    let clientList;
    const ctx = setupServer(() => ({
        plugins: [
            'ID',
            server => {
                server.outputHandlers.push((connection, response, description, parsed, data, extra) => {
                    if (description === 'ID' && response.tag === '*') {
                        clientList = extra;
                    }
                });
            }
        ],
        id: {
            name: 'imapkit'
        }
    }));

    it('returns server ID', (t, done) => {
        const cmds = ['A1 ID NIL', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\n* ID ("name" "imapkit")\r\nA1 OK') >= 0, resp);
            done();
        });
    });

    it('stores client supplied keys safely', (t, done) => {
        const cmds = ['A1 ID ("__proto__" "x" "name" "client")', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA1 OK') >= 0, resp);
            assert.strictEqual(clientList.name, 'client');
            assert.ok(Object.hasOwn(clientList, '__proto__'));
            assert.strictEqual(clientList['__proto__'], 'x');
            done();
        });
    });

    it('rejects an odd parameter list', (t, done) => {
        const cmds = ['A1 ID ("name")', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA1 BAD') >= 0, resp);
            done();
        });
    });

    // RFC 2971 section 3.3
    it('refuses ID lists that break the RFC 2971 limits', (t, done) => {
        const pairs = [];
        for (let i = 0; i < 31; i++) {
            pairs.push('"f' + i + '" "v"');
        }
        const cmds = [
            'A1 ID ("' + 'x'.repeat(31) + '" "v")',
            'A2 ID ("name" "' + 'v'.repeat(1025) + '")',
            'A3 ID (' + pairs.join(' ') + ')',
            'A4 ID ("name" "a" "NAME" "b")',
            'A5 ID ("' + 'x'.repeat(30) + '" "' + 'v'.repeat(1024) + '")',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(/^A1 BAD/m.test(resp), resp);
            assert.ok(/^A2 BAD/m.test(resp), resp);
            assert.ok(/^A3 BAD/m.test(resp), resp);
            assert.ok(/^A4 BAD/m.test(resp), resp);
            assert.ok(/^A5 OK/m.test(resp), resp);
            done();
        });
    });
});
