import { describe, it } from 'node:test';
import assert from 'node:assert';
import { setupServer } from './helpers/index.js';

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

    // RFC 5530 section 3: CANNOT, its example is a name with adjacent separators
    it('Create fails - Empty hierarchy level', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 CREATE a//b', 'A3 CREATE /a', 'A4 CREATE a//', 'A5 CREATE b', 'A6 RENAME b /c', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            for (const tag of ['A2', 'A3', 'A4', 'A6']) {
                assert.match(resp, new RegExp('^' + tag + ' NO \\[CANNOT\\] ', 'm'));
            }
            assert.ok(ctx.server.getMailbox('b'));
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
