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
            name: 'hoodiecrow'
        }
    }));

    it('returns server ID', (t, done) => {
        const cmds = ['A1 ID NIL', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\n* ID ("name" "hoodiecrow")\r\nA1 OK') >= 0, resp);
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
});
