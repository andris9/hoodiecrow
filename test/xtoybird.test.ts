import { describe, it } from 'node:test';
import assert from 'node:assert';
import { setupServer } from './helpers/index.js';

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
            assert.ok(resp.indexOf('\nA1 BAD') >= 0, resp);
            assert.ok(resp.indexOf('\nA2 BAD') >= 0, resp);
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
            assert.strictEqual(({} as Record<string, unknown>).password, undefined);
            assert.strictEqual((Object.prototype.toString as unknown as Record<string, unknown>).password, undefined);
            assert.strictEqual((Object as unknown as Record<string, unknown>).password, undefined);
            assert.strictEqual(Object.getPrototypeOf(ctx.server.users), null);
            assert.ok(Object.hasOwn(ctx.server.users, '__proto__'));
            done();
        });
    });
});

describe('XTOYBIRD with ACL', () => {
    const ctx = setupServer(() => ({
        plugins: ['XTOYBIRD', 'ACL'],
        users: {
            testuser: { password: 'testpass' },
            bob: { password: 'bobpass' }
        }
    }));

    // XTOYBIRD skips the access checks of ACL, so only the owner may use it
    it('is only allowed for the owner', (t, done) => {
        const cmds = ['A1 LOGIN bob bobpass', 'A2 XTOYBIRD STORAGE', 'A3 XTOYBIRD USERADD eve evepass', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.match(resp, /^A2 NO \[NOPERM\] /m);
            assert.match(resp, /^A3 NO \[NOPERM\] /m);
            assert.doesNotMatch(resp, /XDUMPVAL/);
            assert.ok(!Object.hasOwn(ctx.server.users, 'eve'));
            ctx.run(['A1 LOGIN testuser testpass', 'A2 XTOYBIRD STORAGE', 'ZZ LOGOUT'], resp => {
                assert.match(resp.toString(), /^A2 OK /m);
                done();
            });
        });
    });
});
