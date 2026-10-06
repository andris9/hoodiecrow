'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');

describe('Delete', () => {
    const ctx = setupServer(() => ({
        plugins: 'XTOYBIRD',
        storage: {
            '': {
                folders: {
                    testfold: {
                        uidnext: 234,
                        folders: {
                            sub: {
                                uidnext: 567
                            }
                        }
                    }
                }
            },
            '#news.': {
                type: 'shared',
                separator: '.'
            },
            '#juke?': {
                type: 'shared',
                separator: '?'
            }
        }
    }));

    it('Delete success', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 DELETE testfold/sub', 'C1 LIST "" "*"', 'A3 DELETE testfold', 'C2 LIST "" "*"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA2 OK') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('Delete parent', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A3 DELETE testfold',
            'C1 LIST "" "*"',
            'A4 DELETE testfold',
            'C2 LIST "" "*"',
            'A4 DELETE testfold/sub',
            'C2 LIST "" "*"',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('\nA4 NO') >= 0);
            done();
        });
    });
});
