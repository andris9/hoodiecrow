import { describe, it } from 'node:test';
import assert from 'node:assert';
import { setupServer } from './helpers/index.js';

describe('ImapKit tests', () => {
    const ctx = setupServer(() => ({
        plugins: 'UNSELECT',
        id: {
            name: 'imapkit',
            version: '0.1'
        },
        storage: {
            INBOX: {
                messages: [
                    {
                        raw: 'Subject: hello 1\r\n\r\nWorld 1!',
                        internaldate: '14-Sep-2013 21:22:28 -0300',
                        flags: '\\Deleted'
                    }
                ]
            }
        }
    }));

    it('CLOSE and \\Deleted', (t, done) => {
        const cmds = ['A1 CAPABILITY', 'A2 LOGIN testuser testpass', 'A3 SELECT INBOX', 'A4 EXPUNGE', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\n* 1 EXPUNGE\r\n') >= 0);
            assert.ok(resp.indexOf('\r\n* 0 EXISTS\r\n') < 0);
            done();
        });
    });
});
