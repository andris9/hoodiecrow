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
            // an unsupported mechanism gets NO (RFC 3501 section 6.2.2)
            assert.ok(resp.indexOf('\nA2 NO') >= 0);
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

describe('Auth Plain exchange', () => {
    const ctx = setupServer(() => ({
        plugins: ['SASL-IR', 'AUTH-PLAIN']
    }));

    it('sends a continuation request with a space', (t, done) => {
        const cmds = ['A1 AUTHENTICATE PLAIN', Buffer.from('\x00testuser\x00testpass', 'utf-8').toString('base64'), 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\n+ \r\n') >= 0, resp);
            assert.ok(resp.indexOf('\nA1 OK') >= 0, resp);
            done();
        });
    });

    it('cancelling returns BAD', (t, done) => {
        const cmds = ['A1 AUTHENTICATE PLAIN', '*', 'A2 CAPABILITY', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA1 BAD') >= 0, resp);
            assert.ok(resp.indexOf('\nA2 OK') >= 0, resp);
            done();
        });
    });

    it('rejects a different authorization identity', (t, done) => {
        const cmds = ['A1 AUTHENTICATE PLAIN ' + Buffer.from('other\x00testuser\x00testpass', 'utf-8').toString('base64'), 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA1 NO') >= 0, resp);
            done();
        });
    });

    it('accepts the same authorization identity', (t, done) => {
        const cmds = ['A1 AUTHENTICATE PLAIN ' + Buffer.from('testuser\x00testuser\x00testpass', 'utf-8').toString('base64'), 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA1 OK') >= 0, resp);
            done();
        });
    });

    it('failed login keeps the connection usable', (t, done) => {
        const cmds = ['A1 AUTHENTICATE PLAIN', Buffer.from('\x00testuser\x00wrong', 'utf-8').toString('base64'), 'A2 LOGIN testuser testpass', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA1 NO') >= 0, resp);
            assert.ok(resp.indexOf('\nA2 OK') >= 0, resp);
            done();
        });
    });
});

describe('Auth Plain with a null-prototype users map', () => {
    const ctx = setupServer(() => {
        const users = Object.create(null);
        users.testuser = { password: 'testpass' };
        return { plugins: ['SASL-IR', 'AUTH-PLAIN'], users };
    });

    it('Login Success', (t, done) => {
        const cmds = ['A1 AUTHENTICATE PLAIN ' + Buffer.from('\x00testuser\x00testpass', 'utf-8').toString('base64'), 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA1 OK') >= 0, resp);
            done();
        });
    });
});
