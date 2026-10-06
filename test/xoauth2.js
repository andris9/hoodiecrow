'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');

describe('XOAUTH2', () => {
    const ctx = setupServer(() => ({
        plugins: ['SASL-IR', 'XOAUTH2']
    }));

    it('Invalid argument', (t, done) => {
        const cmds = ['A1 AUTHENTICATE XOAUTH2 zzzzz', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA1 NO') >= 0);
            done();
        });
    });

    it('Unknown user', (t, done) => {
        const cmds = ['A1 AUTHENTICATE XOAUTH2 ' + Buffer.from(['user=unknown', 'auth=Bearer zzz', '', ''].join('\x01')).toString('base64'), 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA1 NO') >= 0);
            done();
        });
    });

    it('Known user, invalid token', (t, done) => {
        const cmds = ['A1 AUTHENTICATE XOAUTH2 ' + Buffer.from(['user=testuser', 'auth=Bearer zzz', '', ''].join('\x01')).toString('base64'), '', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA1 NO') >= 0);
            assert.ok(resp.indexOf('\r\n+ eyJzdGF0dXMiOiI0MDAiLCJzY2hlbWVzIjoiQmVhcmVyIiwic2NvcGUiOiJodHRwczovL21haWwuZ29vZ2xlLmNvbS8ifQ==\r\n') >= 0);
            done();
        });
    });

    it('Login success', (t, done) => {
        const cmds = [
            'A1 AUTHENTICATE XOAUTH2 ' + Buffer.from(['user=testuser', 'auth=Bearer testtoken', '', ''].join('\x01')).toString('base64'),
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA1 OK') >= 0);
            done();
        });
    });
});
