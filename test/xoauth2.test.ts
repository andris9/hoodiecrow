import { describe, it } from 'node:test';
import assert from 'node:assert';
import { setupServer } from './helpers/index.js';

describe('XOAUTH2', () => {
    const ctx = setupServer(() => ({
        plugins: ['SASL-IR', 'XOAUTH2']
    }));

    it('Invalid argument', (t, done) => {
        // invalid base64 is a syntax error, a malformed payload is a failed login
        const cmds = [
            'A1 AUTHENTICATE XOAUTH2 zzzzz',
            'A2 AUTHENTICATE XOAUTH2 ' + Buffer.from('garbage').toString('base64'),
            'A3 AUTHENTICATE XOAUTH2 ' + Buffer.from(['user=test\xffuser', 'auth=Bearer testtoken', '', ''].join('\x01'), 'binary').toString('base64'),
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA1 BAD') >= 0);
            assert.ok(resp.indexOf('\nA2 NO') >= 0);
            // the payload is UTF-8
            assert.ok(resp.indexOf('\nA3 NO') >= 0, resp);
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

describe('XOAUTH2 edge cases', () => {
    const ctx = setupServer(() => {
        const users = Object.create(null);
        users.testuser = { password: 'testpass', xoauth2: { accessToken: 'testtoken' } };
        return { plugins: ['SASL-IR', 'XOAUTH2'], users };
    });

    it('missing initial response', (t, done) => {
        const cmds = ['A1 AUTHENTICATE XOAUTH2', 'A2 CAPABILITY', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA1 NO') >= 0, resp);
            assert.ok(resp.indexOf('\nA2 OK') >= 0, resp);
            done();
        });
    });

    it('works with a null-prototype users map', (t, done) => {
        const cmds = [
            'A1 AUTHENTICATE XOAUTH2 ' + Buffer.from(['user=toString', 'auth=Bearer zzz', '', ''].join('\x01')).toString('base64'),
            'A2 AUTHENTICATE XOAUTH2 ' + Buffer.from(['user=testuser', 'auth=Bearer testtoken', '', ''].join('\x01')).toString('base64'),
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA1 NO') >= 0, resp);
            assert.ok(resp.indexOf('\nA2 OK') >= 0, resp);
            done();
        });
    });
});

// xoauth2.sessionTimeout is deprecated and ignored: access tokens do not expire, a test changes the token with
// control.updateUser() to see how a client handles an expired one
describe('XOAUTH2 sessionTimeout', () => {
    const ctx = setupServer(() => ({
        plugins: ['SASL-IR', 'XOAUTH2'],
        users: { alice: { xoauth2: { accessToken: 'alice-token', sessionTimeout: 1 } } }
    }));
    const auth = (token: string) => 'AUTHENTICATE XOAUTH2 ' + Buffer.from(['user=alice', 'auth=Bearer ' + token, '', ''].join('\x01')).toString('base64');

    it('does not expire the access token', (t, done) => {
        setTimeout(() => {
            ctx.run(['A1 ' + auth('alice-token'), 'ZZ LOGOUT'], resp => {
                assert.match(resp.toString(), /^A1 OK/m);
                done();
            });
        }, 20);
    });

    it('a replaced token fails like an expired one', (t, done) => {
        ctx.server.control.updateUser('alice', { xoauth2: { accessToken: 'fresh-token' } });
        ctx.run(['A1 ' + auth('alice-token'), '', 'A2 ' + auth('fresh-token'), 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.match(resp, /^A1 NO \[AUTHENTICATIONFAILED\]/m);
            assert.match(resp, /^A2 OK/m);
            done();
        });
    });
});
