import { describe, it } from 'node:test';
import assert from 'node:assert';
import { setupServer } from './helpers/index.js';
import type { Mailbox } from '../src/types.js';

describe('SELECT and EXAMINE', () => {
    const ctx = setupServer(() => ({
        plugins: [
            server => {
                // simulates another session expunging the first message
                server.setCommandHandler('XOTHEREXPUNGE', (connection, parsed, data, callback) => {
                    const mailbox = connection.selectedMailbox as Mailbox;
                    connection.expungeSpecificMessages(mailbox, [mailbox.messages[0]]);
                    // marked as a notification, so the pending EXPUNGE is not flushed with it
                    connection.send({ tag: parsed.tag, command: 'OK', notification: true, attributes: [{ type: 'TEXT', value: 'done' }] }, 'XOTHEREXPUNGE');
                    callback();
                });
            }
        ],
        storage: {
            INBOX: {
                messages: [
                    { raw: 'Subject: hello 1\r\n\r\nWorld 1!', flags: ['\\Seen'] },
                    { raw: 'Subject: hello 2\r\n\r\nWorld 2!', flags: ['\\Recent'] },
                    { raw: 'Subject: hello 3\r\n\r\nWorld 3!', flags: ['\\Deleted', '\\Seen'] }
                ]
            },
            '': {
                folders: {
                    Other: {}
                }
            }
        }
    }));

    it('SELECT reports UNSEEN', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\n* OK [UNSEEN 2] First unseen message\r\n') >= 0);
            assert.ok(resp.indexOf('\r\nA2 OK [READ-WRITE]') >= 0);
            done();
        });
    });

    // RFC 3501 sections 2.3.2 and 7.2.6: a keyword the client defined stays applicable for the mailbox
    it('keeps listing a keyword after the last message with it is gone', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 SELECT Other',
            'A3 APPEND Other ($Appended) {1}\r\na',
            'A4 APPEND Other {1}\r\nb',
            'A5 STORE 2 +FLAGS ($Stored)',
            'A6 STORE 1:2 FLAGS (\\Deleted)',
            'A7 EXPUNGE',
            'A8 SELECT Other',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            const select = resp.slice(resp.indexOf('A7 OK'));
            assert.match(select, /^\* FLAGS \(\\Answered \\Flagged \\Draft \\Deleted \\Seen \$Appended \$Stored\)\r$/m);
            assert.match(select, /^\* OK \[PERMANENTFLAGS \(\\Answered \\Flagged \\Draft \\Deleted \\Seen \$Appended \$Stored \\\*\)\]/m);
            assert.match(select, /^\* 0 EXISTS\r$/m);
            done();
        });
    });

    it('Failed SELECT returns NO and leaves no mailbox selected', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SELECT missing', 'A4 FETCH 1 FLAGS', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\nA3 NO [NONEXISTENT]') >= 0);
            assert.ok(resp.indexOf('\r\nA4 BAD') >= 0);
            done();
        });
    });

    it('SELECT of a prototype key fails cleanly', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT toString', 'A3 STATUS constructor (MESSAGES)', 'A4 NOOP', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\nA2 NO [NONEXISTENT]') >= 0);
            assert.ok(resp.indexOf('\r\nA3 NO [NONEXISTENT]') >= 0);
            assert.ok(resp.indexOf('\r\nA4 OK') >= 0);
            done();
        });
    });

    it('EXAMINE is read-only', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 EXAMINE INBOX', 'A3 EXPUNGE', 'A4 STORE 1 +FLAGS (\\Seen)', 'A5 CLOSE', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\n* OK [PERMANENTFLAGS ()] No permanent flags permitted\r\n') >= 0);
            assert.ok(resp.indexOf('\r\nA2 OK [READ-ONLY]') >= 0);
            // RFC 5530 section 3: changing a mailbox that was selected read-only is a client bug
            assert.match(resp, /^A3 NO \[CLIENTBUG\] Mailbox is read-only\r$/m);
            assert.match(resp, /^A4 NO \[CLIENTBUG\] Mailbox is read-only\r$/m);
            assert.ok(resp.indexOf('\r\nA5 OK') >= 0);
            assert.ok(resp.indexOf('EXPUNGE\r\n') < 0);
            assert.strictEqual(ctx.server.getMailbox('INBOX')!.messages.length, 3);
            done();
        });
    });

    it('\\Recent belongs to the first session that selects the mailbox', (t, done) => {
        ctx.run(['A1 LOGIN testuser testpass', 'A2 STATUS INBOX (RECENT)', 'A3 SELECT INBOX', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\n* STATUS INBOX (RECENT 1)\r\n') >= 0);
            assert.ok(resp.indexOf('\r\n* 1 RECENT\r\n') >= 0);
            // \Recent is not a stored flag
            assert.ok(resp.indexOf('PERMANENTFLAGS (\\Answered \\Flagged \\Draft \\Deleted \\Seen \\*)') >= 0);
            assert.ok(ctx.server.getMailbox('INBOX')!.messages.every(message => message.flags.indexOf('\\Recent') < 0));

            ctx.run(['B1 LOGIN testuser testpass', 'B2 SELECT INBOX', 'ZZ LOGOUT'], resp => {
                resp = resp.toString();
                assert.ok(resp.indexOf('\r\n* 0 RECENT\r\n') >= 0);
                done();
            });
        });
    });

    it('CLOSE does not send pending EXPUNGE responses', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 XOTHEREXPUNGE', 'A4 CLOSE', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('* 1 EXPUNGE') < 0);
            assert.ok(resp.indexOf('\r\nA4 OK') >= 0);
            // the \Deleted message is removed as well
            assert.strictEqual(ctx.server.getMailbox('INBOX')!.messages.length, 1);
            done();
        });
    });

    it('APPEND to the selected mailbox sends EXISTS', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 APPEND INBOX {13}\r\nSubject: test', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\n* 4 EXISTS\r\nA3 OK') >= 0);
            done();
        });
    });
});

describe('Mailbox targets', () => {
    const ctx = setupServer(() => ({
        storage: {
            INBOX: {
                messages: [{ raw: 'Subject: hello 1\r\n\r\nWorld 1!' }]
            },
            '': {
                folders: {
                    Parent: {
                        flags: ['\\Noselect'],
                        folders: {
                            Child: {}
                        }
                    },
                    Target: {}
                }
            }
        }
    }));

    it('COPY to a missing mailbox returns TRYCREATE', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 COPY 1 missing', 'A4 UID COPY 1 missing', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\nA3 NO [TRYCREATE]') >= 0);
            assert.ok(resp.indexOf('\r\nA4 NO [TRYCREATE]') >= 0);
            done();
        });
    });

    it('COPY and APPEND to a \\Noselect mailbox fail', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 COPY 1 Parent', 'A4 APPEND Parent {3}\r\nabc', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\nA3 NO') >= 0);
            assert.ok(resp.indexOf('\r\nA4 NO') >= 0);
            assert.strictEqual(ctx.server.getMailbox('Parent')!.messages.length, 0);
            done();
        });
    });

    it('APPEND refuses flags that can not be stored', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 APPEND Target (\\Recent) {3}\r\nabc',
            'A3 APPEND Target ("a b") {3}\r\nabc',
            'A4 APPEND Target (\\Seen $Label) {3}\r\nabc',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\nA2 BAD') >= 0);
            assert.ok(resp.indexOf('\r\nA3 BAD') >= 0);
            assert.ok(resp.indexOf('\r\nA4 OK') >= 0);
            assert.deepStrictEqual(ctx.server.getMailbox('Target')!.messages[0].flags, ['\\Seen', '$Label']);
            done();
        });
    });

    it('APPEND normalizes the case of system flags', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 APPEND Target (\\seen \\FLAGGED) {3}\r\nabc', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\nA2 OK') >= 0, resp);
            assert.deepStrictEqual(ctx.server.getMailbox('Target')!.messages[0].flags, ['\\Seen', '\\Flagged']);
            done();
        });
    });

    it('APPEND to a missing mailbox returns TRYCREATE', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 APPEND missing {3}\r\nabc', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\nA2 NO [TRYCREATE]') >= 0);
            done();
        });
    });

    it('COPY and APPEND accept a literal mailbox name', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 COPY 1 {6}\r\nTarget', 'A4 APPEND {6}\r\nTarget {3}\r\nabc', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\nA3 OK') >= 0);
            assert.ok(resp.indexOf('\r\nA4 OK') >= 0);
            assert.strictEqual(ctx.server.getMailbox('Target')!.messages.length, 2);
            done();
        });
    });

    it('CREATE turns a \\Noselect placeholder into a mailbox', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 CREATE Parent', 'A3 SELECT Parent', 'A4 LIST "" "Parent*"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\nA2 OK') >= 0);
            assert.ok(resp.indexOf('\r\nA3 OK') >= 0);
            assert.ok(resp.indexOf('\r\n* LIST (\\HasChildren) "/" "Parent"\r\n') >= 0);
            done();
        });
    });

    it('DELETE of a mailbox with children leaves a placeholder that can be created again', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 CREATE Target/sub',
            'A3 STATUS Target (UIDVALIDITY)',
            'A4 DELETE Target',
            'A5 STATUS Target (MESSAGES)',
            'A6 CREATE Target',
            'A7 STATUS Target (UIDVALIDITY MESSAGES)',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\n* STATUS Target (UIDVALIDITY 1)\r\n') >= 0);
            assert.ok(resp.indexOf('\r\nA5 NO') >= 0);
            assert.ok(resp.indexOf('\r\nA6 OK') >= 0);
            // a recreated mailbox gets a higher UIDVALIDITY
            const match = resp.match(/\* STATUS Target \(UIDVALIDITY (\d+) MESSAGES 0\)/);
            assert.ok(match && Number(match[1]) > 1);
            done();
        });
    });

    it('CREATE with an empty name fails', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 CREATE ""', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\nA2 NO') >= 0);
            done();
        });
    });

    it('A failed RENAME keeps the source mailbox', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 RENAME Target INBOX',
            'A3 RENAME Target Parent/Child',
            'A4 RENAME missing other',
            'A5 SELECT Target',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\nA2 NO [ALREADYEXISTS]') >= 0);
            assert.ok(resp.indexOf('\r\nA3 NO [ALREADYEXISTS]') >= 0);
            assert.ok(resp.indexOf('\r\nA4 NO [NONEXISTENT]') >= 0);
            assert.ok(resp.indexOf('\r\nA5 OK') >= 0);
            done();
        });
    });

    it('RENAME INBOX moves the messages and leaves INBOX empty', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 RENAME INBOX Old', 'A3 STATUS Old (MESSAGES)', 'A4 STATUS INBOX (MESSAGES)', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\nA2 OK') >= 0);
            assert.ok(resp.indexOf('\r\n* STATUS Old (MESSAGES 1)\r\n') >= 0);
            assert.ok(resp.indexOf('\r\n* STATUS INBOX (MESSAGES 0)\r\n') >= 0);
            done();
        });
    });

    it('INBOX subfolders survive an unrelated RENAME', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 CREATE INBOX/kid', 'A3 RENAME Target Moved', 'A4 SELECT INBOX/kid', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\nA3 OK') >= 0);
            assert.ok(resp.indexOf('\r\nA4 OK') >= 0);
            done();
        });
    });

    it('LIST matches INBOX case-insensitively and accepts any reference', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 LIST "" inbox', 'A3 LIST "Parent/" "*"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\r\n* LIST (\\HasNoChildren) "/" "INBOX"\r\nA2 OK') >= 0);
            assert.ok(resp.indexOf('\r\n* LIST (\\HasNoChildren) "/" "Parent/Child"\r\nA3 OK') >= 0);
            done();
        });
    });
});
