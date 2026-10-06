'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');

describe('Create', () => {
    const ctx = setupServer(() => ({
        storage: {
            '#news': {
                type: 'shared'
            }
        }
    }));

    it('Create fails - Mailbox exists', (t, done) => {
        const cmds = ['A1 CAPABILITY', 'A2 LOGIN testuser testpass', 'A3 CREATE INBOX', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA3 NO') >= 0);
            done();
        });
    });

    it('Create fails - Non-personal namespace', (t, done) => {
        const cmds = ['A1 CAPABILITY', 'A2 LOGIN testuser testpass', 'A3 CREATE #news.subfolder', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA3 NO') >= 0);
            done();
        });
    });

    it('Create success', (t, done) => {
        const cmds = ['A1 CAPABILITY', 'A2 LOGIN testuser testpass', 'A3 CREATE sub/folder/name/', 'A4 LIST "" "*"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('\n* LIST (\\HasChildren) "/" "sub"\r\n') >= 0);
            assert.ok(resp.indexOf('* LIST (\\HasChildren) "/" "sub/folder"\r\n') >= 0);
            assert.ok(resp.indexOf('* LIST (\\HasNoChildren) "/" "sub/folder/name"\r\n') >= 0);
            done();
        });
    });
});
