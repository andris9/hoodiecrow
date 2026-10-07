'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');
const { openSession } = require('./helpers/session');

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
    function afterForeignExpunge(command, callback) {
        const port = ctx.server.address().port;
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

    it('UID FETCH uses the session snapshot while EXPUNGE is pending', (t, done) => {
        afterForeignExpunge('A3 UID FETCH 3 (FLAGS)', resp => {
            assert.ok(resp.indexOf('* 3 FETCH (FLAGS () UID 3)\r\n* 1 EXPUNGE\r\n') >= 0, resp);
            assert.ok(resp.indexOf('\r\nA3 OK') >= 0);
            done();
        });
    });

    it('UID STORE uses the session snapshot while EXPUNGE is pending', (t, done) => {
        afterForeignExpunge('A3 UID STORE 3 +FLAGS (\\Flagged)', resp => {
            assert.ok(resp.indexOf('* 3 FETCH (FLAGS (\\Flagged) UID 3') >= 0, resp);
            assert.ok(resp.indexOf('* 1 EXPUNGE\r\n') >= 0);
            assert.ok(resp.indexOf('\r\nA3 OK') >= 0);
            done();
        });
    });

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
