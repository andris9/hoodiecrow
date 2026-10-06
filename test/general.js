'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');

describe('Auth Plain disabled', () => {
    const ctx = setupServer();

    it('AUTH FAILS', (t, done) => {
        const cmds = ['A1 CAPABILITY', 'A2 AUTHENTICATE PLAIN', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf(' AUTH=PLAIN') < 0);
            assert.ok(resp.indexOf('\nA2 BAD') >= 0);
            done();
        });
    });
});

describe('Auth Plain enabled', () => {
    const ctx = setupServer(() => ({
        plugins: ['AUTH-PLAIN']
    }));

    it('NOOP', (t, done) => {
        const cmds = ['A1 NOOP', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA1 OK') >= 0);
            done();
        });
    });

    it('CHECK', (t, done) => {
        const cmds = ['A1 CHECK', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA1 OK') >= 0);
            done();
        });
    });
});
