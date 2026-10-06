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

    it('Invalid Login', (t, done) => {
        const cmds = ['A1 CAPABILITY', 'A2 AUTHENTICATE PLAIN', Buffer.from('\x00wrong\x00pass', 'utf-8').toString('base64'), 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf(' AUTH=PLAIN') >= 0);
            assert.ok(resp.indexOf('\nA2 NO') >= 0);
            done();
        });
    });

    it('Login Success', (t, done) => {
        const cmds = ['A1 CAPABILITY', 'A2 AUTHENTICATE PLAIN', Buffer.from('\x00testuser\x00testpass', 'utf-8').toString('base64'), 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA2 OK') >= 0);
            done();
        });
    });

    it('Invalid SASL-IR Login', (t, done) => {
        const cmds = ['A1 CAPABILITY', 'A2 AUTHENTICATE PLAIN ' + Buffer.from('\x00testuser\x00testpass', 'utf-8').toString('base64'), 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf(' AUTH=PLAIN') >= 0);
            assert.ok(!resp.match(/^\* CAPABILITY\b.*?\bSASL-IR\b/m));
            assert.ok(resp.indexOf('\nA2 BAD') >= 0);
            done();
        });
    });
});

describe('Auth Plain with SASL-IR', () => {
    const ctx = setupServer(() => ({
        plugins: ['SASL-IR', 'AUTH-PLAIN']
    }));

    it('Invalid Login', (t, done) => {
        const cmds = ['A1 CAPABILITY', 'A2 AUTHENTICATE PLAIN ' + Buffer.from('\x00wrong\x00pass', 'utf-8').toString('base64'), 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.match(/^\* CAPABILITY\b.*?\bSASL-IR\b/m));
            assert.ok(resp.indexOf(' AUTH=PLAIN') >= 0);
            assert.ok(resp.indexOf('\nA2 NO') >= 0);
            done();
        });
    });

    it('Login Success', (t, done) => {
        const cmds = ['A1 CAPABILITY', 'A2 AUTHENTICATE PLAIN', Buffer.from('\x00testuser\x00testpass', 'utf-8').toString('base64'), 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.match(/^\* CAPABILITY\b.*?\bSASL-IR\b/m));
            assert.ok(resp.indexOf('\nA2 OK') >= 0);
            done();
        });
    });

    it('Successful SASL-IR Login', (t, done) => {
        const cmds = ['A1 CAPABILITY', 'A2 AUTHENTICATE PLAIN ' + Buffer.from('\x00testuser\x00testpass', 'utf-8').toString('base64'), 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf(' AUTH=PLAIN') >= 0);
            assert.ok(resp.match(/^\* CAPABILITY\b.*?\bSASL-IR\b/m));
            assert.ok(resp.indexOf('\nA2 OK') >= 0);
            done();
        });
    });
});
