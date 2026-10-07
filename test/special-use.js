'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');

describe('Special-use', () => {
    const ctx = setupServer(() => ({
        plugins: ['SPECIAL-USE'],
        id: {
            name: 'hoodiecrow',
            version: '0.1'
        },
        storage: {
            '': {
                folders: {
                    INBOX: {
                        'special-use': '\\Inbox',
                        messages: []
                    },
                    Test: {
                        subscribed: false
                    },
                    'Sent mail': {
                        'special-use': ['\\Sent', '\\Drafts'],
                        subscribed: false
                    }
                }
            },
            '#news.': {
                type: 'shared',
                separator: '.',
                folders: {
                    world: {}
                }
            },
            '#juke?': {
                type: 'shared',
                separator: '?'
            }
        }
    }));

    it('LIST NORMAL', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 CAPABILITY', 'A3 LIST "" "*"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.equal((resp.match(/^\* LIST\b/gm) || []).length, 3);
            assert.ok(resp.indexOf('\n* LIST (\\HasNoChildren) "/" "INBOX"\r\n') >= 0);
            assert.ok(resp.indexOf('\n* LIST (\\HasNoChildren) "/" "Test"\r\n') >= 0);
            assert.ok(resp.indexOf('\n* LIST (\\HasNoChildren \\Sent \\Drafts) "/" "Sent mail"\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('LIST (SPECIAL-USE)', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 CAPABILITY', 'A3 LIST (SPECIAL-USE) "" "*"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.equal((resp.match(/^\* LIST\b/gm) || []).length, 1);
            assert.ok(resp.indexOf('\n* LIST (\\HasNoChildren \\Sent \\Drafts) "/" "Sent mail"\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('LIST RETURN (SPECIAL-USE)', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 CAPABILITY', 'A3 LIST "" "*" RETURN (SPECIAL-USE)', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.equal((resp.match(/^\* LIST\b/gm) || []).length, 3);
            assert.ok(resp.indexOf('\n* LIST (\\HasNoChildren) "/" "INBOX"\r\n') >= 0);
            assert.ok(resp.indexOf('\n* LIST (\\HasNoChildren) "/" "Test"\r\n') >= 0);
            assert.ok(resp.indexOf('\n* LIST (\\HasNoChildren \\Sent \\Drafts) "/" "Sent mail"\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('LIST (SPECIAL-USE) RETURN (SPECIAL-USE)', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 CAPABILITY', 'A3 LIST (SPECIAL-USE) "" "*" RETURN (SPECIAL-USE)', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.equal((resp.match(/^\* LIST\b/gm) || []).length, 1);
            assert.ok(resp.indexOf('\n* LIST (\\HasNoChildren \\Sent \\Drafts) "/" "Sent mail"\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });
});

describe('No Special-use', () => {
    const ctx = setupServer(() => ({
        storage: {
            '': {
                folders: {
                    INBOX: {
                        'special-use': '\\Inbox',
                        messages: []
                    },
                    Test: {
                        subscribed: false
                    },
                    'Sent mail': {
                        'special-use': ['\\Sent', '\\Drafts'],
                        subscribed: false
                    }
                }
            },
            '#news.': {
                type: 'shared',
                separator: '.',
                folders: {
                    world: {}
                }
            },
            '#juke?': {
                type: 'shared',
                separator: '?'
            }
        }
    }));

    it('LIST NORMAL', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 CAPABILITY', 'A3 LIST "" "*"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.equal((resp.match(/^\* LIST\b/gm) || []).length, 3);
            assert.ok(resp.indexOf('\n* LIST (\\HasNoChildren) "/" "INBOX"\r\n') >= 0);
            assert.ok(resp.indexOf('\n* LIST (\\HasNoChildren) "/" "Test"\r\n') >= 0);
            assert.ok(resp.indexOf('\n* LIST (\\HasNoChildren) "/" "Sent mail"\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('LIST (SPECIAL-USE)', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 CAPABILITY', 'A3 LIST (SPECIAL-USE) "" "*"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA3 BAD') >= 0);
            done();
        });
    });

    it('LIST RETURN (SPECIAL-USE)', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 CAPABILITY', 'A3 LIST "" "*" RETURN (SPECIAL-USE)', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA3 BAD') >= 0);
            done();
        });
    });

    it('LIST (SPECIAL-USE) RETURN (SPECIAL-USE)', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 CAPABILITY', 'A3 LIST (SPECIAL-USE) "" "*" RETURN (SPECIAL-USE)', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA3 BAD') >= 0);
            done();
        });
    });
});
