import { describe, it } from 'node:test';
import assert from 'node:assert';
import { setupServer } from './helpers/index.js';
import tls from 'node:tls';

const tagged = (resp: string, tag: string) => (resp.match(new RegExp('^' + tag + ' (OK|NO|BAD)\\b', 'm')) || [])[1];

describe('SUBSCRIBE, UNSUBSCRIBE and LSUB', () => {
    const ctx = setupServer(() => ({
        storage: {
            INBOX: {},
            '': {
                folders: {
                    Unsubscribed: { subscribed: false },
                    Parent: {
                        flags: ['\\Noselect'],
                        folders: {
                            Child: { subscribed: false }
                        }
                    }
                }
            }
        }
    }));

    // RFC 3501 sections 6.3.6, 6.3.7 and 6.3.9
    it('subscribes and unsubscribes mailboxes', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 LSUB "" "*"',
            'A3 SUBSCRIBE Unsubscribed',
            'A4 LSUB "" "Unsub*"',
            'A5 UNSUBSCRIBE Unsubscribed',
            'A6 LSUB "" "Unsub*"',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(!/^\* LSUB .*"Unsubscribed"\r\nA2 OK/m.test(resp), resp);
            assert.strictEqual(tagged(resp, 'A3'), 'OK');
            assert.ok(/^\* LSUB \(\\HasNoChildren\) "\/" "Unsubscribed"\r\nA4 OK/m.test(resp), resp);
            assert.strictEqual(tagged(resp, 'A5'), 'OK');
            assert.ok(/^A5 OK[^\n]*\nA6 OK/m.test(resp.replace(/\r/g, '')), resp);
            done();
        });
    });

    it('refuses to subscribe missing and \\Noselect mailboxes', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 SUBSCRIBE missing',
            'A3 SUBSCRIBE Parent',
            'A4 UNSUBSCRIBE Parent',
            'A5 UNSUBSCRIBE missing',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(/^A2 NO \[NONEXISTENT\]/m.test(resp), resp);
            assert.strictEqual(tagged(resp, 'A3'), 'NO');
            // a name on the subscription list can always be removed, even if it is not a mailbox (RFC 3501 section 6.3.6)
            assert.strictEqual(tagged(resp, 'A4'), 'OK');
            // ImapKit treats removing a name that is not on the subscription list as done
            assert.strictEqual(tagged(resp, 'A5'), 'OK');
            done();
        });
    });
});

describe('the subscription list holds names', () => {
    const ctx = setupServer(() => ({
        plugins: ['LIST-EXTENDED'],
        storage: {
            INBOX: {},
            '': {
                folders: {
                    Alerts: {},
                    Parent: {
                        folders: {
                            Child: {}
                        }
                    },
                    Quiet: { subscribed: false },
                    Plain: { subscribed: false, folders: { Sub: {} } }
                }
            }
        }
    }));

    const run = (commands: string[], callback: (resp: string) => void) =>
        ctx.run(['A1 LOGIN testuser testpass', ...commands, 'ZZ LOGOUT'], resp => callback(resp.toString('binary')));

    // the untagged responses of one command, followed by its tagged response
    const section = (resp: string, tag: string) => {
        const match = resp.match(new RegExp('(?:^|\\n)((?:\\* [^\\r]*\\r\\n)*' + tag + ' [^\\r]*\\r\\n)'));
        assert.ok(match, 'no response for ' + tag + '\n' + resp);
        return match[1];
    };

    // RFC 3501 sections 6.3.6 and 6.3.9: the server MUST NOT unilaterally remove a name from the subscription list
    it('keeps the subscription of a deleted mailbox until UNSUBSCRIBE', (t, done) => {
        run(
            [
                'A2 DELETE Alerts',
                'A3 LSUB "" "Alerts"',
                'A4 CREATE Alerts',
                'A5 LSUB "" "Alerts"',
                'A6 DELETE Alerts',
                'A7 UNSUBSCRIBE Alerts',
                'A8 LSUB "" "Alerts"'
            ],
            resp => {
                // a name that is not a mailbox is not \Noselect in LSUB, which means "not subscribed" there (RFC 5258 section 3.1)
                assert.match(section(resp, 'A3'), /^\* LSUB \(\) "\/" "Alerts"\r\nA3 OK/);
                // the mailbox created again with the same name is subscribed
                assert.match(section(resp, 'A5'), /^\* LSUB \(\\HasNoChildren\) "\/" "Alerts"\r\nA5 OK/);
                assert.match(section(resp, 'A7'), /^A7 OK/);
                assert.match(section(resp, 'A8'), /^A8 OK/);
                done();
            }
        );
    });

    it('keeps the subscription of a deleted mailbox with children', (t, done) => {
        run(['A2 DELETE Parent', 'A3 LSUB "" "Parent"', 'A4 LIST "" "Parent"', 'A5 UNSUBSCRIBE Parent', 'A6 LSUB "" "Parent"'], resp => {
            assert.match(section(resp, 'A3'), /^\* LSUB \(\\HasChildren\) "\/" "Parent"\r\nA3 OK/);
            assert.match(section(resp, 'A4'), /^\* LIST \(\\Noselect \\HasChildren\) "\/" "Parent"\r\nA4 OK/);
            assert.match(section(resp, 'A5'), /^A5 OK/);
            assert.match(section(resp, 'A6'), /^A6 OK/);
            done();
        });
    });

    // RFC 9051 section 6.3.6: renaming a mailbox doesn't update subscription information on the original name
    it('leaves the subscription with the old name on RENAME', (t, done) => {
        run(['A2 RENAME Alerts Renamed', 'A3 LSUB "" "*e*"', 'A4 RENAME Parent Moved', 'A5 LSUB "" "*"'], resp => {
            assert.match(section(resp, 'A3'), /^\* LSUB \(\) "\/" "Alerts"\r\n(?!.*Renamed)/);
            const names = [...section(resp, 'A5').matchAll(/^\* LSUB \([^)]*\) "\/" "([^"]+)"\r$/gm)].map(match => match[1]).sort();
            assert.deepStrictEqual(names, ['Alerts', 'INBOX', 'Parent', 'Parent/Child', 'Plain/Sub']);
            done();
        });
    });

    it('does not subscribe new mailboxes', (t, done) => {
        run(['A2 CREATE Fresh', 'A3 LSUB "" "Fresh"', 'A4 LSUB "" "Quiet"'], resp => {
            assert.match(section(resp, 'A3'), /^A3 OK/);
            assert.match(section(resp, 'A4'), /^A4 OK/);
            done();
        });
    });

    // RFC 3501 section 6.3.9: with "%" an unsubscribed level that has subscribed names below it is listed with \Noselect
    it('lists unsubscribed levels with subscribed children as \\Noselect for "%"', (t, done) => {
        run(
            ['A2 CREATE Gone/Deep/Box', 'A3 SUBSCRIBE Gone/Deep/Box', 'A4 DELETE Gone/Deep/Box', 'A5 LSUB "" "%"', 'A6 LSUB "" "Gone/%"', 'A7 LSUB "" "*"'],
            resp => {
                assert.match(section(resp, 'A5'), /^\* LSUB \(\\Noselect\) "\/" "Plain"\r$/m);
                assert.match(section(resp, 'A5'), /^\* LSUB \(\\Noselect\) "\/" "Gone"\r$/m);
                assert.doesNotMatch(section(resp, 'A5'), /"Quiet"/);
                assert.match(section(resp, 'A6'), /^\* LSUB \(\\Noselect\) "\/" "Gone\/Deep"\r\nA6 OK/);
                // "*" matches the subscribed names themselves
                assert.match(section(resp, 'A7'), /^\* LSUB \(\) "\/" "Gone\/Deep\/Box"\r$/m);
                assert.doesNotMatch(section(resp, 'A7'), /"(Plain|Gone|Gone\/Deep)"/);
                done();
            }
        );
    });

    // RFC 5258 section 3.1: LIST (SUBSCRIBED) also lists subscribed names that are not mailboxes, as \NonExistent
    it('lists subscribed names that are not mailboxes with LIST (SUBSCRIBED)', (t, done) => {
        run(
            [
                'A2 CREATE Gone/Box',
                'A3 SUBSCRIBE Gone/Box',
                'A4 DELETE Gone/Box',
                'A5 DELETE Gone',
                'A6 LIST (SUBSCRIBED) "" "Gone*"',
                'A7 LIST (SUBSCRIBED RECURSIVEMATCH) "" "%"',
                'A8 LIST "" "Gone*" RETURN (SUBSCRIBED)'
            ],
            resp => {
                assert.match(section(resp, 'A6'), /^\* LIST \(\\NonExistent \\Subscribed \\HasNoChildren\) "\/" "Gone\/Box"\r\nA6 OK/);
                assert.match(section(resp, 'A7'), /^\* LIST \(\\NonExistent \\HasNoChildren\) "\/" "Gone" \("CHILDINFO" \("SUBSCRIBED"\)\)\r$/m);
                // without the SUBSCRIBED selection option only existing mailboxes are listed
                assert.match(section(resp, 'A8'), /^A8 OK/);
                done();
            }
        );
    });
});

describe('DELETE', () => {
    const ctx = setupServer(() => ({
        storage: {
            INBOX: {},
            '': {
                folders: {
                    Empty: {}
                }
            },
            '#news.': {
                type: 'shared',
                separator: '.',
                folders: {
                    world: {}
                }
            }
        }
    }));

    // RFC 3501 section 6.3.4
    it('refuses INBOX, missing mailboxes and other namespaces', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 DELETE INBOX',
            'A3 DELETE missing',
            'A4 DELETE #news.world',
            'A5 DELETE Empty',
            'A6 DELETE Empty',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            // RFC 5530 response codes
            assert.ok(/^A2 NO \[CANNOT\]/m.test(resp), resp);
            assert.ok(/^A3 NO \[NONEXISTENT\]/m.test(resp), resp);
            assert.ok(/^A4 NO \[NOPERM\]/m.test(resp), resp);
            assert.strictEqual(tagged(resp, 'A5'), 'OK');
            assert.ok(/^A6 NO \[NONEXISTENT\]/m.test(resp), resp);
            done();
        });
    });
});

describe('CREATE', () => {
    const ctx = setupServer(() => ({
        storage: {
            INBOX: {},
            '': {
                folders: {
                    Existing: {},
                    Leaf: { flags: ['\\Noinferiors'] },
                    // mailbox attributes are case-insensitive (RFC 3501 section 9, note 1)
                    Upper: { flags: ['\\NOINFERIORS'] }
                }
            }
        }
    }));

    // RFC 5530 response codes
    it('reports why a mailbox can not be created', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 CREATE Existing',
            'A3 CREATE INBOX',
            'A4 CREATE Leaf/child',
            'A5 RENAME Existing Existing/child',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(/^A2 NO \[ALREADYEXISTS\]/m.test(resp), resp);
            assert.ok(/^A3 NO \[ALREADYEXISTS\]/m.test(resp), resp);
            assert.ok(/^A4 NO \[CANNOT\]/m.test(resp), resp);
            assert.ok(/^A5 NO \[CANNOT\]/m.test(resp), resp);
            done();
        });
    });

    // RFC 3501 section 7.2.2: no child levels can be created under a \Noinferiors name, in any spelling
    it('refuses CREATE and RENAME below a \\Noinferiors mailbox', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 CREATE Leaf/child',
            'A3 CREATE Upper/child/deeper',
            'A4 RENAME Existing Leaf/moved',
            'A5 LIST "" "*"',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(/^A2 NO \[CANNOT\]/m.test(resp), resp);
            assert.ok(/^A3 NO \[CANNOT\]/m.test(resp), resp);
            assert.ok(/^A4 NO \[CANNOT\]/m.test(resp), resp);
            // the failed RENAME keeps the source, nothing was created, the attribute is listed in RFC spelling
            assert.ok(/^\* LIST \(\\HasNoChildren\) "\/" "Existing"\r$/m.test(resp), resp);
            assert.ok(/^\* LIST \(\\Noinferiors\) "\/" "Leaf"\r$/m.test(resp), resp);
            assert.ok(/^\* LIST \(\\Noinferiors\) "\/" "Upper"\r$/m.test(resp), resp);
            assert.ok(!/child|moved/.test(resp.replace(/^A\d .*$/gm, '')), resp);
            assert.ok(/^A5 OK/m.test(resp), resp);
            done();
        });
    });
});

describe('SEARCH arguments', () => {
    const ctx = setupServer(() => ({
        storage: {
            INBOX: {
                messages: [{ raw: 'Subject: hello\r\n\r\nWorld' }]
            }
        }
    }));

    it('refuses missing and malformed criteria', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 SELECT INBOX',
            'A3 SEARCH',
            'A4 UID SEARCH',
            'A5 SEARCH NIL',
            'A6 SEARCH ()',
            'A7 SEARCH CHARSET',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            for (const tag of ['A3', 'A4', 'A5', 'A6', 'A7']) {
                assert.strictEqual(tagged(resp, tag), 'BAD', tag + '\n' + resp);
            }
            done();
        });
    });
});

describe('ENABLE arguments', () => {
    const ctx = setupServer(() => ({
        plugins: ['ENABLE', 'CONDSTORE']
    }));

    // RFC 5161 section 3.1: ENABLE takes one or more capability names
    it('refuses missing and non-atom arguments', (t, done) => {
        const cmds = ['A1 LOGIN testuser testpass', 'A2 ENABLE', 'A3 ENABLE "CONDSTORE"', 'A4 ENABLE UNKNOWN', 'ZZ LOGOUT'];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.strictEqual(tagged(resp, 'A2'), 'BAD');
            assert.strictEqual(tagged(resp, 'A3'), 'BAD');
            // unknown capabilities are ignored (RFC 5161 section 3.1)
            assert.ok(/^\* ENABLED\r\nA4 OK/m.test(resp), resp);
            done();
        });
    });
});

describe('STARTTLS on a secure connection', () => {
    const ctx = setupServer(() => ({
        plugins: ['STARTTLS'],
        secureConnection: true
    }));

    it('is not advertised and is refused', (t, done) => {
        const socket = tls.connect({ port: ctx.port, host: 'localhost', rejectUnauthorized: false });
        let resp = '';
        socket.on('data', chunk => {
            resp += chunk.toString();
            if (/^A3 /m.test(resp)) {
                socket.end();
            }
        });
        socket.on('close', () => {
            assert.ok(!/^\* CAPABILITY .*STARTTLS/m.test(resp), resp);
            assert.strictEqual(tagged(resp, 'A2'), 'BAD');
            done();
        });
        socket.once('data', () => {
            socket.write('A1 CAPABILITY\r\n');
            socket.once('data', () => {
                socket.write('A2 STARTTLS\r\n');
                socket.once('data', () => {
                    socket.write('A3 LOGOUT\r\n');
                });
            });
        });
    });
});
