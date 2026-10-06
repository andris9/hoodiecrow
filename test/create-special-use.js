'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');

describe('Create', () => {
    const ctx = setupServer(() => ({
        plugins: ['SPECIAL-USE', 'CREATE-SPECIAL-USE']
    }));

    it('Create success', (t, done) => {
        const cmds = [
            'A1 CAPABILITY',
            'A2 LOGIN testuser testpass',
            'A3 CREATE MySpecial (USE (\\Sent \\Flagged))',
            'A4 LIST (SPECIAL-USE) "" "*"',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('\n* LIST (\\HasNoChildren \\Sent \\Flagged) "/" "MySpecial"\r\n') >= 0);
            done();
        });
    });

    it('Create fails', (t, done) => {
        const cmds = ['A1 CAPABILITY', 'A2 LOGIN testuser testpass', 'A3 CREATE MySpecial (USE (\\NotAllowed))', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA3 NO') >= 0);
            done();
        });
    });
});
