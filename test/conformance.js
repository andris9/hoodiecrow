'use strict';

// Table driven checks of how strictly hoodiecrow applies the IMAP grammar and the command
// states. Hoodiecrow is a guardrail for client development, so input that a lenient server
// would accept is refused here. RFC references are to the text at
// https://www.rfc-editor.org/rfc/rfcXXXX.txt

const { describe, it } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { setupServer, assertTagged } = require('./helpers');
const { openSession } = require('./helpers/session');

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
        { A1: 'OK', A3: 'OK' },
        ['02-jan-2020']
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
    // RFC 3501 6.4.4: without CHARSET the search strings are US-ASCII
    ['SEARCH with 8-bit text and no CHARSET', 'selected', ['A1 SEARCH SUBJECT {5}\r\ncaf\xc3\xa9'], { A1: 'BAD' }],
    ['SEARCH with 8-bit text as US-ASCII', 'selected', ['A1 SEARCH CHARSET US-ASCII SUBJECT {5}\r\ncaf\xc3\xa9'], { A1: 'BAD' }],
    ['SEARCH with invalid UTF-8', 'selected', ['A1 SEARCH CHARSET UTF-8 SUBJECT {4}\r\ncaf\xe9'], { A1: 'BAD' }],
    ['SEARCH with UTF-8 text', 'selected', ['A1 SEARCH CHARSET UTF-8 SUBJECT {5}\r\ncaf\xc3\xa9'], { A1: 'OK' }],
    ['SEARCH with an unsupported CHARSET', 'selected', ['A1 SEARCH CHARSET KOI8-R SUBJECT x'], { A1: 'NO' }],
    ['SEARCH with an invalid date', 'selected', ['A1 SEARCH SINCE 32-Jan-2020'], { A1: 'BAD' }],
    // the extensions below are refused when their plugins are not loaded
    ['SEARCH RETURN without ESEARCH', 'selected', ['A1 SEARCH RETURN (MIN) ALL'], { A1: 'BAD' }],
    ['FETCH $ without SEARCHRES', 'selected', ['A1 FETCH $ FLAGS'], { A1: 'BAD' }],
    ['SEARCH MODSEQ without CONDSTORE', 'selected', ['A1 SEARCH MODSEQ 1'], { A1: 'BAD' }],

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

// Extended SEARCH (RFC 4466 section 2.6.1, RFC 4731, RFC 5182, RFC 7162 section 3.1.5), with ESEARCH, SEARCHRES and CONDSTORE loaded
const SEARCH_CASES = [
    ['an unknown SEARCH result option', 'selected', ['A1 SEARCH RETURN (FOO) ALL'], { A1: 'BAD' }],
    ['RETURN without a list', 'selected', ['A1 SEARCH RETURN MIN ALL'], { A1: 'BAD' }],
    ['RETURN after CHARSET', 'selected', ['A1 SEARCH CHARSET UTF-8 RETURN (MIN) ALL'], { A1: 'BAD' }],
    ['RETURN without search criteria', 'selected', ['A1 SEARCH RETURN (MIN)'], { A1: 'BAD' }],
    ['$ combined with sequence numbers', 'selected', ['A1 SEARCH RETURN (SAVE) ALL', 'A2 FETCH 1,$ FLAGS'], { A1: 'OK', A2: 'BAD' }],
    ['MODSEQ with \\Recent', 'selected', ['A1 SEARCH MODSEQ "/flags/\\\\recent" all 1'], { A1: 'BAD' }],
    ['MODSEQ with an unknown entry type', 'selected', ['A1 SEARCH MODSEQ "/flags/\\\\seen" any 1'], { A1: 'BAD' }],
    ['MODSEQ over 63 bits', 'selected', ['A1 SEARCH MODSEQ 9223372036854775808'], { A1: 'BAD' }]
];

// RFC 5464 (METADATA), with the verified errata 2785 and 2786, with METADATA loaded
const METADATA_CASES = [
    // RFC 5464 section 5, getmetadata = "GETMETADATA" [SP getmetadata-options] SP mailbox SP entries
    ['GETMETADATA without entries', 'auth', ['A1 GETMETADATA INBOX'], { A1: 'BAD' }],
    ['GETMETADATA with an empty entry list', 'auth', ['A1 GETMETADATA INBOX ()'], { A1: 'BAD' }],
    ['GETMETADATA with an empty option list', 'auth', ['A1 GETMETADATA () INBOX /shared/comment'], { A1: 'BAD' }],
    // errata 2785: options come before the mailbox name
    ['GETMETADATA with options after the mailbox', 'auth', ['A1 GETMETADATA INBOX (MAXSIZE 10) /shared/comment'], { A1: 'BAD' }],
    ['GETMETADATA with an unknown option', 'auth', ['A1 GETMETADATA (FOO 1) INBOX /shared/comment'], { A1: 'BAD' }],
    ['GETMETADATA with MAXSIZE without a value', 'auth', ['A1 GETMETADATA (MAXSIZE) INBOX /shared/comment'], { A1: 'BAD' }],
    ['GETMETADATA with a negative MAXSIZE', 'auth', ['A1 GETMETADATA (MAXSIZE -1) INBOX /shared/comment'], { A1: 'BAD' }],
    ['GETMETADATA with a quoted MAXSIZE', 'auth', ['A1 GETMETADATA (MAXSIZE "10") INBOX /shared/comment'], { A1: 'BAD' }],
    ['GETMETADATA with a MAXSIZE over 32 bits', 'auth', ['A1 GETMETADATA (MAXSIZE 4294967296) INBOX /shared/comment'], { A1: 'BAD' }],
    ['GETMETADATA with DEPTH 2', 'auth', ['A1 GETMETADATA (DEPTH 2) INBOX /shared'], { A1: 'BAD' }],
    ['GETMETADATA with a list as mailbox name', 'auth', ['A1 GETMETADATA (INBOX) /shared/comment'], { A1: 'BAD' }],
    ['GETMETADATA with an invalid mailbox name', 'auth', ['A1 GETMETADATA "&Jjo!" /shared/comment'], { A1: 'BAD' }],
    ['GETMETADATA with a nested entry list', 'auth', ['A1 GETMETADATA INBOX ((/shared/comment))'], { A1: 'BAD' }],
    // RFC 5464 section 3.2: invalid entry names result in a BAD response
    ['entry name without leading "/"', 'auth', ['A1 GETMETADATA INBOX shared/comment'], { A1: 'BAD' }],
    ['entry name with "//"', 'auth', ['A1 GETMETADATA INBOX /shared//comment'], { A1: 'BAD' }],
    ['entry name ending with "/"', 'auth', ['A1 GETMETADATA INBOX /shared/comment/'], { A1: 'BAD' }],
    ['entry name "/"', 'auth', ['A1 GETMETADATA (DEPTH infinity) INBOX /'], { A1: 'BAD' }],
    ['entry name with "*"', 'auth', ['A1 GETMETADATA INBOX "/shared/*"'], { A1: 'BAD' }],
    ['entry name with "%"', 'auth', ['A1 GETMETADATA INBOX "/shared/%"'], { A1: 'BAD' }],
    ['entry name with a control character', 'auth', ['A1 GETMETADATA INBOX {9}\r\n/shared/\x01'], { A1: 'BAD' }],
    ['entry name with 8-bit characters', 'auth', ['A1 GETMETADATA INBOX {10}\r\n/shared/\xc3\xa9'], { A1: 'BAD' }],
    ['entry name outside /private and /shared', 'auth', ['A1 GETMETADATA INBOX /comment'], { A1: 'BAD' }],
    ['GETMETADATA of a scope', 'auth', ['A1 GETMETADATA INBOX (/shared /PRIVATE)'], { A1: 'OK' }],
    ['SETMETADATA of a scope', 'auth', ['A1 SETMETADATA INBOX (/shared "x")'], { A1: 'BAD' }],
    ['SETMETADATA of a short vendor entry', 'auth', ['A1 SETMETADATA INBOX (/shared/vendor/vendor.example "x")'], { A1: 'BAD' }],
    ['SETMETADATA of a vendor entry', 'auth', ['A1 SETMETADATA INBOX (/shared/vendor/vendor.example/x "x")'], { A1: 'OK' }],
    // setmetadata = "SETMETADATA" SP mailbox SP entry-values
    ['SETMETADATA without a list', 'auth', ['A1 SETMETADATA INBOX /shared/comment "x"'], { A1: 'BAD' }],
    ['SETMETADATA with an empty list', 'auth', ['A1 SETMETADATA INBOX ()'], { A1: 'BAD' }],
    ['SETMETADATA without a value', 'auth', ['A1 SETMETADATA INBOX (/shared/comment)'], { A1: 'BAD' }],
    ['SETMETADATA with an atom value', 'auth', ['A1 SETMETADATA INBOX (/shared/comment value)'], { A1: 'BAD' }],
    ['SETMETADATA with a list value', 'auth', ['A1 SETMETADATA INBOX (/shared/comment (x))'], { A1: 'BAD' }],
    ['SETMETADATA with a list as entry name', 'auth', ['A1 SETMETADATA INBOX ((/shared/comment) "x")'], { A1: 'BAD' }],
    ['SETMETADATA with an invalid mailbox name', 'auth', ['A1 SETMETADATA "&Jjo!" (/shared/comment "x")'], { A1: 'BAD' }],
    // RFC 5464 section 3.2: clients MUST use CRLF for line ends in a value
    ['SETMETADATA with a bare LF in a value', 'auth', ['A1 SETMETADATA INBOX (/shared/comment {3}\r\na\nb)'], { A1: 'BAD' }],
    ['SETMETADATA with a bare CR in a value', 'auth', ['A1 SETMETADATA INBOX (/shared/comment {3}\r\na\rb)'], { A1: 'BAD' }],
    ['SETMETADATA with CRLF in a value', 'auth', ['A1 SETMETADATA INBOX (/shared/comment {4}\r\na\r\nb)'], { A1: 'OK' }],
    // literal8 (RFC 3516) values are not supported by the parser yet
    ['SETMETADATA with a literal8 value', 'auth', ['A1 SETMETADATA INBOX (/shared/comment ~{1}\r\na)'], { A1: 'BAD' }],
    // RFC 5464 section 4.2 and 4.3: authenticated or selected state only
    ['GETMETADATA before login', 'none', ['A1 GETMETADATA "" /shared/comment'], { A1: 'BAD' }],
    ['SETMETADATA before login', 'none', ['A1 SETMETADATA "" (/shared/comment "x")'], { A1: 'BAD' }]
];

// Defines a test for every case: runs the commands in the wanted state and checks the tagged results
function defineCases(ctx, cases) {
    for (const [description, state, commands, expected, absent] of cases) {
        it(description, (t, done) => {
            ctx.run([...STATES[state], ...commands, 'ZZ LOGOUT'], resp => {
                resp = resp.toString('binary');
                assertTagged(resp, expected);
                for (const str of absent || []) {
                    assert.ok(resp.indexOf(str) < 0, 'unexpected ' + JSON.stringify(str) + '\n' + resp);
                }
                done();
            });
        });
    }
}

describe('Strict command handling', () => {
    const ctx = setupServer(() => ({
        storage: {
            INBOX: {
                messages: [{ raw: 'Subject: hello\r\n\r\nWorld' }]
            },
            '': {}
        }
    }));

    defineCases(ctx, CASES);
});

describe('Strict extended SEARCH handling', () => {
    const ctx = setupServer(() => ({
        plugins: ['ESEARCH', 'SEARCHRES', 'CONDSTORE'],
        storage: {
            INBOX: {
                messages: [{ raw: 'Subject: hello\r\n\r\nWorld' }]
            },
            '': {}
        }
    }));

    defineCases(ctx, SEARCH_CASES);
});

// Extended LIST: RFC 5258 (LIST-EXTENDED), RFC 6154 (SPECIAL-USE), RFC 5819 (LIST-STATUS)
const LIST_EXTENDED_CASES = [
    // RFC 5258 section 3.1: RECURSIVEMATCH must not be the only selection option (or only with REMOTE)
    ['LIST (RECURSIVEMATCH)', 'auth', ['A1 LIST (RECURSIVEMATCH) "" "*"'], { A1: 'BAD' }],
    ['LIST (REMOTE RECURSIVEMATCH)', 'auth', ['A1 LIST (REMOTE RECURSIVEMATCH) "" "*"'], { A1: 'BAD' }],
    // RFC 6154 section 6: SPECIAL-USE is a list-select-independent-opt, RECURSIVEMATCH needs a base option
    ['LIST (SPECIAL-USE RECURSIVEMATCH)', 'auth', ['A1 LIST (SPECIAL-USE RECURSIVEMATCH) "" "*"'], { A1: 'BAD' }],
    ['LIST (SUBSCRIBED REMOTE RECURSIVEMATCH)', 'auth', ['A1 LIST (SUBSCRIBED REMOTE RECURSIVEMATCH) "" "*" RETURN ()'], { A1: 'OK' }],
    // RFC 5258 section 3: unknown options are BAD
    ['LIST with an unknown selection option', 'auth', ['A1 LIST (FOO) "" "*"'], { A1: 'BAD' }],
    ['LIST with an unknown return option', 'auth', ['A1 LIST "" "*" RETURN (FOO)'], { A1: 'BAD' }],
    // RFC 5258 section 6: option-standard-tag is an atom, option-value only for options that take one
    ['LIST with a quoted selection option', 'auth', ['A1 LIST ("SUBSCRIBED") "" "*"'], { A1: 'BAD' }],
    ['LIST with a value for SUBSCRIBED', 'auth', ['A1 LIST (SUBSCRIBED (x)) "" "*"'], { A1: 'BAD' }],
    ['LIST with a value for CHILDREN', 'auth', ['A1 LIST "" "*" RETURN (CHILDREN (x))'], { A1: 'BAD' }],
    // RFC 5258 section 6: patterns = "(" list-mailbox *(SP list-mailbox) ")"
    ['LIST with an empty pattern list', 'auth', ['A1 LIST "" ()'], { A1: 'BAD' }],
    ['LIST with a nested pattern list', 'auth', ['A1 LIST "" (("INBOX"))'], { A1: 'BAD' }],
    ['LIST with a list as the reference', 'auth', ['A1 LIST () ("INBOX") "*"'], { A1: 'BAD' }],
    ['LIST with selection options and no pattern', 'auth', ['A1 LIST (SUBSCRIBED) ""'], { A1: 'BAD' }],
    // RFC 5258 section 6: list-return-opts = "RETURN" SP "(" [return-option *(SP return-option)] ")"
    ['LIST with RETURN and no list', 'auth', ['A1 LIST "" "*" RETURN'], { A1: 'BAD' }],
    ['LIST with RETURN and an atom', 'auth', ['A1 LIST "" "*" RETURN CHILDREN'], { A1: 'BAD' }],
    ['LIST with a misspelled RETURN', 'auth', ['A1 LIST "" "*" RETURNS (CHILDREN)'], { A1: 'BAD' }],
    ['LIST with arguments after the return options', 'auth', ['A1 LIST "" "*" RETURN (CHILDREN) x'], { A1: 'BAD' }],
    // RFC 5819 section 4: status-option = "STATUS" SP "(" status-att *(SP status-att) ")"
    ['LIST RETURN (STATUS) without items', 'auth', ['A1 LIST "" "*" RETURN (STATUS)'], { A1: 'BAD' }],
    ['LIST RETURN (STATUS) with an empty list', 'auth', ['A1 LIST "" "*" RETURN (STATUS ())'], { A1: 'BAD' }],
    ['LIST RETURN (STATUS) with an unknown item', 'auth', ['A1 LIST "" "*" RETURN (STATUS (FOO))'], { A1: 'BAD' }],
    ['LIST RETURN (STATUS) with valid items', 'auth', ['A1 LIST "" "*" RETURN (STATUS (MESSAGES SIZE))'], { A1: 'OK' }]
];

describe('Strict extended LIST', () => {
    const ctx = setupServer(() => ({
        plugins: ['LIST-EXTENDED', 'LIST-STATUS', 'SPECIAL-USE', 'STATUS=SIZE']
    }));

    defineCases(ctx, LIST_EXTENDED_CASES);
});

describe('Strict METADATA handling', () => {
    const ctx = setupServer(() => ({
        plugins: ['METADATA'],
        storage: {
            INBOX: {
                messages: [{ raw: 'Subject: hello\r\n\r\nWorld' }],
                metadata: { '/shared/comment': 'Shared comment' }
            },
            '': {}
        }
    }));

    defineCases(ctx, METADATA_CASES);
});

describe('Literal synchronization', () => {
    const ctx = setupServer();

    // RFC 3501 section 4.3: the client MUST wait for the continuation request, even for {0}
    it('refuses literal data sent before the continuation request', (t, done) => {
        const socket = net.connect(ctx.server.address().port, 'localhost');
        let resp = '';
        socket.on('data', chunk => {
            resp += chunk.toString('binary');
        });
        socket.on('close', () => {
            assert.ok(resp.indexOf('+ Go ahead') < 0, resp);
            assert.ok(/^A1 BAD /m.test(resp), resp);
            assert.ok(/^A2 BAD /m.test(resp), resp);
            assert.ok(/^A3 OK /m.test(resp), resp);
            done();
        });
        socket.once('data', () => {
            socket.write('A1 LOGIN {8}\r\ntestuser testpass\r\nA2 LOGIN {0}\r\n testpass\r\nA3 NOOP\r\nA4 LOGOUT\r\n');
        });
    });
});

describe('Pipelining ambiguity', () => {
    const ctx = setupServer(() => ({
        storage: {
            INBOX: {
                messages: [{ raw: 'Subject: hello 1\r\n\r\nWorld' }, { raw: 'Subject: hello 2\r\n\r\nWorld' }]
            },
            '': {}
        }
    }));

    // Logs in and selects INBOX one command at a time, then sends `batch` in one write
    const pipeline = (batch, callback) => {
        openSession(ctx.server.address().port, session => {
            session.run('S1 LOGIN testuser testpass', () => {
                session.run('S2 SELECT INBOX', () => {
                    const last = batch[batch.length - 1].split(' ').shift();
                    session.run(
                        batch.join('\r\n'),
                        resp => {
                            session.close();
                            callback(resp);
                        },
                        last
                    );
                });
            });
        });
    };

    // RFC 3501 section 5.5 lists these as invalid non-waiting command sequences
    const INVALID = [
        ['FETCH + NOOP + STORE', ['A1 FETCH 1 FLAGS', 'A2 NOOP', 'A3 STORE 1 +FLAGS (\\Seen)'], 'A3'],
        ['STORE + COPY + FETCH', ['A1 STORE 1 +FLAGS (\\Seen)', 'A2 COPY 1 INBOX', 'A3 FETCH 1 FLAGS'], 'A3'],
        ['COPY + COPY', ['A1 COPY 1 INBOX', 'A2 COPY 1 INBOX'], 'A2'],
        ['CHECK + FETCH', ['A1 CHECK', 'A2 FETCH 1 FLAGS'], 'A2'],
        ['UID SEARCH + SEARCH with sequence numbers', ['A1 UID SEARCH ALL', 'A2 SEARCH 1:2'], 'A2']
    ];

    // and these as valid ones
    const VALID = [
        ['FETCH + STORE + SEARCH + CHECK', ['A1 FETCH 1 FLAGS', 'A2 STORE 1 +FLAGS (\\Seen)', 'A3 SEARCH 1', 'A4 CHECK']],
        ['STORE + COPY + EXPUNGE', ['A1 STORE 1 +FLAGS (\\Seen)', 'A2 COPY 1 INBOX', 'A3 EXPUNGE']],
        ['UID SEARCH + UID SEARCH without sequence numbers', ['A1 UID SEARCH ALL', 'A2 UID SEARCH UID 1:*']],
        ['NOOP + UID FETCH', ['A1 NOOP', 'A2 UID FETCH 1:* FLAGS']]
    ];

    for (const [description, batch, refused] of INVALID) {
        it('refuses ' + description, (t, done) => {
            pipeline(batch, resp => {
                for (const command of batch) {
                    const tag = command.split(' ').shift();
                    const expected = tag === refused ? 'BAD' : 'OK';
                    assert.ok(new RegExp('^' + tag + ' ' + expected + ' ', 'm').test(resp), tag + ' should be ' + expected + '\n' + resp);
                }
                done();
            });
        });
    }

    for (const [description, batch] of VALID) {
        it('accepts ' + description, (t, done) => {
            pipeline(batch, resp => {
                for (const command of batch) {
                    const tag = command.split(' ').shift();
                    assert.ok(new RegExp('^' + tag + ' OK ', 'm').test(resp), tag + ' should be OK\n' + resp);
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
            assertTagged(resp, expected);
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
