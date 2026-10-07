'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');

describe('XTOYBIRD', () => {
    const ctx = setupServer(() => ({
        plugins: ['XTOYBIRD'],
        users: {
            testuser: {
                password: 'testpass'
            }
        }
    }));

    it('requires login', (t, done) => {
        const cmds = ['A1 XTOYBIRD USERADD foo bar', 'A2 XTOYBIRD SHUTDOWN', 'A3 LOGIN foo bar', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA1 NO') >= 0, resp);
            assert.ok(resp.indexOf('\nA2 NO') >= 0, resp);
            assert.ok(resp.indexOf('\nA3 NO') >= 0, resp);
            assert.ok(!Object.hasOwn(ctx.server.users, 'foo'));
            assert.ok(ctx.server.server.listening);
            done();
        });
    });

    it('USERADD and USERDEL', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 XTOYBIRD USERADD foo bar', 'A3 XTOYBIRD USERADD foo baz', 'A4 XTOYBIRD USERDEL foo', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf("* XTOYBIRD [XUSER] User 'foo' added successfully\r\nA2 OK") >= 0, resp);
            assert.ok(resp.indexOf("* XTOYBIRD [XUSER] User 'foo' updated successfully\r\nA3 OK") >= 0, resp);
            assert.ok(resp.indexOf("* XTOYBIRD [XUSER] Removing user 'foo' succeeded\r\nA4 OK") >= 0, resp);
            assert.ok(!Object.hasOwn(ctx.server.users, 'foo'));
            done();
        });
    });

    it('USERADD with missing arguments returns BAD', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 XTOYBIRD USERADD', 'A3 XTOYBIRD USERADD foo', 'A4 XTOYBIRD USERDEL', 'A5 NOOP', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA2 BAD') >= 0, resp);
            assert.ok(resp.indexOf('\nA3 BAD') >= 0, resp);
            assert.ok(resp.indexOf('\nA4 BAD') >= 0, resp);
            assert.ok(resp.indexOf('\nA5 OK') >= 0, resp);
            done();
        });
    });

    it('USERADD does not pollute prototypes', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 XTOYBIRD USERADD __proto__ pwned',
            'A3 XTOYBIRD USERADD toString pwned',
            'A4 XTOYBIRD USERADD constructor pwned',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA2 OK') >= 0, resp);
            assert.ok(resp.indexOf('\nA4 OK') >= 0, resp);
            assert.strictEqual({}.password, undefined);
            assert.strictEqual(Object.prototype.toString.password, undefined);
            assert.strictEqual(Object.password, undefined);
            assert.strictEqual(Object.getPrototypeOf(ctx.server.users), null);
            assert.ok(Object.hasOwn(ctx.server.users, '__proto__'));
            done();
        });
    });
});
