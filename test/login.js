'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

describe('Normal login', () => {
    const ctx = setupServer();

    it('Invalid Login', (t, done) => {
        const cmds = ['A1 CAPABILITY', 'A2 LOGIN wrong pass', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf(' LOGINDISABLED') < 0);
            assert.ok(resp.indexOf('\nA2 NO') >= 0);
            done();
        });
    });

    it('Successful login', (t, done) => {
        const cmds = ['A1 CAPABILITY', 'A2 LOGIN testuser testpass', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf(' LOGINDISABLED') < 0);
            assert.ok(resp.indexOf('\nA2 OK') >= 0);
            done();
        });
    });
});

describe('LOGINDISABLED', () => {
    const ctx = setupServer(() => ({
        plugins: ['STARTTLS', 'LOGINDISABLED']
    }));

    it('Unencrypted login fail', (t, done) => {
        const cmds = ['A1 CAPABILITY', 'A2 LOGIN testuser testpass', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf(' LOGINDISABLED') >= 0);
            assert.ok(resp.indexOf('\nA2 BAD') >= 0);
            done();
        });
    });

    it('Successful TLS login', (t, done) => {
        const cmds = ['A1 CAPABILITY', 'A2 STARTTLS', 'A3 LOGIN testuser testpass', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf(' LOGINDISABLED') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('LOGINDISABLED missing after STARTTLS', (t, done) => {
        const cmds = ['A1 STARTTLS', 'A2 CAPABILITY', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf(' LOGINDISABLED') < 0);
            done();
        });
    });
});
