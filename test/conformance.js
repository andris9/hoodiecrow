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
    selected: [LOGIN, SELECT],
    // RFC 9755: UTF8=ACCEPT enabled, needs the UTF8=ACCEPT plugin
    utf8: [LOGIN, 'L3 ENABLE UTF8=ACCEPT'],
    'utf8 selected': [LOGIN, 'L3 ENABLE UTF8=ACCEPT', SELECT],
    // QRESYNC enabled (RFC 7162 section 3.2.3)
    qresync: [LOGIN, 'L3 ENABLE QRESYNC'],
    qresyncSelected: [LOGIN, 'L3 ENABLE QRESYNC', SELECT],
    // RFC 9051 Appendix A: IMAP4rev2 enabled, needs the IMAP4rev2 plugin
    rev2: [LOGIN, 'L3 ENABLE IMAP4rev2'],
    'rev2 selected': [LOGIN, 'L3 ENABLE IMAP4rev2', SELECT],
    // UIDONLY enabled (RFC 9586 section 3.1)
    uidonly: [LOGIN, 'L3 ENABLE UIDONLY QRESYNC', SELECT]
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
    // RFC 4466 section 3: a single append-message unless MULTIAPPEND is advertised
    ['APPEND with two messages without MULTIAPPEND', 'auth', ['A1 APPEND INBOX {3}\r\nabc {3}\r\ndef'], { A1: 'BAD' }],
    // RFC 4469 section 5: the CATENATE form needs the CATENATE extension
    ['APPEND with CATENATE without the extension', 'auth', ['A1 APPEND INBOX CATENATE (TEXT {3}\r\nabc)'], { A1: 'BAD' }],
    // REPLACE (RFC 8508) is not a command without the extension
    ['REPLACE without the extension', 'selected', ['A1 REPLACE 1 INBOX {3}\r\nabc'], { A1: 'BAD' }, ['+ Go ahead']],
    ['FETCH without items', 'selected', ['A1 FETCH 1'], { A1: 'BAD' }],
    ['FETCH with an unknown item', 'selected', ['A1 FETCH 1 (FOO)'], { A1: 'BAD' }],
    ['FETCH with sequence number 0', 'selected', ['A1 FETCH 0 FLAGS'], { A1: 'BAD' }],
    // RFC 3501 and RFC 9051 section 9: seq-number = nz-number / "*", nz-number is a 32-bit value, for UIDs too
    [
        'sequence sets with numbers above 2^32-1',
        'selected',
        ['A1 UID FETCH 4294967296 FLAGS', 'A2 UID FETCH 1:9999999999 FLAGS', 'A3 UID STORE 1,4294967296 +FLAGS (\\Seen)', 'A4 UID FETCH 1:4294967295 FLAGS'],
        { A1: 'BAD', A2: 'BAD', A3: 'BAD', A4: 'OK' }
    ],
    // RFC 3501 and RFC 9051 section 9 (seq-number): a sequence number greater than the number of messages
    // is answered with BAD, "*" too when the mailbox is empty. UID sets and SEARCH keys are not affected
    [
        'FETCH past the last message',
        'selected',
        ['A1 FETCH 2 FLAGS', 'A2 FETCH 1:2 FLAGS', 'A3 FETCH 1,3 FLAGS', 'A4 FETCH 1:* FLAGS'],
        { A1: 'BAD', A2: 'BAD', A3: 'BAD', A4: 'OK' }
    ],
    ['STORE past the last message', 'selected', ['A1 STORE 2 +FLAGS (\\Seen)', 'A2 STORE 2:* +FLAGS (\\Seen)'], { A1: 'BAD', A2: 'BAD' }],
    ['COPY past the last message', 'selected', ['A1 COPY 2 INBOX'], { A1: 'BAD' }],
    [
        'sequence numbers in an empty mailbox',
        'auth',
        ['A1 CREATE Empty', 'A2 SELECT Empty', 'A3 FETCH * FLAGS', 'A4 FETCH 1 FLAGS', 'A5 STORE 1:* +FLAGS (\\Seen)', 'A6 COPY * INBOX'],
        { A3: 'BAD', A4: 'BAD', A5: 'BAD', A6: 'BAD' }
    ],
    [
        'UID sets and SEARCH keys past the last message',
        'auth',
        [
            'A1 CREATE Empty',
            'A2 SELECT Empty',
            'A3 UID FETCH 1:* FLAGS',
            'A4 UID STORE 5 +FLAGS (\\Seen)',
            'A5 UID COPY * INBOX',
            'A6 SEARCH 1:5',
            'A7 SEARCH *'
        ],
        { A3: 'OK', A4: 'OK', A5: 'OK', A6: 'OK', A7: 'OK' }
    ],
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
    ['SELECT QRESYNC without QRESYNC', 'auth', ['A1 SELECT INBOX (QRESYNC (1 1))'], { A1: 'BAD' }],
    ['FETCH PARTIAL without PARTIAL', 'selected', ['A1 UID FETCH 1:* FLAGS (PARTIAL 1:5)'], { A1: 'BAD' }],
    ['CANCELUPDATE without CONTEXT=SEARCH', 'selected', ['A1 CANCELUPDATE "A1"'], { A1: 'BAD' }],
    ['ESEARCH without MULTISEARCH', 'selected', ['A1 ESEARCH ALL'], { A1: 'BAD' }],

    // RFC 3501 section 9: NIL is an atom, so it is a valid astring where the grammar has no nstring
    [
        'NIL as a mailbox name and a search string',
        'selected',
        ['A1 CREATE nil', 'A2 LIST "" nil', 'A3 STATUS NIL (MESSAGES)', 'A4 SEARCH SUBJECT NIL', 'A5 SELECT nil'],
        { A1: 'OK', A2: 'OK', A3: 'NO', A4: 'OK', A5: 'OK' },
        ['A1 BAD', 'A2 BAD']
    ],
    ['LOGIN with NIL as the user name', 'none', ['A1 LOGIN NIL NIL'], { A1: 'NO' }],
    // Mailbox names use modified UTF-7, RFC 3501 section 5.1.3
    ['CREATE with 8-bit characters', 'auth', ['A1 CREATE {5}\r\ncaf\xe9'], { A1: 'BAD' }],
    ['CREATE without the closing shift', 'auth', ['A1 CREATE "&Jjo!"'], { A1: 'BAD' }],
    ['CREATE with a superfluous shift', 'auth', ['A1 CREATE "&U,BTFw-&ZeVnLIqe-"'], { A1: 'BAD' }],
    ['CREATE with encoded ASCII', 'auth', ['A1 CREATE "&AGE-"'], { A1: 'BAD' }],
    // RFC 3501 section 5.1.3 encodes 0x00-0x1f in modified BASE64, only RFC 9755 section 3 forbids control characters
    ['CREATE with an encoded control character', 'auth', ['A1 CREATE "a&AA0-b"'], { A1: 'OK' }],
    ['CREATE with valid modified UTF-7', 'auth', ['A1 CREATE "&U,BTF2XlZyyKng-"', 'A2 CREATE "a&-b"'], { A1: 'OK', A2: 'OK' }],
    ['SELECT with invalid modified UTF-7', 'auth', ['A1 SELECT "&Jjo!"'], { A1: 'BAD' }],
    ['RENAME to invalid modified UTF-7', 'auth', ['A1 CREATE foo', 'A2 RENAME foo "&Jjo!"'], { A1: 'OK', A2: 'BAD' }],

    // Framing: commands end with CRLF and literals are only accepted when the command can run
    ['command ending with a bare LF', 'none', ['A1 NOOP\nA2 NOOP'], { A1: 'BAD', A2: 'OK' }],
    ['literal for an unknown command', 'auth', ['A1 FOOBAR {3}\r\nabc'], { A1: 'BAD' }, ['+ Go ahead']],
    ['literal for a command in the wrong state', 'none', ['A1 APPEND INBOX {3}\r\nabc'], { A1: 'BAD' }, ['+ Go ahead']],
    ['literal for LOGIN before login', 'none', ['A1 LOGIN {8}\r\ntestuser testpass'], { A1: 'OK' }],
    // RFC 3516: literal8 only exists with the BINARY extension
    ['literal8 without BINARY', 'auth', ['A1 APPEND INBOX ~{3}\r\nabc'], { A1: 'BAD' }, ['+ Go ahead']],
    ['BINARY fetch item without BINARY', 'selected', ['A1 FETCH 1 BINARY.PEEK[1]'], { A1: 'BAD' }]
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

// PARTIAL (RFC 9394), CONTEXT=SEARCH and CONTEXT=SORT (RFC 5267), MULTISEARCH (RFC 7377), with these and SEARCHRES loaded
const CONTEXT_CASES = [
    // RFC 9394 section 3.1 and RFC 5267 section 4.4: one PARTIAL or one ALL
    ['PARTIAL with ALL', 'selected', ['A1 SEARCH RETURN (PARTIAL 1:5 ALL) ALL'], { A1: 'BAD' }],
    ['PARTIAL twice', 'selected', ['A1 SEARCH RETURN (PARTIAL 1:5 PARTIAL 6:9) ALL'], { A1: 'BAD' }],
    ['ALL twice with PARTIAL loaded', 'selected', ['A1 SEARCH RETURN (ALL ALL) ALL'], { A1: 'BAD' }],
    // RFC 9394 section 4: partial-range-first = nz-number ":" nz-number, partial-range-last = MINUS nz-number ":" MINUS nz-number
    ['PARTIAL without a range', 'selected', ['A1 SEARCH RETURN (PARTIAL) ALL'], { A1: 'BAD' }],
    ['PARTIAL with zero', 'selected', ['A1 SEARCH RETURN (PARTIAL 0:5) ALL'], { A1: 'BAD' }],
    ['PARTIAL with "*"', 'selected', ['A1 SEARCH RETURN (PARTIAL 1:*) ALL'], { A1: 'BAD' }],
    ['PARTIAL with mixed signs', 'selected', ['A1 SEARCH RETURN (PARTIAL -1:5) ALL'], { A1: 'BAD' }],
    ['PARTIAL with a single number', 'selected', ['A1 SEARCH RETURN (PARTIAL 5) ALL'], { A1: 'BAD' }],
    ['PARTIAL with a quoted range', 'selected', ['A1 SEARCH RETURN (PARTIAL "1:5") ALL'], { A1: 'BAD' }],
    ['PARTIAL over 32 bits', 'selected', ['A1 SEARCH RETURN (PARTIAL 1:4294967296) ALL'], { A1: 'BAD' }],
    ['PARTIAL fetch modifier twice', 'selected', ['A1 UID FETCH 1:* FLAGS (PARTIAL 1:5 PARTIAL 1:2)'], { A1: 'BAD' }],
    ['PARTIAL fetch modifier without a range', 'selected', ['A1 UID FETCH 1:* FLAGS (PARTIAL)'], { A1: 'BAD' }],
    // RFC 5267 section 4.3, tag reuse is covered in test/context-search.js
    ['UPDATE twice', 'selected', ['A1 SEARCH RETURN (UPDATE UPDATE) ALL'], { A1: 'BAD' }],
    // RFC 5267 section 5: command-select =/ "CANCELUPDATE" 1*(SP quoted)
    ['CANCELUPDATE without tags', 'selected', ['A1 CANCELUPDATE'], { A1: 'BAD' }],
    ['CANCELUPDATE with an atom', 'selected', ['A1 SEARCH RETURN (UPDATE) ALL', 'A2 CANCELUPDATE A1'], { A1: 'OK', A2: 'BAD' }],
    ['CANCELUPDATE with an unknown tag', 'selected', ['A1 CANCELUPDATE "A1"'], { A1: 'NO' }],
    ['CANCELUPDATE without a selected mailbox', 'auth', ['A1 CANCELUPDATE "A1"'], { A1: 'BAD' }],
    // RFC 7377 section 2.2
    ['ESEARCH with selected-delayed', 'selected', ['A1 ESEARCH IN (selected-delayed) ALL'], { A1: 'BAD' }],
    ['ESEARCH with an empty source list', 'selected', ['A1 ESEARCH IN () ALL'], { A1: 'BAD' }],
    ['ESEARCH with scope options', 'selected', ['A1 ESEARCH IN (personal (depth 1)) ALL'], { A1: 'BAD' }],
    ['ESEARCH with mailboxes but no name', 'selected', ['A1 ESEARCH IN (mailboxes) ALL'], { A1: 'BAD' }],
    ['ESEARCH with an invalid mailbox name', 'selected', ['A1 ESEARCH IN (mailboxes "&Jjo!") ALL'], { A1: 'BAD' }],
    ['ESEARCH of the selected mailbox without one', 'auth', ['A1 ESEARCH ALL', 'A2 ESEARCH IN (selected personal) ALL'], { A1: 'BAD', A2: 'BAD' }],
    ['ESEARCH of other mailboxes without a selected one', 'auth', ['A1 ESEARCH IN (personal) ALL'], { A1: 'OK' }],
    ['ESEARCH SAVE of other mailboxes', 'selected', ['A1 ESEARCH IN (selected personal) RETURN (SAVE) ALL'], { A1: 'BAD' }],
    ['ESEARCH UPDATE without a selected mailbox', 'auth', ['A1 ESEARCH IN (personal) RETURN (UPDATE) ALL'], { A1: 'BAD' }],
    ['ESEARCH before login', 'none', ['A1 ESEARCH IN (personal) ALL'], { A1: 'BAD' }],
    ['UID ESEARCH', 'selected', ['A1 UID ESEARCH ALL'], { A1: 'BAD' }]
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
    // RFC 5464 section 5: value = nstring / literal8, binary data is not held to the CRLF rule
    ['SETMETADATA with a literal8 value', 'auth', ['A1 SETMETADATA INBOX (/shared/comment ~{3}\r\na\nb)'], { A1: 'OK' }],
    ['literal8 as a GETMETADATA entry name', 'auth', ['A1 GETMETADATA INBOX ~{15}\r\n/shared/comment'], { A1: 'BAD' }, ['+ Go ahead']],
    // RFC 5464 section 4.2 and 4.3: authenticated or selected state only
    ['GETMETADATA before login', 'none', ['A1 GETMETADATA "" /shared/comment'], { A1: 'BAD' }],
    ['SETMETADATA before login', 'none', ['A1 SETMETADATA "" (/shared/comment "x")'], { A1: 'BAD' }]
];

// QRESYNC, RFC 7162 sections 3.2.3, 3.2.5, 3.2.6 and 7, with the QRESYNC plugin loaded
const QRESYNC_CASES = [
    ['QRESYNC parameter without ENABLE QRESYNC', 'auth', ['A1 SELECT INBOX (QRESYNC (1 1))'], { A1: 'BAD' }],
    ['VANISHED without ENABLE QRESYNC', 'selected', ['A1 UID FETCH 1:* FLAGS (CHANGEDSINCE 1 VANISHED)'], { A1: 'BAD' }],
    ['QRESYNC parameter without a value', 'qresync', ['A1 SELECT INBOX (QRESYNC)'], { A1: 'BAD' }],
    // RFC 7162 section 7: CHANGEDSINCE takes a mod-sequence-value (1*DIGIT, at least 1, 63-bit), UNCHANGEDSINCE a
    // mod-sequence-valzer (0 allowed). Neither is a quoted string
    [
        'CONDSTORE modifiers by the grammar',
        'selected',
        [
            'A1 FETCH 1 FLAGS (CHANGEDSINCE 0)',
            'A2 FETCH 1 FLAGS (CHANGEDSINCE "1")',
            'A3 FETCH 1 FLAGS (CHANGEDSINCE 9223372036854775807)',
            'A4 FETCH 1 FLAGS (CHANGEDSINCE 9223372036854775808)',
            'A5 STORE 1 (UNCHANGEDSINCE "0") +FLAGS (x)',
            'A6 STORE 1 (UNCHANGEDSINCE 0) +FLAGS (x)'
        ],
        { A1: 'BAD', A2: 'BAD', A3: 'OK', A4: 'BAD', A5: 'BAD', A6: 'OK' }
    ],
    ['QRESYNC without a mod-sequence', 'qresync', ['A1 EXAMINE INBOX (QRESYNC (1))'], { A1: 'BAD' }],
    ['QRESYNC with UIDVALIDITY 0', 'qresync', ['A1 SELECT INBOX (QRESYNC (0 1))'], { A1: 'BAD' }],
    ['QRESYNC with a 33-bit UIDVALIDITY', 'qresync', ['A1 SELECT INBOX (QRESYNC (4294967296 1))'], { A1: 'BAD' }],
    ['QRESYNC with mod-sequence 0', 'qresync', ['A1 SELECT INBOX (QRESYNC (1 0))'], { A1: 'BAD' }],
    ['QRESYNC with a mod-sequence over 63 bits', 'qresync', ['A1 SELECT INBOX (QRESYNC (1 9223372036854775808))'], { A1: 'BAD' }],
    ['QRESYNC known-uids with *', 'qresync', ['A1 SELECT INBOX (QRESYNC (1 1 1:*))'], { A1: 'BAD' }],
    ['QRESYNC known-uids with 0', 'qresync', ['A1 SELECT INBOX (QRESYNC (1 1 0:3))'], { A1: 'BAD' }],
    ['QRESYNC sets of different sizes', 'qresync', ['A1 SELECT INBOX (QRESYNC (1 1 1:3 (1:2 1:3)))'], { A1: 'BAD' }],
    ['QRESYNC sets in descending order', 'qresync', ['A1 SELECT INBOX (QRESYNC (1 1 1:3 (2,1 3,1)))'], { A1: 'BAD' }],
    ['QRESYNC sets with a reversed range', 'qresync', ['A1 SELECT INBOX (QRESYNC (1 1 1:3 (2:1 3:2)))'], { A1: 'BAD' }],
    ['QRESYNC with an empty sequence match list', 'qresync', ['A1 SELECT INBOX (QRESYNC (1 1 1:3 ()))'], { A1: 'BAD' }],
    ['QRESYNC with extra values', 'qresync', ['A1 SELECT INBOX (QRESYNC (1 1 1:3 (1 1) x))'], { A1: 'BAD' }],
    ['QRESYNC twice', 'qresync', ['A1 SELECT INBOX (QRESYNC (1 1) QRESYNC (1 1))'], { A1: 'BAD' }],
    ['QRESYNC with CONDSTORE', 'qresync', ['A1 SELECT INBOX (QRESYNC (1 1 1:3 (1 1)) CONDSTORE)'], { A1: 'OK' }],
    ['VANISHED with FETCH', 'qresyncSelected', ['A1 FETCH 1:* FLAGS (CHANGEDSINCE 1 VANISHED)'], { A1: 'BAD' }],
    ['VANISHED without CHANGEDSINCE', 'qresyncSelected', ['A1 UID FETCH 1:* FLAGS (VANISHED)'], { A1: 'BAD' }],
    ['VANISHED twice', 'qresyncSelected', ['A1 UID FETCH 1:* FLAGS (CHANGEDSINCE 1 VANISHED VANISHED)'], { A1: 'BAD' }],
    ['VANISHED with CHANGEDSINCE', 'qresyncSelected', ['A1 UID FETCH 1:* FLAGS (CHANGEDSINCE 1 VANISHED)'], { A1: 'OK' }]
];

// Defines a test for every case: runs the commands in the wanted state and checks the tagged results
// RFC 9586 section 3: once UIDONLY is enabled, message numbers in any argument are refused with BAD [UIDREQUIRED].
// RFC 9738 section 3.2: UIDAFTER and UIDBEFORE take a uniqueid
const UIDONLY_CASES = [
    ['FETCH after ENABLE UIDONLY', 'uidonly', ['A1 FETCH 1 FLAGS'], { A1: 'BAD' }, ['* 1 FETCH']],
    ['STORE after ENABLE UIDONLY', 'uidonly', ['A1 STORE 1 +FLAGS (\\Seen)'], { A1: 'BAD' }],
    ['SEARCH after ENABLE UIDONLY', 'uidonly', ['A1 SEARCH ALL'], { A1: 'BAD' }, ['* SEARCH']],
    ['COPY after ENABLE UIDONLY', 'uidonly', ['A1 COPY 1 INBOX'], { A1: 'BAD' }],
    ['MOVE after ENABLE UIDONLY', 'uidonly', ['A1 MOVE 1 INBOX'], { A1: 'BAD' }],
    ['UID SEARCH with a sequence set after ENABLE UIDONLY', 'uidonly', ['A1 UID SEARCH 1'], { A1: 'BAD' }, ['* SEARCH']],
    ['UID SEARCH with a UID set after ENABLE UIDONLY', 'uidonly', ['A1 UID SEARCH UID 1'], { A1: 'OK' }],
    ['QRESYNC sequence match data after ENABLE UIDONLY', 'auth', ['A0 ENABLE UIDONLY QRESYNC', 'A1 SELECT INBOX (QRESYNC (1 1 1:2 (1 1)))'], { A1: 'BAD' }],
    ['UIDAFTER without a UID', 'selected', ['A1 UID SEARCH UIDAFTER 0'], { A1: 'BAD' }],
    ['UIDBEFORE with a UID set', 'selected', ['A1 UID SEARCH UIDBEFORE 1:2'], { A1: 'BAD' }]
];

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

describe('Strict PARTIAL, CONTEXT and MULTISEARCH handling', () => {
    const ctx = setupServer(() => ({
        plugins: ['PARTIAL', 'CONTEXT=SORT', 'MULTISEARCH', 'SEARCHRES'],
        storage: {
            INBOX: {
                messages: [{ raw: 'Subject: hello\r\n\r\nWorld' }]
            },
            '': {}
        }
    }));

    defineCases(ctx, CONTEXT_CASES);
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

// COMPRESS (RFC 4978), UNAUTHENTICATE (RFC 8437), OAUTHBEARER (RFC 7628) and LITERAL- (RFC 7888)
const OAUTHBEARER_IR = Buffer.from('n,a=testuser,\x01auth=Bearer testtoken\x01\x01').toString('base64');
const CONNECTION_CASES = [
    // RFC 4978 section 5: compress = "COMPRESS" SP algorithm, a command-auth
    ['COMPRESS before login', 'none', ['A1 COMPRESS DEFLATE'], { A1: 'BAD' }],
    ['COMPRESS without a mechanism', 'auth', ['A1 COMPRESS'], { A1: 'BAD' }],
    ['COMPRESS with an unknown mechanism', 'auth', ['A1 COMPRESS GZIP'], { A1: 'BAD' }],
    ['COMPRESS with a quoted mechanism', 'auth', ['A1 COMPRESS "DEFLATE"'], { A1: 'BAD' }],
    ['COMPRESS with two arguments', 'auth', ['A1 COMPRESS DEFLATE DEFLATE'], { A1: 'BAD' }],
    // RFC 8437 section 6: UNAUTHENTICATE takes no arguments, a command-auth and command-select
    ['UNAUTHENTICATE before login', 'none', ['A1 UNAUTHENTICATE'], { A1: 'BAD' }],
    ['UNAUTHENTICATE with arguments', 'selected', ['A1 UNAUTHENTICATE x'], { A1: 'BAD' }],
    ['UNAUTHENTICATE when selected', 'selected', ['A1 UNAUTHENTICATE'], { A1: 'OK' }],
    // RFC 7628 section 3.1 and RFC 5801 section 4
    ['AUTHENTICATE OAUTHBEARER after login', 'auth', ['A1 AUTHENTICATE OAUTHBEARER ' + OAUTHBEARER_IR], { A1: 'BAD' }],
    [
        'AUTHENTICATE OAUTHBEARER without a GS2 header',
        'none',
        ['A1 AUTHENTICATE OAUTHBEARER ' + Buffer.from('auth=Bearer x\x01\x01').toString('base64')],
        { A1: 'BAD' }
    ],
    ['AUTHENTICATE OAUTHBEARER', 'none', ['A1 AUTHENTICATE OAUTHBEARER ' + OAUTHBEARER_IR], { A1: 'OK' }],
    // RFC 7888 section 5: non-synchronizing literals larger than 4096 octets with LITERAL-
    ['non-synchronizing literal over 4096 octets', 'auth', ['A1 APPEND INBOX {4097+}\r\n' + 'x'.repeat(4097)], { A1: 'BAD' }],
    ['non-synchronizing literal of 4096 octets', 'auth', ['A1 APPEND INBOX {4096+}\r\n' + 'x'.repeat(4096)], { A1: 'OK' }]
];

describe('Strict COMPRESS, UNAUTHENTICATE, OAUTHBEARER and LITERAL- handling', () => {
    const ctx = setupServer(() => ({
        plugins: ['COMPRESS', 'UNAUTHENTICATE', 'OAUTHBEARER', 'SASL-IR', 'LITERAL-'],
        storage: {
            INBOX: {
                messages: [{ raw: 'Subject: hello\r\n\r\nWorld' }]
            },
            '': {}
        }
    }));

    defineCases(ctx, CONNECTION_CASES);
});

// NOTIFY (RFC 5465), checked with the NOTIFY plugin loaded
const NOTIFY_CASES = [
    ['NOTIFY before login', 'none', ['A1 NOTIFY NONE'], { A1: 'BAD' }],
    // section 8: notify-set = "SET" [status-indicator] SP event-groups
    ['NOTIFY SET without event groups', 'auth', ['A1 NOTIFY SET STATUS'], { A1: 'BAD' }],
    ['NOTIFY NONE with arguments', 'auth', ['A1 NOTIFY NONE STATUS'], { A1: 'BAD' }],
    // section 5: MessageNew and MessageExpunge MUST go together, FlagChange MUST have both
    ['MessageNew without MessageExpunge', 'auth', ['A1 NOTIFY SET (personal (MessageNew))'], { A1: 'BAD' }],
    ['FlagChange without MessageNew and MessageExpunge', 'selected', ['A1 NOTIFY SET (selected (FlagChange))'], { A1: 'BAD' }],
    // section 6.1: only one selected filter, only message events with it
    ['SELECTED together with SELECTED-DELAYED', 'auth', ['A1 NOTIFY SET (selected NONE) (selected-delayed NONE)'], { A1: 'BAD' }],
    ['MailboxName with SELECTED', 'auth', ['A1 NOTIFY SET (selected (MailboxName))'], { A1: 'BAD' }],
    // section 8: the fetch attributes are only allowed with the selected filters
    ['MessageNew fetch attributes with PERSONAL', 'auth', ['A1 NOTIFY SET (personal (MessageNew (UID) MessageExpunge))'], { A1: 'BAD' }],
    // section 3.1: an unsupported event is NO, not BAD
    ['an unsupported event', 'auth', ['A1 NOTIFY SET (personal (AnnotationChange MessageNew MessageExpunge))'], { A1: 'NO' }],
    ['a valid NOTIFY SET', 'selected', ['A1 NOTIFY SET STATUS (selected (MessageNew (UID) MessageExpunge FlagChange)) (personal (MailboxName))'], { A1: 'OK' }]
];

describe('Strict NOTIFY handling', () => {
    const ctx = setupServer(() => ({
        plugins: ['NOTIFY'],
        storage: {
            INBOX: {
                messages: [{ raw: 'Subject: hello\r\n\r\nWorld' }]
            },
            '': {}
        }
    }));

    defineCases(ctx, NOTIFY_CASES);
});

// UTF8=ACCEPT (RFC 9755), checked with the UTF8=ACCEPT plugin loaded
const UTF8_CASES = [
    // section 3: once enabled, CHARSET conflicts with UTF-8 and SHOULD be refused with BAD
    ['SEARCH with CHARSET after ENABLE UTF8=ACCEPT', 'utf8 selected', ['A1 SEARCH CHARSET UTF-8 SUBJECT x'], { A1: 'BAD' }],
    ['SEARCH with UTF-8 text after ENABLE UTF8=ACCEPT', 'utf8 selected', ['A1 SEARCH SUBJECT "caf\xc3\xa9"'], { A1: 'OK' }],
    // section 3: invalid UTF-8 in a quoted string MUST be rejected with BAD
    ['quoted string with invalid UTF-8', 'utf8', ['A1 CREATE "caf\xe9"'], { A1: 'BAD' }],
    // section 3: mailbox names MUST NOT contain control characters, LINE SEPARATOR or PARAGRAPH SEPARATOR
    ['UTF-8 mailbox name with a C1 control character', 'utf8', ['A1 CREATE "a\xc2\x85b"'], { A1: 'BAD' }],
    ['UTF-8 mailbox name with LINE SEPARATOR', 'utf8', ['A1 CREATE "a\xe2\x80\xa8b"'], { A1: 'BAD' }],
    ['UTF-8 mailbox name after ENABLE UTF8=ACCEPT', 'utf8', ['A1 CREATE "caf\xc3\xa9"', 'A2 SELECT "caf\xc3\xa9"'], { A1: 'OK', A2: 'OK' }],
    ['UTF-8 mailbox name without ENABLE UTF8=ACCEPT', 'auth', ['A1 CREATE "caf\xc3\xa9"'], { A1: 'BAD' }],
    // section 3 applies to modified UTF-7 names too: CR, a C1 control and LINE SEPARATOR encoded in modified BASE64
    ['modified UTF-7 mailbox name with an encoded CR', 'auth', ['A1 CREATE "a&AA0-b"'], { A1: 'BAD' }],
    ['modified UTF-7 mailbox name with an encoded C1 control', 'auth', ['A1 SELECT "a&AIU-b"'], { A1: 'BAD' }],
    ['modified UTF-7 mailbox name with an encoded LINE SEPARATOR', 'auth', ['A1 RENAME INBOX "a&ICg-b"'], { A1: 'BAD' }],
    ['valid modified UTF-7 mailbox name with UTF8=ACCEPT', 'auth', ['A1 CREATE "&U,BTF2XlZyyKng-"'], { A1: 'OK' }],
    // section 4: APPEND of a message with an 8-bit header MUST be refused with NO without ENABLE
    ['APPEND with an 8-bit header without ENABLE UTF8=ACCEPT', 'auth', ['A1 APPEND INBOX {14}\r\nSubject: caf\xc3\xa9'], { A1: 'NO' }],
    ['APPEND with an 8-bit header after ENABLE UTF8=ACCEPT', 'utf8', ['A1 APPEND INBOX {14}\r\nSubject: caf\xc3\xa9'], { A1: 'OK' }],
    // section 5: UTF-8 user names and passwords MUST use AUTHENTICATE
    ['LOGIN with a UTF-8 password', 'none', ['A1 LOGIN testuser "caf\xc3\xa9"'], { A1: 'BAD' }]
];

describe('Strict UTF8=ACCEPT handling', () => {
    const ctx = setupServer(() => ({
        plugins: ['UTF8=ACCEPT'],
        storage: {
            INBOX: {
                messages: [{ raw: 'Subject: hello\r\n\r\nWorld' }]
            },
            '': {}
        }
    }));

    defineCases(ctx, UTF8_CASES);
});

// IMAP4rev2 (RFC 9051), checked with the IMAP4rev2 plugin loaded
const REV2_CASES = [
    // Appendix E items 17 to 19 and the section 9 grammar
    ['CHECK after ENABLE IMAP4rev2', 'rev2 selected', ['A1 CHECK'], { A1: 'BAD' }],
    ['LSUB after ENABLE IMAP4rev2', 'rev2', ['A1 LSUB "" "*"'], { A1: 'BAD' }],
    ['FETCH RFC822 after ENABLE IMAP4rev2', 'rev2 selected', ['A1 FETCH 1 RFC822', 'A2 UID FETCH 1 (FLAGS RFC822.TEXT)'], { A1: 'BAD', A2: 'BAD' }],
    // Appendix E item 12: search-key and status-att have no NEW, OLD, RECENT
    [
        'SEARCH NEW after ENABLE IMAP4rev2',
        'rev2 selected',
        ['A1 SEARCH NEW', 'A2 SEARCH OR OLD SEEN', 'A3 UID SEARCH RECENT'],
        { A1: 'BAD', A2: 'BAD', A3: 'BAD' }
    ],
    ['STATUS RECENT after ENABLE IMAP4rev2', 'rev2', ['A1 STATUS INBOX (MESSAGES RECENT)'], { A1: 'BAD' }],
    [
        'the same commands without ENABLE IMAP4rev2',
        'selected',
        ['A1 CHECK', 'A2 LSUB "" "*"', 'A3 FETCH 1 RFC822', 'A4 SEARCH NEW', 'A5 STATUS INBOX (RECENT)'],
        {
            A1: 'OK',
            A2: 'OK',
            A3: 'OK',
            A4: 'OK',
            A5: 'OK'
        }
    ],
    // section 4.3.1 and Appendix A: UTF-8 in quoted strings only after ENABLE IMAP4rev2, and valid UTF-8 only
    ['UTF-8 quoted string without ENABLE IMAP4rev2', 'auth', ['A1 CREATE "caf\xc3\xa9"'], { A1: 'BAD' }],
    ['invalid UTF-8 after ENABLE IMAP4rev2', 'rev2', ['A1 CREATE "caf\xe9"'], { A1: 'BAD' }],
    // section 5.1: mailbox names are Net-Unicode
    ['mailbox name with a control character after ENABLE IMAP4rev2', 'rev2', ['A1 CREATE "a\xc2\x85b"'], { A1: 'BAD' }],
    ['mailbox name that is not NFC after ENABLE IMAP4rev2', 'rev2', ['A1 CREATE "e\xcc\x81"'], { A1: 'BAD' }],
    // section 9: number64 for partial ranges and LARGER/SMALLER, number (32-bit) in IMAP4rev1
    [
        'FETCH partial range above 32 bits without ENABLE IMAP4rev2',
        'selected',
        ['A1 FETCH 1 BODY.PEEK[]<4294967296.1>', 'A2 SEARCH LARGER 4294967296'],
        { A1: 'BAD', A2: 'BAD' }
    ],
    [
        'FETCH partial range above 32 bits after ENABLE IMAP4rev2',
        'rev2 selected',
        ['A1 FETCH 1 BODY.PEEK[]<4294967296.1>', 'A2 SEARCH LARGER 4294967296'],
        { A1: 'OK', A2: 'OK' }
    ],
    ['SEARCH SMALLER above 63 bits after ENABLE IMAP4rev2', 'rev2 selected', ['A1 SEARCH SMALLER 9223372036854775808'], { A1: 'BAD' }],
    ['SEARCH CHARSET after ENABLE IMAP4rev2', 'rev2 selected', ['A1 SEARCH CHARSET UTF-8 SUBJECT "caf\xc3\xa9"'], { A1: 'OK' }]
];

describe('Strict IMAP4rev2 handling', () => {
    const ctx = setupServer(() => ({
        plugins: ['IMAP4rev2'],
        storage: {
            INBOX: {
                messages: [{ raw: 'Subject: hello\r\n\r\nWorld' }]
            },
            '': {}
        }
    }));

    defineCases(ctx, REV2_CASES);
});

describe('Strict QRESYNC handling', () => {
    const ctx = setupServer(() => ({
        plugins: ['QRESYNC'],
        storage: {
            INBOX: {
                messages: [{ raw: 'Subject: hello\r\n\r\nWorld' }]
            },
            '': {}
        }
    }));

    defineCases(ctx, QRESYNC_CASES);
});

describe('Strict UIDONLY and MESSAGELIMIT handling', () => {
    const ctx = setupServer(() => ({
        plugins: ['UIDONLY', 'QRESYNC', 'MOVE', 'MESSAGELIMIT'],
        storage: {
            INBOX: {
                messages: [{ raw: 'Subject: hello\r\n\r\nWorld' }]
            },
            '': {}
        }
    }));

    defineCases(ctx, UIDONLY_CASES);
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

describe('Strict ACL handling', () => {
    const ctx = setupServer(() => ({
        plugins: ['ACL']
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

    // RFC 4314 section 7: the ACL commands are command-auth
    it('ACL commands before login', run(['A1 GETACL INBOX', 'A2 MYRIGHTS INBOX', 'A3 SETACL INBOX bob l'], { A1: 'BAD', A2: 'BAD', A3: 'BAD' }));
    // RFC 4314 section 3.1: an unrecognized right MUST cause BAD
    it('SETACL with an uppercase right', run([LOGIN, 'A1 SETACL INBOX bob lR'], { A1: 'BAD' }));
    it('SETACL with an unknown right', run([LOGIN, 'A1 SETACL INBOX bob +lz'], { A1: 'BAD' }));
    // RFC 4314 section 3: an identifier that can not be prepared, or is empty, is refused with BAD
    it('SETACL with an empty identifier', run([LOGIN, 'A1 SETACL INBOX "" l'], { A1: 'BAD' }));
    // RFC 4314 section 7: myrights = "MYRIGHTS" SP mailbox
    it('MYRIGHTS with an extra argument', run([LOGIN, 'A1 MYRIGHTS INBOX x'], { A1: 'BAD' }));
});
