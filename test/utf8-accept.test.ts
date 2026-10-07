// UTF8=ACCEPT, RFC 9755 (https://www.rfc-editor.org/rfc/rfc9755.txt)

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { setupServer } from './helpers/index.js';
import { openSession } from './helpers/session.js';
import { encode as encodeMailboxName, decode as decodeMailboxName } from '../src/mailbox-name.js';

// commands are binary strings, so UTF-8 text is written octet by octet
const utf8 = (str: string) => Buffer.from(str, 'utf-8').toString('binary');

const LOGIN = 'L1 LOGIN testuser testpass';
const ENABLE = 'E1 ENABLE UTF8=ACCEPT';

const UTF8_MESSAGE = utf8(
    'From: Jürgen <juergen@example.com>\r\nTo: Плохой <пример@пример.рф>\r\nSubject: Grüße aus Köln\r\nMessage-ID: <utf8@example.com>\r\n\r\nHallo\r\n'
);

const storage = () => ({
    INBOX: {
        messages: [{ raw: 'Subject: hello\r\n\r\nWorld' }, { raw: UTF8_MESSAGE }]
    },
    '': {
        separator: '/',
        folders: {
            // storage names are modified UTF-7
            [encodeMailboxName('Жар')]: {
                messages: [{ raw: 'Subject: inside\r\n\r\nWorld' }],
                folders: {
                    [encodeMailboxName('Ü')]: {}
                }
            },
            'A&-B': {},
            [encodeMailboxName('ЖЖ')]: {}
        }
    }
});

describe('UTF8=ACCEPT', () => {
    const ctx = setupServer(() => ({ plugins: ['UTF8=ACCEPT'], storage: storage() }));

    // runs commands and returns the transcript decoded as UTF-8
    const run = (cmds: string[], callback: (resp: string) => void) => {
        ctx.run(cmds.concat('ZZ LOGOUT'), resp => callback(resp.toString('utf-8')));
    };

    it('advertises UTF8=ACCEPT and loads ENABLE (RFC 9755 section 3)', (t, done) => {
        run(['A1 CAPABILITY'], resp => {
            assert.match(resp, /^\* CAPABILITY .*\bENABLE\b/m);
            assert.match(resp, /^\* CAPABILITY .*\bUTF8=ACCEPT\b/m);
            assert.doesNotMatch(resp, /UTF8=ONLY/);
            done();
        });
    });

    it('ENABLE UTF8=ACCEPT is only valid in the authenticated state', (t, done) => {
        run(['A1 ENABLE UTF8=ACCEPT', LOGIN, 'A2 ENABLE UTF8=ACCEPT', 'A3 ENABLE UTF8=ACCEPT'], resp => {
            assert.match(resp, /^A1 BAD /m);
            assert.match(resp, /^\* ENABLED UTF8=ACCEPT\r\nA2 OK /m);
            // enabling twice lists nothing the second time (RFC 5161 section 3.2)
            assert.match(resp, /^\* ENABLED\r\nA3 OK /m);
            done();
        });
    });

    it('sends modified UTF-7 names until UTF8=ACCEPT is enabled (RFC 9755 section 3)', (t, done) => {
        run([LOGIN, 'A1 LIST "" "*"', ENABLE, 'A2 LIST "" "*"'], resp => {
            const [before, after] = resp.split(/^E1 OK .*$/m);
            assert.match(before, /^\* LIST \(\\HasChildren\) "\/" "&BBYEMARA-"\r$/m);
            assert.match(before, /^\* LIST \(\\HasNoChildren\) "\/" "&BBYEMARA-\/&ANw-"\r$/m);
            assert.match(before, /^\* LIST \(\\HasNoChildren\) "\/" "A&-B"\r$/m);
            assert.doesNotMatch(before, /Жар/);

            assert.match(after, /^\* LIST \(\\HasChildren\) "\/" "Жар"\r$/m);
            assert.match(after, /^\* LIST \(\\HasNoChildren\) "\/" "Жар\/Ü"\r$/m);
            // "&" is an ordinary character in UTF-8 names
            assert.match(after, /^\* LIST \(\\HasNoChildren\) "\/" "A&B"\r$/m);
            assert.match(after, /^\* LIST \(\\HasNoChildren\) "\/" "ЖЖ"\r$/m);
            assert.doesNotMatch(after, /&BBY/);
            done();
        });
    });

    it('matches LIST and LSUB wildcards against UTF-8 characters', (t, done) => {
        run([LOGIN, ENABLE, utf8('A1 LIST "" "Ж%"'), utf8('A2 LIST "Жар/" "%"'), utf8('A3 LSUB "" "*Ü"'), utf8('A4 LIST "" "%Ж"')], resp => {
            const a1 = resp.split(/^A1 OK/m)[0].split(/^E1 OK .*$/m)[1];
            assert.match(a1, /^\* LIST \(\\HasChildren\) "\/" "Жар"\r$/m);
            assert.match(a1, /^\* LIST \(\\HasNoChildren\) "\/" "ЖЖ"\r$/m);
            assert.doesNotMatch(a1, /Ü/);
            assert.match(resp, /^\* LIST \(\\HasNoChildren\) "\/" "Жар\/Ü"\r\nA2 OK/m);
            assert.match(resp, /^\* LSUB \(\\HasNoChildren\) "\/" "Жар\/Ü"\r\nA3 OK/m);
            assert.match(resp, /^\* LIST \(\\HasNoChildren\) "\/" "ЖЖ"\r\nA4 OK/m);
            done();
        });
    });

    it('accepts UTF-8 mailbox names after ENABLE (RFC 9755 section 3)', (t, done) => {
        run(
            [
                LOGIN,
                ENABLE,
                utf8('A1 SELECT "Жар"'),
                utf8('A2 STATUS "Жар/Ü" (MESSAGES)'),
                utf8('A3 CREATE "Новая"'),
                utf8('A4 RENAME "Новая" "Старая&"'),
                utf8('A5 SUBSCRIBE "Старая&"'),
                utf8('A6 COPY 1 "Старая&"'),
                utf8('A7 STATUS "Старая&" (MESSAGES)'),
                utf8('A8 APPEND "Старая&" {5}\r\nHello'),
                utf8('A9 EXAMINE "Старая&"'),
                utf8('A10 DELETE "Жар/Ü"'),
                utf8('A11 UNSUBSCRIBE "Старая&"')
            ],
            resp => {
                assert.match(resp, /^\* 1 EXISTS\r\n(.*\r\n)*A1 OK /m);
                assert.match(resp, /^\* STATUS "Жар\/Ü" \(MESSAGES 0\)\r\nA2 OK /m);
                for (const tag of ['A3', 'A4', 'A5', 'A6', 'A8', 'A10', 'A11']) {
                    assert.match(resp, new RegExp('^' + tag + ' OK ', 'm'));
                }
                assert.match(resp, /^\* STATUS "Старая&" \(MESSAGES 1\)\r\nA7 OK /m);
                assert.match(resp, /^\* 2 EXISTS\r\n(.*\r\n)*A9 OK /m);

                // storage keeps modified UTF-7 names
                const folders = Object.keys(ctx.server.folderCache);
                assert.ok(folders.includes(encodeMailboxName('Старая&')), folders.join(', '));
                assert.ok(folders.includes('&BCEEQgQwBEAEMARP-&-'), folders.join(', '));
                assert.ok(!folders.includes(encodeMailboxName('Жар/Ü')), folders.join(', '));
                done();
            }
        );
    });

    it('treats modified UTF-7 names as plain UTF-8 after ENABLE', (t, done) => {
        run([LOGIN, ENABLE, 'A1 SELECT "&BBYEMARA-"', 'A2 CREATE "&BBY-"', 'A3 LIST "" "&*"'], resp => {
            assert.match(resp, /^A1 NO \[NONEXISTENT\] /m);
            assert.match(resp, /^A2 OK /m);
            assert.match(resp, /^\* LIST \(\\HasNoChildren\) "\/" "&BBY-"\r\nA3 OK/m);
            assert.ok(ctx.server.folderCache['&-BBY-'], Object.keys(ctx.server.folderCache).join(', '));
            done();
        });
    });

    it('refuses 8-bit mailbox names before ENABLE (RFC 3501 section 5.1.3)', (t, done) => {
        run([LOGIN, utf8('A1 SELECT "Жар"'), utf8('A2 CREATE "Новая"'), 'A3 SELECT "&BBYEMARA-"'], resp => {
            assert.match(resp, /^A1 BAD .*modified UTF-7/m);
            assert.match(resp, /^A2 BAD .*modified UTF-7/m);
            assert.match(resp, /^\* 1 EXISTS\r\n(.*\r\n)*A3 OK /m);
            done();
        });
    });

    // RFC 9755 section 3: Net-Unicode (RFC 5198 section 2) without control characters, DEL, U+2028 and U+2029
    const INVALID_NAMES = [
        ['a control character', 'a\x01b'],
        ['DEL', 'a\x7fb'],
        ['a C1 control character', utf8('a\u0085b')],
        ['LINE SEPARATOR', utf8('a\u2028b')],
        ['PARAGRAPH SEPARATOR', utf8('a\u2029b')],
        ['a leading byte order mark', utf8('\ufeffab')],
        ['an unassigned code point', utf8('a\u0378b')],
        ['invalid UTF-8', 'caf\xe9'],
        ['an encoded surrogate', 'a\xed\xa0\x80b']
    ];
    for (const [description, name] of INVALID_NAMES) {
        it('refuses a mailbox name with ' + description + ' after ENABLE', (t, done) => {
            run([LOGIN, ENABLE, 'A1 CREATE {' + name.length + '}\r\n' + name, 'A2 SELECT {' + name.length + '}\r\n' + name], resp => {
                assert.match(resp, /^A1 BAD .*RFC 9755 section 3/m);
                assert.match(resp, /^A2 BAD /m);
                done();
            });
        });
    }

    it('refuses invalid UTF-8 in quoted strings (RFC 9755 section 3)', (t, done) => {
        run([LOGIN, 'A1 CREATE "caf\xe9"', ENABLE, 'A2 SELECT "caf\xe9"'], resp => {
            assert.match(resp, /^A1 BAD /m);
            assert.match(resp, /^A2 BAD /m);
            done();
        });
    });

    it('accepts UTF-8 quoted strings before ENABLE (RFC 9755 section 3)', (t, done) => {
        run([LOGIN, 'S1 SELECT INBOX', utf8('A1 SEARCH CHARSET UTF-8 SUBJECT "Grüße"'), utf8('A2 SEARCH SUBJECT "Grüße"')], resp => {
            assert.match(resp, /^\* SEARCH 2\r\nA1 OK /m);
            // without CHARSET the strings are still US-ASCII
            assert.match(resp, /^A2 BAD /m);
            done();
        });
    });

    it('searches UTF-8 strings without CHARSET after ENABLE (RFC 9755 section 3)', (t, done) => {
        run(
            [
                LOGIN,
                ENABLE,
                'S1 SELECT INBOX',
                utf8('A1 SEARCH SUBJECT "Grüße"'),
                utf8('A2 UID SEARCH TO "пример.рф"'),
                utf8('A3 SEARCH CHARSET UTF-8 SUBJECT "Grüße"'),
                'A4 SEARCH CHARSET US-ASCII SUBJECT hello',
                'A5 SEARCH SUBJECT {4}\r\ncaf\xe9',
                'A6 SEARCH SUBJECT hello'
            ],
            resp => {
                assert.match(resp, /^\* SEARCH 2\r\nA1 OK /m);
                assert.match(resp, /^\* SEARCH 2\r\nA2 OK /m);
                // RFC 9755 section 3: a CHARSET conflicts with UTF8=ACCEPT
                assert.match(resp, /^A3 BAD .*CHARSET/m);
                assert.match(resp, /^A4 BAD .*CHARSET/m);
                assert.match(resp, /^A5 BAD .*UTF-8/m);
                assert.match(resp, /^\* SEARCH 1\r\nA6 OK /m);
                done();
            }
        );
    });

    it('refuses APPEND with an 8-bit header before ENABLE (RFC 9755 section 4)', (t, done) => {
        const bodyOnly = utf8('Subject: hello\r\n\r\nGrüße');
        run(
            [
                LOGIN,
                'A1 APPEND INBOX {' + UTF8_MESSAGE.length + '}\r\n' + UTF8_MESSAGE,
                'A2 APPEND INBOX {' + bodyOnly.length + '}\r\n' + bodyOnly,
                ENABLE,
                'A3 APPEND INBOX {' + UTF8_MESSAGE.length + '}\r\n' + UTF8_MESSAGE
            ],
            resp => {
                assert.match(resp, /^A1 NO .*RFC 9755 section 4/m);
                assert.match(resp, /^A2 OK /m);
                assert.match(resp, /^A3 OK /m);
                assert.strictEqual(ctx.server.folderCache.INBOX.messages.length, 4);
                done();
            }
        );
    });

    it('still answers BAD to a malformed APPEND', (t, done) => {
        run([LOGIN, 'A1 APPEND INBOX', 'A2 APPEND INBOX "x"'], resp => {
            assert.match(resp, /^A1 BAD /m);
            assert.match(resp, /^A2 BAD /m);
            done();
        });
    });

    it('sends 8-bit header data quoted only after ENABLE (RFC 9755 section 3)', (t, done) => {
        run([LOGIN, 'A1 EXAMINE INBOX', 'A2 FETCH 2 ENVELOPE', 'A3 UNSELECT'], resp => {
            // the validator checks that no 8-bit octet is sent outside a literal
            assert.match(resp, /^\* 2 FETCH \(ENVELOPE \(NIL \{\d+\}\r\nGrüße aus Köln /m);
            done();
        });
    });

    it('sends ENVELOPE strings as quoted UTF-8 after ENABLE', (t, done) => {
        run([LOGIN, ENABLE, 'A1 EXAMINE INBOX', 'A2 FETCH 2 (ENVELOPE BODY.PEEK[HEADER.FIELDS (SUBJECT)])'], resp => {
            assert.match(
                resp,
                /^\* 2 FETCH \(ENVELOPE \(NIL "Grüße aus Köln" \(\("Jürgen" NIL "juergen" "example.com"\)\).* \(\("Плохой" NIL "пример" "пример.рф"\)\) NIL NIL NIL "<utf8@example.com>"\) BODY\[HEADER.FIELDS \(SUBJECT\)\] \{\d+\}\r\nSubject: Grüße aus Köln/m
            );
            done();
        });
    });

    it('refuses UTF-8 in LOGIN (RFC 9755 section 5)', (t, done) => {
        run([utf8('A1 LOGIN "Jürgen" testpass'), 'A2 LOGIN testuser {9}\r\ntestp\xc3\xa4ss', LOGIN], resp => {
            assert.match(resp, /^A1 BAD .*AUTHENTICATE/m);
            assert.match(resp, /^A2 BAD .*AUTHENTICATE/m);
            assert.match(resp, /^L1 OK /m);
            done();
        });
    });

    it('sends UTF-8 only to the sessions that enabled it', (t, done) => {
        const port = ctx.port;
        openSession(port, first => {
            openSession(port, second => {
                first.run(LOGIN, () => {
                    second.run(LOGIN, () => {
                        first.run(ENABLE, () => {
                            first.run(utf8('A1 CREATE "Ёлка"'), () => {
                                second.run('A2 LIST "" "*"', legacy => {
                                    first.run('A3 LIST "" "*"', enabled => {
                                        first.close();
                                        second.close();
                                        assert.match(legacy, /^\* LIST \(\\HasNoChildren\) "\/" "&BAEEOwQ6BDA-"\r$/m);
                                        assert.doesNotMatch(legacy, /[\x80-\xff]/);
                                        assert.match(Buffer.from(enabled, 'binary').toString('utf-8'), /^\* LIST \(\\HasNoChildren\) "\/" "Ёлка"\r$/m);
                                        done();
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});

describe('UTF8=ACCEPT with other plugins', () => {
    const ctx = setupServer(() => ({
        // ENABLE is listed after UTF8=ACCEPT that already loaded it
        plugins: ['UTF8=ACCEPT', 'NAMESPACE', 'MOVE', 'ENABLE', 'SPECIAL-USE'],
        storage: {
            INBOX: { messages: [{ raw: 'Subject: hello\r\n\r\nWorld' }] },
            '': { separator: '/' },
            [encodeMailboxName('Общие') + '/']: {
                type: 'shared',
                folders: {
                    [encodeMailboxName('Корзина')]: { 'special-use': '\\Trash' }
                }
            }
        }
    }));

    it('sends UTF-8 NAMESPACE prefixes after ENABLE', (t, done) => {
        ctx.run([LOGIN, 'A1 NAMESPACE', ENABLE, 'A2 NAMESPACE', 'ZZ LOGOUT'], resp => {
            resp = resp.toString('utf-8');
            assert.match(resp, /^\* NAMESPACE \(\("" "\/"\)\) NIL \(\("&BB4EMQRJBDgENQ-\/" "\/"\)\)\r\nA1 OK/m);
            assert.match(resp, /^\* NAMESPACE \(\("" "\/"\)\) NIL \(\("Общие\/" "\/"\)\)\r\nA2 OK/m);
            done();
        });
    });

    it('lists UTF-8 names in other namespaces', (t, done) => {
        ctx.run([LOGIN, ENABLE, utf8('A1 LIST "Общие/" "*"'), 'ZZ LOGOUT'], resp => {
            resp = resp.toString('utf-8');
            assert.match(resp, /^\* LIST \(\\HasNoChildren \\Trash\) "\/" "Общие\/Корзина"\r\nA1 OK/m);
            done();
        });
    });

    it('MOVE takes a UTF-8 target mailbox', (t, done) => {
        ctx.run(
            [LOGIN, ENABLE, utf8('A0 CREATE "Ящик"'), 'S1 SELECT INBOX', utf8('A1 MOVE 1 "Ящик"'), utf8('A2 STATUS "Ящик" (MESSAGES)'), 'ZZ LOGOUT'],
            resp => {
                resp = resp.toString('utf-8');
                assert.match(resp, /^A1 OK /m);
                assert.match(resp, /^\* STATUS "Ящик" \(MESSAGES 1\)\r\nA2 OK/m);
                done();
            }
        );
    });
});

describe('UTF8=ACCEPT with the LIST, SEARCH and METADATA extensions', () => {
    const ctx = setupServer(() => ({
        plugins: ['UTF8=ACCEPT', 'LIST-EXTENDED', 'LIST-STATUS', 'ESEARCH', 'SORT', 'THREAD=REFERENCES', 'METADATA'],
        storage: storage()
    }));

    const run = (cmds: string[], callback: (resp: string) => void) => {
        ctx.run(cmds.concat('ZZ LOGOUT'), resp => callback(resp.toString('utf-8')));
    };

    it('sends UTF-8 names in extended LIST and LIST-STATUS responses', (t, done) => {
        run([LOGIN, ENABLE, utf8('A1 LIST "" ("Ж%" "Жар/%") RETURN (STATUS (MESSAGES))'), 'A2 LIST "" "*" RETURN (STATUS (MESSAGES))'], resp => {
            assert.match(resp, /^\* LIST \(\\HasChildren\) "\/" "Жар"\r\n\* STATUS "Жар" \(MESSAGES 1\)\r$/m);
            assert.match(resp, /^\* LIST \(\\HasNoChildren\) "\/" "Жар\/Ü"\r\n\* STATUS "Жар\/Ü" \(MESSAGES 0\)\r$/m);
            assert.match(resp, /^\* LIST \(\\HasNoChildren\) "\/" "ЖЖ"\r$/m);
            assert.match(resp, /^\* LIST \(\\HasNoChildren\) "\/" "A&B"\r\n\* STATUS A&B \(MESSAGES 0\)\r$/m);
            assert.doesNotMatch(resp, /&BBY/);
            done();
        });
    });

    it('sends modified UTF-7 STATUS names without ENABLE', (t, done) => {
        run([LOGIN, 'A1 LIST "" "*" RETURN (STATUS (MESSAGES))', 'A2 STATUS "A&-B" (MESSAGES)'], resp => {
            assert.match(resp, /^\* STATUS &BBYEMARA- \(MESSAGES 1\)\r$/m);
            assert.match(resp, /^\* STATUS A&-B \(MESSAGES 0\)\r\nA2 OK/m);
            done();
        });
    });

    it('searches UTF-8 with ESEARCH, SORT and THREAD (RFC 9755 section 3)', (t, done) => {
        run(
            [
                LOGIN,
                ENABLE,
                'S1 SELECT INBOX',
                utf8('A1 SEARCH RETURN (ALL) SUBJECT "Grüße"'),
                utf8('A2 SEARCH RETURN (ALL) CHARSET UTF-8 SUBJECT "Grüße"'),
                utf8('A3 SORT (SUBJECT) UTF-8 SUBJECT "Grüße"'),
                'A4 SORT (SUBJECT) US-ASCII ALL',
                utf8('A5 THREAD REFERENCES utf-8 SUBJECT "Köln"'),
                'A6 THREAD REFERENCES US-ASCII ALL'
            ],
            resp => {
                assert.match(resp, /^\* ESEARCH \(TAG "A1"\) ALL 2\r\nA1 OK/m);
                assert.match(resp, /^A2 BAD /m);
                assert.match(resp, /^\* SORT 2\r\nA3 OK/m);
                // RFC 9755 section 3: charsets other than UTF-8 are BAD for SORT and THREAD
                assert.match(resp, /^A4 BAD .*UTF-8/m);
                assert.match(resp, /^\* THREAD \(2\)\r\nA5 OK/m);
                assert.match(resp, /^A6 BAD .*UTF-8/m);
                done();
            }
        );
    });

    it('takes UTF-8 names in GETMETADATA and SETMETADATA', (t, done) => {
        run(
            [
                LOGIN,
                ENABLE,
                utf8('A1 SETMETADATA "Жар" (/private/comment "x")'),
                utf8('A2 GETMETADATA "Жар" /private/comment'),
                utf8('A3 GETMETADATA (DEPTH 1) "Жар" /private'),
                'A4 GETMETADATA "&BBYEMARA-" /private/comment',
                'A5 GETMETADATA (DEPTH 1) {3}\r\na\x01b /private'
            ],
            resp => {
                assert.match(resp, /^A1 OK /m);
                assert.match(resp, /^\* METADATA "Жар" \(\/private\/comment "x"\)\r\nA2 OK/m);
                assert.match(resp, /^\* METADATA "Жар" \(\/private\/comment "x"\)\r\nA3 OK/m);
                assert.match(resp, /^A4 NO /m);
                assert.match(resp, /^A5 BAD /m);
                done();
            }
        );
    });

    it('converts unsolicited METADATA names for each session', (t, done) => {
        const port = ctx.port;
        openSession(port, first => {
            openSession(port, second => {
                first.run(LOGIN, () => {
                    second.run(LOGIN, () => {
                        first.run('E1 ENABLE METADATA UTF8=ACCEPT', () => {
                            second.run('E2 ENABLE METADATA', () => {
                                second.run('A1 SETMETADATA "&BBYEMARA-" (/shared/comment "y")', legacy => {
                                    first.run('A2 NOOP', enabled => {
                                        second.close();
                                        first.close();
                                        assert.match(legacy, /^A1 OK /m);
                                        assert.match(Buffer.from(enabled, 'binary').toString('utf-8'), /^\* METADATA "Жар" \/shared\/comment\r$/m);
                                        done();
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});

describe('UTF8=ACCEPT with QUOTA and UNAUTHENTICATE', () => {
    const ctx = setupServer(() => ({
        plugins: ['UTF8=ACCEPT', 'QUOTA', 'UNAUTHENTICATE'],
        storage: storage()
    }));

    const run = (cmds: string[], callback: (resp: string) => void) => {
        ctx.run(cmds.concat('ZZ LOGOUT'), resp => callback(resp.toString('utf-8')));
    };

    it('sends the GETQUOTAROOT mailbox name in the session form', (t, done) => {
        run([LOGIN, 'A1 GETQUOTAROOT "&BBYEMARA-"', ENABLE, utf8('A2 GETQUOTAROOT "Жар"')], resp => {
            assert.match(resp, /^\* QUOTAROOT &BBYEMARA-( |\r)/m);
            assert.match(resp, /^\* QUOTAROOT "Жар"( |\r)/m);
            done();
        });
    });

    it('turns UTF-8 off with UNAUTHENTICATE (RFC 8437 section 3)', (t, done) => {
        run([LOGIN, ENABLE, 'A1 UNAUTHENTICATE', LOGIN.replace('L1', 'L2'), utf8('A3 SELECT "Жар"'), 'A4 LIST "" "&BBYEMARA-"'], resp => {
            assert.match(resp, /^A1 OK /m);
            assert.match(resp, /^A3 BAD .*modified UTF-7/m);
            assert.match(resp, /^\* LIST \(\\HasChildren\) "\/" "&BBYEMARA-"\r\nA4 OK/m);
            done();
        });
    });
});

describe('UTF8=ACCEPT with ACL', () => {
    const ctx = setupServer(() => ({ plugins: ['UTF8=ACCEPT', 'ACL'], storage: storage() }));

    // ACL responses carry the mailbox name in the form the session uses
    it('sends the mailbox names of ACL, LISTRIGHTS and MYRIGHTS in the session form', (t, done) => {
        const cmds = [
            LOGIN,
            'A1 MYRIGHTS "&BBYEMARA-"',
            ENABLE,
            utf8('A2 MYRIGHTS "Жар"'),
            utf8('A3 GETACL "Жар"'),
            utf8('A4 LISTRIGHTS "Жар" bob'),
            'ZZ LOGOUT'
        ];
        ctx.run(cmds, resp => {
            resp = resp.toString('utf-8');
            assert.match(resp, /^\* MYRIGHTS &BBYEMARA- /m);
            assert.match(resp, /^\* MYRIGHTS "Жар" /m);
            assert.match(resp, /^\* ACL "Жар" testuser /m);
            assert.match(resp, /^\* LISTRIGHTS "Жар" bob /m);
            done();
        });
    });
});

describe('Without UTF8=ACCEPT', () => {
    const ctx = setupServer(() => ({ plugins: ['ENABLE'], storage: storage() }));

    it('does not enable UTF8=ACCEPT and refuses UTF-8 quoted strings', (t, done) => {
        ctx.run([LOGIN, ENABLE, 'S1 SELECT INBOX', utf8('A1 SEARCH CHARSET UTF-8 SUBJECT "Grüße"'), utf8('A2 CREATE "Жар"'), 'ZZ LOGOUT'], resp => {
            resp = resp.toString('utf-8');
            assert.match(resp, /^\* ENABLED\r\nE1 OK/m);
            assert.match(resp, /^A1 BAD /m);
            assert.match(resp, /^A2 BAD /m);
            done();
        });
    });
});

describe('Modified UTF-7 conversion', () => {
    it('encodes and decodes the RFC 3501 section 5.1.3 examples', () => {
        assert.strictEqual(encodeMailboxName('~peter/mail/台北/日本語'), '~peter/mail/&U,BTFw-/&ZeVnLIqe-');
        assert.strictEqual(decodeMailboxName('~peter/mail/&U,BTFw-/&ZeVnLIqe-'), '~peter/mail/台北/日本語');
        assert.strictEqual(encodeMailboxName('a&b'), 'a&-b');
        assert.strictEqual(decodeMailboxName('a&-b'), 'a&b');
        assert.strictEqual(encodeMailboxName('😀'), '&2D3eAA-');
        assert.strictEqual(decodeMailboxName('&2D3eAA-'), '😀');
        assert.strictEqual(decodeMailboxName('&Jjo!'), false);
    });
});
