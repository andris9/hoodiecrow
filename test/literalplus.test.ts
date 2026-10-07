import { describe, it } from 'node:test';
import assert from 'node:assert';
import { setupServer } from './helpers/index.js';

describe('Literalplus disabled', () => {
    const ctx = setupServer();

    it('Invalid Login', (t, done) => {
        const cmds = ['A1 CAPABILITY', 'A2 LOGIN {8+}\r\ntestuser {8+}\r\ntestpass', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf(' LITERAL+') < 0);
            assert.ok(resp.indexOf('\nA2 BAD') >= 0);
            done();
        });
    });
});

describe('Literalplus enabled', () => {
    const ctx = setupServer(() => ({
        plugins: 'literalplus'
    }));

    it('Login success regular', (t, done) => {
        const cmds = ['A1 CAPABILITY', 'A2 LOGIN {8}\r\ntestuser {8}\r\ntestpass', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\n+') >= 0);
            assert.ok(resp.indexOf(' LITERAL+') >= 0);
            assert.ok(resp.indexOf('\nA2 OK') >= 0);
            done();
        });
    });

    it('Login success literalplus', (t, done) => {
        const cmds = ['A1 CAPABILITY', 'A2 LOGIN {8+}\r\ntestuser {8+}\r\ntestpass', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\n+') < 0);
            assert.ok(resp.indexOf(' LITERAL+') >= 0);
            assert.ok(resp.indexOf('\nA2 OK') >= 0);
            done();
        });
    });
});
