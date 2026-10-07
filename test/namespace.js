'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');

describe('NAMESPACE', () => {
    const ctx = setupServer(() => ({
        plugins: ['NAMESPACE'],
        storage: {
            INBOX: {
                type: 'personal'
            },
            '': {
                separator: '/'
            },
            '#news.': {
                type: 'shared',
                separator: '.'
            },
            '#users/': {
                type: 'user',
                separator: '/'
            }
        }
    }));

    it('lists namespaces without INBOX', (t, done) => {
        const cmds = ['A1 NAMESPACE', 'A2 LOGIN testuser testpass', 'A3 NAMESPACE', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA1 NO') >= 0, resp);
            assert.ok(resp.indexOf('\r\n* NAMESPACE (("" "/")) (("#users/" "/")) (("#news." "."))\r\nA3 OK') >= 0, resp);
            done();
        });
    });
});
