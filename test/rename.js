'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');

describe('Rename', () => {
    const ctx = setupServer(() => ({
        plugins: 'XTOYBIRD',
        storage: {
            '': {
                folders: {
                    level1: {
                        folders: {
                            level2: {
                                folders: {
                                    level3: {
                                        folders: {
                                            level4: {
                                                folders: {}
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    },
                    level5: {
                        folders: {
                            level6: {
                                folders: {}
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

    it('Rename success', (t, done) => {
        const cmds = ['A1 CAPABILITY', 'A2 LOGIN testuser testpass', 'A3 RENAME level1/level2 level5/level2', 'A4 LIST "" "*"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('\r\n* LIST (\\HasNoChildren) "/" "level1"\r\n') >= 0);
            assert.ok(resp.indexOf('\r\n* LIST (\\HasNoChildren) "/" "level5/level2/level3/level4"\r\n') >= 0);
            done();
        });
    });
});
