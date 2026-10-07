import { describe, it } from 'node:test';
import assert from 'node:assert';
import { setupServer } from './helpers/index.js';
import { openSession } from './helpers/session.js';

describe('UID commands share the logic of their non-UID twins', () => {
    const ctx = setupServer(() => ({
        plugins: ['ENABLE', 'CONDSTORE'],
        storage: {
            INBOX: {
                messages: [
                    { raw: 'Subject: hello 1\r\n\r\nWorld 1!' },
                    { raw: 'Subject: hello 2\r\n\r\nWorld 2!' },
                    { raw: 'Subject: hello 3\r\n\r\nWorld 3!' }
                ]
            }
        }
    }));

    // Session A selects INBOX, session B expunges message 1, then session A runs `command`
    function afterForeignExpunge(command: string, callback: (output: string) => void) {
        const port = ctx.port;
        openSession(port, a => {
            a.run('A1 LOGIN testuser testpass', () => {
                a.run('A2 SELECT INBOX', () => {
                    openSession(port, b => {
                        b.run('B1 LOGIN testuser testpass', () => {
                            b.run('B2 SELECT INBOX', () => {
                                b.run('B3 STORE 1 +FLAGS.SILENT (\\Deleted)', () => {
                                    b.run('B4 EXPUNGE', () => {
                                        b.close();
                                        a.run(command, resp => {
                                            a.close();
                                            callback(resp);
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    }

    // RFC 3501 section 7.4.1 allows EXPUNGE during UID commands, the pending one is reported before the FETCH
    // responses that use the new numbers (RFC 2180 section 4, see test/multi-access.test.ts)
    it('UID FETCH reports a pending EXPUNGE first', (t, done) => {
        afterForeignExpunge('A3 UID FETCH 1,3 (FLAGS)', resp => {
            assert.ok(resp.indexOf('* 1 EXPUNGE\r\n* 2 EXISTS\r\n* 2 FETCH (FLAGS () UID 3)\r\nA3 OK') === 0, resp);
            done();
        });
    });

    it('UID STORE reports a pending EXPUNGE first', (t, done) => {
        afterForeignExpunge('A3 UID STORE 1,3 +FLAGS (\\Flagged)', resp => {
            assert.ok(resp.indexOf('* 1 EXPUNGE\r\n* 2 EXISTS\r\n* 2 FETCH (FLAGS (\\Flagged) UID 3)\r\nA3 OK') === 0, resp);
            done();
        });
    });

    // message numbers in UID SEARCH criteria refer to the messages before the EXPUNGE (RFC 9051 section 5.5)
    it('UID SEARCH uses the session snapshot while EXPUNGE is pending', (t, done) => {
        afterForeignExpunge('A3 UID SEARCH 1:3', resp => {
            assert.ok(resp.indexOf('* SEARCH 1 2 3\r\n') >= 0, resp);
            assert.ok(resp.indexOf('\r\nA3 OK') >= 0);
            done();
        });
    });

    it('UID FETCH honors CHANGEDSINCE', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 SELECT INBOX',
            'A3 STORE 2 +FLAGS.SILENT (\\Flagged)',
            'A4 UID FETCH 1:* (FLAGS) (CHANGEDSINCE 4)',
            'ZZ LOGOUT'
        ];
        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('* 2 FETCH (FLAGS (\\Flagged) MODSEQ (5) UID 2)') >= 0, resp);
            assert.ok(resp.indexOf('* 1 FETCH') < 0);
            assert.ok(resp.indexOf('* 3 FETCH') < 0);
            assert.ok(resp.indexOf('\nA4 OK') >= 0);
            done();
        });
    });
});
