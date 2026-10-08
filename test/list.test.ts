import { describe, it } from 'node:test';
import assert from 'node:assert';
import { setupServer } from './helpers/index.js';

describe('ImapKit tests', () => {
    const ctx = setupServer(() => ({
        plugins: ['NAMESPACE'],
        id: {
            name: 'imapkit',
            version: '0.1'
        },
        storage: {
            INBOX: {
                messages: [
                    {
                        raw: 'Subject: hello 1\r\n\r\nWorld 1!',
                        internaldate: '14-Sep-2013 21:22:28 -0300'
                    },
                    {
                        raw: 'Subject: hello 2\r\n\r\nWorld 2!',
                        flags: ['\\Seen']
                    },
                    {
                        raw: 'Subject: hello 3\r\n\r\nWorld 3!'
                    },
                    {
                        raw:
                            'From: sender name <sender@example.com>\r\n' +
                            'To: Receiver name <receiver@example.com>\r\n' +
                            'Subject: hello 4\r\n' +
                            'Message-Id: <abcde>\r\n' +
                            'Date: Fri, 13 Sep 2013 15:01:00 +0300\r\n' +
                            '\r\n' +
                            'World 4!'
                    },
                    {
                        raw: 'Subject: hello 5\r\n\r\nWorld 5!'
                    },
                    {
                        raw: 'Subject: hello 6\r\n\r\nWorld 6!'
                    }
                ]
            },
            '': {
                folders: {
                    Test: {
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

    it('Namespace', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 CAPABILITY', 'A3 NAMESPACE', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.match(/^\* CAPABILITY\b.*?\bNAMESPACE\b/m));
            assert.ok(resp.indexOf('\n* NAMESPACE (("" "/")) NIL (("#news." ".") ("#juke?" "?"))\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('LIST separator', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 CAPABILITY', 'A3 LIST "" ""', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.equal((resp.match(/^\* LIST\b/gm) || []).length, 1);
            assert.ok(resp.indexOf('\n* LIST (\\Noselect) "/" ""\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    // RFC 3501 section 6.3.8: an empty mailbox name returns "the hierarchy delimiter and the root name of the
    // name given in the reference", the example answers LIST #news.comp.mail.misc "" with "." #news.
    it('LIST separator of the reference namespace', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 LIST "#news.comp.mail.misc" ""', 'A3 LIST "#juke?" ""', 'A4 LIST "Test" ""', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.match(resp, /^\* LIST \(\\Noselect\) "\." "?#news\."?\r\nA2 OK/m);
            assert.match(resp, /^\* LIST \(\\Noselect\) "\?" "#juke\?"\r\nA3 OK/m);
            assert.match(resp, /^\* LIST \(\\Noselect\) "\/" ""\r\nA4 OK/m);
            done();
        });
    });

    it('LIST default namespace', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 CAPABILITY', 'A3 LIST "" "*"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.equal((resp.match(/^\* LIST\b/gm) || []).length, 2);
            assert.ok(resp.indexOf('\n* LIST (\\HasNoChildren) "/" "INBOX"\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    // RFC 3501 section 6.3.8: with the namespace convention "#" is a break out character "and must be treated as
    // such", a mailbox name that starts with it overrides the reference
    it('LIST ignores the reference for a name that starts with #', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 LIST "Test/" "#news.*"', 'A3 LIST "Test/" "%"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.match(resp, /^\* LIST \(\\HasNoChildren\) "\." "#news\.world"\r\n/m);
            assert.match(resp, /^A2 OK/m);
            // without a break out character the reference still applies
            assert.doesNotMatch(resp.slice(resp.indexOf('A2 OK')), /#news/);
            done();
        });
    });

    it('LIST #news namespace', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 CAPABILITY', 'A3 LIST "#news." "*"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.equal((resp.match(/^\* LIST\b/gm) || []).length, 1);
            assert.ok(resp.indexOf('\n* LIST (\\HasNoChildren) "." "#news.world"\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });

    it('LSUB all', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 CAPABILITY', 'A3 LSUB "" "*"', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.equal((resp.match(/^\* LSUB\b/gm) || []).length, 1);
            assert.ok(resp.indexOf('\n* LSUB (\\HasNoChildren) "/" "INBOX"\r\n') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            done();
        });
    });
});

// RFC 3501 section 6.3.8 / RFC 9051 section 6.3.9: "An empty ("" string) reference name argument indicates
// that the mailbox name is interpreted as by SELECT", so a pattern matches the full mailbox name, also
// when the personal namespace has a prefix like "INBOX." (Cyrus layout)
describe('LIST with a prefixed personal namespace', () => {
    const ctx = setupServer(() => ({
        plugins: ['LIST-EXTENDED'],
        storage: {
            INBOX: {},
            'INBOX.': {
                folders: {
                    Drafts: {},
                    Sent: { subscribed: false },
                    Work: { subscribed: false, folders: { Done: { subscribed: false } } }
                }
            },
            'user.': {
                type: 'user',
                folders: { other: {} }
            },
            '': {
                type: 'shared',
                folders: { Public: {} }
            }
        }
    }));

    // the mailbox names of the LIST (or LSUB) responses in a transcript
    const listed = (resp: string, command = 'LIST') =>
        (resp.match(new RegExp('^\\* ' + command + ' .*$', 'gm')) || []).map(line =>
            line
                .replace(/^\* \w+ \([^)]*\) "[^"]*" /, '')
                .replace(/\r$/, '')
                .replace(/^"(.*)"$/, '$1')
        );

    it('matches full names with an empty reference', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 LIST "" "INBOX.%"', 'ZZ LOGOUT'];
        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.deepStrictEqual(listed(resp), ['INBOX.Drafts', 'INBOX.Sent', 'INBOX.Work']);
            assert.match(resp, /^\* LIST \(\\HasChildren\) "\." "?INBOX\.Work"?\r$/m);
            assert.match(resp, /^A2 OK/m);
            done();
        });
    });

    it('"*" after the prefix matches every level', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 LIST "" "INBOX.*"', 'ZZ LOGOUT'];
        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.deepStrictEqual(listed(resp), ['INBOX.Drafts', 'INBOX.Sent', 'INBOX.Work', 'INBOX.Work.Done']);
            done();
        });
    });

    it('"%" lists the top level, INBOX but not its children', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 LIST "" "%"', 'ZZ LOGOUT'];
        ctx.run(cmds, resp => {
            resp = resp.toString();
            // the shared namespace "" has no prefix, its mailboxes are top level names too
            assert.deepStrictEqual(listed(resp).sort(), ['INBOX', 'Public']);
            assert.match(resp, /^\* LIST \(\\HasChildren\) "\." "?INBOX"?\r$/m);
            done();
        });
    });

    it('INBOX matches case-insensitively, its children do not', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 LIST "" "inbox"', 'A3 LIST "" "inbox.%"', 'ZZ LOGOUT'];
        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.deepStrictEqual(listed(resp), ['INBOX']);
            assert.match(resp, /^A3 OK/m);
            done();
        });
    });

    it('the reference is a level of hierarchy', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 LIST "INBOX." "%"', 'A3 LIST "INBOX.Work." "*"', 'ZZ LOGOUT'];
        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.deepStrictEqual(listed(resp), ['INBOX.Drafts', 'INBOX.Sent', 'INBOX.Work', 'INBOX.Work.Done']);
            done();
        });
    });

    it('other users are listed when the pattern names their namespace', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 LIST "" "*"', 'A3 LIST "" "user.%"', 'A4 LIST "user." "*"', 'ZZ LOGOUT'];
        ctx.run(cmds, resp => {
            resp = resp.toString();
            const a2 = resp.slice(0, resp.indexOf('A2 OK'));
            assert.deepStrictEqual(listed(a2).sort(), ['INBOX', 'INBOX.Drafts', 'INBOX.Sent', 'INBOX.Work', 'INBOX.Work.Done', 'Public']);
            assert.deepStrictEqual(listed(resp.slice(resp.indexOf('A2 OK'))), ['user.other', 'user.other']);
            done();
        });
    });

    it('LSUB and extended LIST match full names', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 LSUB "" "INBOX.%"',
            'A3 LIST (SUBSCRIBED) "" "INBOX.*"',
            'A4 LIST "" ("INBOX" "INBOX.W%")',
            'ZZ LOGOUT'
        ];
        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.deepStrictEqual(listed(resp, 'LSUB'), ['INBOX.Drafts']);
            assert.match(resp, /^\* LIST \(\\Subscribed \\HasNoChildren\) "\." "?INBOX\.Drafts"?\r$/m);
            assert.deepStrictEqual(listed(resp.slice(resp.indexOf('A3 OK'))), ['INBOX', 'INBOX.Work']);
            done();
        });
    });
});
