'use strict';

// Table driven checks of how strictly hoodiecrow applies the IMAP grammar and the command
// states. Hoodiecrow is a guardrail for client development, so input that a lenient server
// would accept is refused here. RFC references are to the text at
// https://www.rfc-editor.org/rfc/rfcXXXX.txt

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');

const LOGIN = 'L1 LOGIN testuser testpass';
const SELECT = 'L2 SELECT INBOX';

// Prefix commands that bring a fresh connection to the wanted state
const STATES = {
    none: [],
    auth: [LOGIN],
    selected: [LOGIN, SELECT]
};

// [description, state, commands, expected tagged results, strings that must not appear]
const CASES = [
    // RFC 3501 section 3: commands are only valid in specific states, a command in the wrong state is a protocol error
    ['SELECT before login', 'none', ['A1 SELECT INBOX'], { A1: 'BAD' }],
    ['CREATE before login', 'none', ['A1 CREATE foo'], { A1: 'BAD' }],
    ['DELETE before login', 'none', ['A1 DELETE foo'], { A1: 'BAD' }],
    ['RENAME before login', 'none', ['A1 RENAME foo bar'], { A1: 'BAD' }],
    ['SUBSCRIBE before login', 'none', ['A1 SUBSCRIBE INBOX'], { A1: 'BAD' }],
    ['UNSUBSCRIBE before login', 'none', ['A1 UNSUBSCRIBE INBOX'], { A1: 'BAD' }],
    ['LIST before login', 'none', ['A1 LIST "" "*"'], { A1: 'BAD' }],
    ['LSUB before login', 'none', ['A1 LSUB "" "*"'], { A1: 'BAD' }],
    ['STATUS before login', 'none', ['A1 STATUS INBOX (MESSAGES)'], { A1: 'BAD' }],
    ['FETCH before login', 'none', ['A1 FETCH 1 FLAGS'], { A1: 'BAD' }],
    ['UID FETCH before login', 'none', ['A1 UID FETCH 1 FLAGS'], { A1: 'BAD' }],
    ['LOGIN twice', 'auth', ['A1 LOGIN testuser testpass'], { A1: 'BAD' }],
    ['LOGIN in selected state', 'selected', ['A1 LOGIN testuser testpass'], { A1: 'BAD' }],
    ['CHECK without a selected mailbox', 'auth', ['A1 CHECK'], { A1: 'BAD' }],
    ['CLOSE without a selected mailbox', 'auth', ['A1 CLOSE'], { A1: 'BAD' }],
    ['EXPUNGE without a selected mailbox', 'auth', ['A1 EXPUNGE'], { A1: 'BAD' }],
    ['SEARCH without a selected mailbox', 'auth', ['A1 SEARCH ALL'], { A1: 'BAD' }],
    ['FETCH without a selected mailbox', 'auth', ['A1 FETCH 1 FLAGS'], { A1: 'BAD' }],
    ['STORE without a selected mailbox', 'auth', ['A1 STORE 1 +FLAGS (\\Seen)'], { A1: 'BAD' }],
    ['COPY without a selected mailbox', 'auth', ['A1 COPY 1 INBOX'], { A1: 'BAD' }],
    ['UID SEARCH without a selected mailbox', 'auth', ['A1 UID SEARCH ALL'], { A1: 'BAD' }],
    ['commands valid in any state', 'none', ['A1 CAPABILITY', 'A2 NOOP'], { A1: 'OK', A2: 'OK' }],
    ['authenticated commands are valid when selected', 'selected', ['A1 LIST "" INBOX', 'A2 STATUS INBOX (MESSAGES)'], { A1: 'OK', A2: 'OK' }],

    // "Arguments: none" in RFC 3501 section 6
    ['CAPABILITY with arguments', 'none', ['A1 CAPABILITY x'], { A1: 'BAD' }],
    ['NOOP with arguments', 'none', ['A1 NOOP x'], { A1: 'BAD' }],
    ['LOGOUT with arguments', 'none', ['A1 LOGOUT x'], { A1: 'BAD' }],
    ['CHECK with arguments', 'selected', ['A1 CHECK x'], { A1: 'BAD' }],
    ['CLOSE with arguments', 'selected', ['A1 CLOSE x'], { A1: 'BAD' }],
    ['EXPUNGE with arguments', 'selected', ['A1 EXPUNGE x'], { A1: 'BAD' }],

    // Argument validation, RFC 3501 section 9
    ['unknown command', 'auth', ['A1 FOOBAR'], { A1: 'BAD' }],
    ['unknown UID command', 'selected', ['A1 UID FOOBAR 1'], { A1: 'BAD' }],
    ['LOGIN without a password', 'none', ['A1 LOGIN testuser'], { A1: 'BAD' }],
    ['SELECT without a mailbox', 'auth', ['A1 SELECT'], { A1: 'BAD' }],
    ['SELECT with two mailboxes', 'auth', ['A1 SELECT INBOX INBOX'], { A1: 'BAD' }],
    ['SELECT with a list', 'auth', ['A1 SELECT (INBOX)'], { A1: 'BAD' }],
    ['EXAMINE without a mailbox', 'auth', ['A1 EXAMINE'], { A1: 'BAD' }],
    ['CREATE without a mailbox', 'auth', ['A1 CREATE'], { A1: 'BAD' }],
    ['DELETE without a mailbox', 'auth', ['A1 DELETE'], { A1: 'BAD' }],
    ['RENAME with one mailbox', 'auth', ['A1 RENAME INBOX'], { A1: 'BAD' }],
    ['SUBSCRIBE without a mailbox', 'auth', ['A1 SUBSCRIBE'], { A1: 'BAD' }],
    ['UNSUBSCRIBE without a mailbox', 'auth', ['A1 UNSUBSCRIBE'], { A1: 'BAD' }],
    ['LIST with one argument', 'auth', ['A1 LIST ""'], { A1: 'BAD' }],
    ['LSUB with one argument', 'auth', ['A1 LSUB ""'], { A1: 'BAD' }],
    ['STATUS without items', 'auth', ['A1 STATUS INBOX'], { A1: 'BAD' }],
    ['STATUS with an empty item list', 'auth', ['A1 STATUS INBOX ()'], { A1: 'BAD' }],
    ['STATUS with an unknown item', 'auth', ['A1 STATUS INBOX (FOO)'], { A1: 'BAD' }],
    ['APPEND without a message', 'auth', ['A1 APPEND INBOX'], { A1: 'BAD' }],
    ['APPEND with a quoted message', 'auth', ['A1 APPEND INBOX "Subject: x"'], { A1: 'BAD' }],
    ['APPEND with an invalid date', 'auth', ['A1 APPEND INBOX "32-Jan-2020 00:00:00 +0000" {3}\r\nabc'], { A1: 'BAD' }],
    [
        'APPEND with a lowercase month',
        'auth',
        ['A1 APPEND INBOX "02-jan-2020 03:04:05 +0000" {3}\r\nabc', 'A2 SELECT INBOX', 'A3 FETCH 2 INTERNALDATE'],
        { A1: 'OK', A3: 'OK' }
    ],
    ['APPEND with a quoted flag', 'auth', ['A1 APPEND INBOX ("Seen") {3}\r\nabc'], { A1: 'BAD' }],
    ['FETCH without items', 'selected', ['A1 FETCH 1'], { A1: 'BAD' }],
    ['FETCH with an unknown item', 'selected', ['A1 FETCH 1 (FOO)'], { A1: 'BAD' }],
    ['FETCH with sequence number 0', 'selected', ['A1 FETCH 0 FLAGS'], { A1: 'BAD' }],
    ['STORE with an unknown item', 'selected', ['A1 STORE 1 FOO (\\Seen)'], { A1: 'BAD' }],
    ['STORE without flags', 'selected', ['A1 STORE 1 +FLAGS'], { A1: 'BAD' }],
    ['STORE of \\Recent', 'selected', ['A1 STORE 1 +FLAGS (\\Recent)'], { A1: 'BAD' }],
    ['COPY without a mailbox', 'selected', ['A1 COPY 1'], { A1: 'BAD' }],
    ['SEARCH with an unknown key', 'selected', ['A1 SEARCH FOO'], { A1: 'BAD' }],
    ['SEARCH with an invalid date', 'selected', ['A1 SEARCH SINCE 32-Jan-2020'], { A1: 'BAD' }],

    // Mailbox names use modified UTF-7, RFC 3501 section 5.1.3
    ['CREATE with 8-bit characters', 'auth', ['A1 CREATE {5}\r\ncaf\xe9'], { A1: 'BAD' }],
    ['CREATE without the closing shift', 'auth', ['A1 CREATE "&Jjo!"'], { A1: 'BAD' }],
    ['CREATE with a superfluous shift', 'auth', ['A1 CREATE "&U,BTFw-&ZeVnLIqe-"'], { A1: 'BAD' }],
    ['CREATE with encoded ASCII', 'auth', ['A1 CREATE "&AGE-"'], { A1: 'BAD' }],
    ['CREATE with valid modified UTF-7', 'auth', ['A1 CREATE "&U,BTF2XlZyyKng-"', 'A2 CREATE "a&-b"'], { A1: 'OK', A2: 'OK' }],
    ['SELECT with invalid modified UTF-7', 'auth', ['A1 SELECT "&Jjo!"'], { A1: 'BAD' }],
    ['RENAME to invalid modified UTF-7', 'auth', ['A1 CREATE foo', 'A2 RENAME foo "&Jjo!"'], { A1: 'OK', A2: 'BAD' }],

    // Framing: commands end with CRLF and literals are only accepted when the command can run
    ['command ending with a bare LF', 'none', ['A1 NOOP\nA2 NOOP'], { A1: 'BAD', A2: 'OK' }],
    ['literal for an unknown command', 'auth', ['A1 FOOBAR {3}\r\nabc'], { A1: 'BAD' }, ['+ Go ahead']],
    ['literal for a command in the wrong state', 'none', ['A1 APPEND INBOX {3}\r\nabc'], { A1: 'BAD' }, ['+ Go ahead']],
    ['literal for LOGIN before login', 'none', ['A1 LOGIN {8}\r\ntestuser testpass'], { A1: 'OK' }]
];

describe('Strict command handling', () => {
    const ctx = setupServer(() => ({
        storage: {
            INBOX: {
                messages: [{ raw: 'Subject: hello\r\n\r\nWorld' }]
            },
            '': {}
        }
    }));

    for (const [description, state, commands, expected, absent] of CASES) {
        it(description, (t, done) => {
            ctx.run([...STATES[state], ...commands, 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                for (const tag of Object.keys(expected)) {
                    const match = resp.match(new RegExp('^' + tag + ' (OK|NO|BAD)\\b', 'm'));
                    assert.ok(match, 'no tagged response for ' + tag + '\n' + resp);
                    assert.strictEqual(match[1], expected[tag], tag + ' answered ' + match[1] + '\n' + resp);
                }
                for (const str of absent || []) {
                    assert.ok(resp.indexOf(str) < 0, 'unexpected ' + JSON.stringify(str) + '\n' + resp);
                }
                done();
            });
        });
    }
});

describe('Strict SASL handling', () => {
    const ctx = setupServer(() => ({
        plugins: ['AUTH-PLAIN', 'IDLE']
    }));

    const run = (commands, expected) => (t, done) => {
        ctx.run([...commands, 'ZZ LOGOUT'], resp => {
            resp = resp.toString('binary');
            for (const tag of Object.keys(expected)) {
                const match = resp.match(new RegExp('^' + tag + ' (OK|NO|BAD)\\b', 'm'));
                assert.ok(match, 'no tagged response for ' + tag + '\n' + resp);
                assert.strictEqual(match[1], expected[tag], tag + ' answered ' + match[1] + '\n' + resp);
            }
            done();
        });
    };

    // RFC 3501 section 9: base64 = *(4base64-char) [base64-terminal]
    it('AUTHENTICATE PLAIN with invalid base64', run(['A1 AUTHENTICATE PLAIN', 'not base64!'], { A1: 'BAD' }));
    // RFC 4959: an initial response needs SASL-IR
    it(
        'AUTHENTICATE PLAIN with an initial response but no SASL-IR',
        run(['A1 AUTHENTICATE PLAIN ' + Buffer.from('\0testuser\0testpass').toString('base64')], { A1: 'BAD' })
    );
    // RFC 3501 section 6.2.2: an unsupported mechanism is NO
    it('AUTHENTICATE with an unknown mechanism', run(['A1 AUTHENTICATE FOO'], { A1: 'NO' }));
    // RFC 2177 section 3: IDLE is ended by "DONE" only
    it('IDLE ended by something else than DONE', run(['A1 LOGIN testuser testpass', 'A2 IDLE', 'NOOP'], { A2: 'BAD' }));
});
