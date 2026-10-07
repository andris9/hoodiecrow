'use strict';

/**
 * Seeded fuzz test. Mutates valid IMAP commands and replays them against a server with all
 * plugins loaded, then checks that the server answered every command once, that everything it
 * sent passes the response grammar guardrail and that it still responds afterwards.
 *
 * FUZZ_SEED picks the sequence of inputs (default fixed, so CI is deterministic), FUZZ_ITERATIONS
 * the number of inputs. A failure prints the seed, the iteration and the input as JSON.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const hoodiecrow = require('../lib/server');
const { validateResponses, splitResponses } = require('./helpers/validate-responses');

const SEED = Number(process.env.FUZZ_SEED) || 0x1ca9;
const ITERATIONS = Number(process.env.FUZZ_ITERATIONS) || 400;
// a new server for every batch, so that destructive inputs (DELETE, EXPUNGE ...) do not wear the storage down
const BATCH_SIZE = 50;
// literal limit for the fuzz server; the pre-login limit is 64k in lib/server.js
const MAX_LITERAL = 64 * 1024;
// how long to wait for the sentinel before assuming that a literal or a continuation swallowed it
const SENTINEL_TIMEOUT = 150;
const RECOVERY_TIMEOUT = 3000;
// how long to wait for a "+" before sending literal data anyway
const CONTINUATION_TIMEOUT = 100;

// Every client facing plugin. STARTTLS and LOGINDISABLED would stop plain logins, and XTOYBIRD is a
// test control channel that can delete the test user (its responses also echo raw user names).
// COMPRESS is left out as the fuzzer does not speak DEFLATE, and LITERAL- can not be loaded with LITERAL+.
const PLUGINS = [
    'ENABLE',
    'CONDSTORE',
    'QRESYNC',
    'ESEARCH',
    'SEARCHRES',
    'IDLE',
    'LITERALPLUS',
    'MOVE',
    'NAMESPACE',
    'UIDPLUS',
    'PREVIEW',
    'UNSELECT',
    'SPECIAL-USE',
    'CREATE-SPECIAL-USE',
    'METADATA',
    'ID',
    'X-GM-EXT-1',
    'SASL-IR',
    'AUTH-PLAIN',
    'XOAUTH2',
    'LIST-EXTENDED',
    'LIST-STATUS',
    'STATUS=SIZE',
    'SORT',
    'SORT=DISPLAY',
    'THREAD=ORDEREDSUBJECT',
    'THREAD=REFERENCES',
    'QUOTA',
    'OBJECTID',
    'SAVEDATE',
    'OAUTHBEARER',
    'UNAUTHENTICATE',
    'ACL',
    'MULTIAPPEND',
    'CATENATE',
    'REPLACE',
    'APPENDLIMIT',
    'UTF8=ACCEPT',
    'BINARY',
    'PARTIAL',
    'ESORT',
    'CONTEXT=SEARCH',
    'CONTEXT=SORT',
    'MULTISEARCH'
];

const MESSAGE = 'From: sender@example.com\r\nTo: rcpt@example.com\r\nSubject: hello\r\nContent-Type: text/plain\r\n\r\nHello world!\r\n';

function getStorage() {
    return {
        INBOX: {
            messages: [
                { raw: MESSAGE, flags: ['\\Seen'] },
                { raw: 'Subject: second\r\n\r\nSecond', flags: [] },
                {
                    raw: 'Subject: multi\r\nContent-Type: multipart/mixed; boundary=abc\r\n\r\n--abc\r\nContent-Type: text/plain\r\n\r\npart 1\r\n--abc\r\nContent-Type: text/html\r\n\r\n<b>2</b>\r\n--abc--\r\n',
                    flags: ['\\Flagged']
                }
            ]
        },
        '': {
            separator: '/',
            folders: {
                Archive: { messages: [{ raw: 'Subject: archived\r\n\r\nOld' }] },
                Sent: { 'special-use': '\\Sent', messages: [] }
            }
        }
    };
}

// `state`: what the session needs before the command runs
const CORPUS = [
    { state: 'none', input: 'C1 CAPABILITY\r\n' },
    { state: 'none', input: 'C1 LOGIN testuser testpass\r\n' },
    { state: 'none', input: 'C1 LOGIN {8}\r\ntestuser {8}\r\ntestpass\r\n' },
    { state: 'none', input: 'C1 LOGIN {8+}\r\ntestuser "testpass"\r\n' },
    { state: 'none', input: 'C1 AUTHENTICATE PLAIN\r\nAHRlc3R1c2VyAHRlc3RwYXNz\r\n' },
    { state: 'none', input: 'C1 AUTHENTICATE PLAIN AHRlc3R1c2VyAHRlc3RwYXNz\r\n' },
    { state: 'none', input: 'C1 AUTHENTICATE PLAIN\r\n*\r\n' },
    { state: 'none', input: 'C1 AUTHENTICATE OAUTHBEARER bixhPXRlc3R1c2VyLAFob3N0PWxvY2FsaG9zdAFwb3J0PTE0MwFhdXRoPUJlYXJlciB0ZXN0dG9rZW4BAQ==\r\n' },
    { state: 'none', input: 'C1 AUTHENTICATE OAUTHBEARER bixhPXRlc3R1c2VyLAFhdXRoPUJlYXJlciB3cm9uZwEB\r\nAQ==\r\n' },
    { state: 'none', input: 'C1 AUTHENTICATE OAUTHBEARER\r\nbiwsAWF1dGg9QmVhcmVyIHRlc3R0b2tlbgEB\r\n' },
    { state: 'none', input: 'C1 ID ("name" "fuzz" "version" "1")\r\n' },
    { state: 'none', input: 'C1 NOOP\r\nC2 LOGOUT\r\n' },
    { state: 'auth', input: 'C1 SELECT INBOX\r\n' },
    { state: 'auth', input: 'C1 EXAMINE "INBOX"\r\n' },
    { state: 'auth', input: 'C1 SELECT INBOX (CONDSTORE)\r\n' },
    { state: 'auth', input: 'C1 ENABLE CONDSTORE\r\n' },
    { state: 'auth', input: 'C1 ENABLE QRESYNC\r\nC2 SELECT INBOX (QRESYNC (1 1 1:3 (1:2 1:2)))\r\n' },
    { state: 'auth', input: 'C1 ENABLE QRESYNC\r\nC2 SELECT INBOX\r\nC3 UID FETCH 1:* (FLAGS) (CHANGEDSINCE 1 VANISHED)\r\n' },
    { state: 'auth', input: 'C1 LIST "" "*"\r\n' },
    { state: 'auth', input: 'C1 LIST "" "%"\r\nC2 LSUB "" "*"\r\n' },
    { state: 'auth', input: 'C1 LIST (SPECIAL-USE) "" "*"\r\n' },
    { state: 'auth', input: 'C1 LIST (SUBSCRIBED RECURSIVEMATCH) "" ("%" "INBOX") RETURN (CHILDREN STATUS (MESSAGES SIZE))\r\n' },
    { state: 'selected', input: 'C1 LIST (REMOTE) "" "*" RETURN (SUBSCRIBED SPECIAL-USE STATUS (UNSEEN HIGHESTMODSEQ))\r\n' },
    { state: 'auth', input: 'C1 NAMESPACE\r\n' },
    { state: 'auth', input: 'C1 STATUS INBOX (MESSAGES RECENT UIDNEXT UIDVALIDITY UNSEEN HIGHESTMODSEQ)\r\n' },
    { state: 'auth', input: 'C1 CREATE "New folder"\r\nC2 RENAME "New folder" Other\r\nC3 DELETE Other\r\n' },
    { state: 'auth', input: 'C1 CREATE Drafts (USE (\\Drafts))\r\n' },
    { state: 'auth', input: 'C1 SUBSCRIBE Archive\r\nC2 UNSUBSCRIBE Archive\r\n' },
    { state: 'auth', input: 'C1 APPEND INBOX (\\Seen) "07-Oct-2026 10:00:00 +0000" {28}\r\nSubject: hi\r\n\r\nHello there!\r\n' },
    { state: 'auth', input: 'C1 APPEND INBOX {28+}\r\nSubject: hi\r\n\r\nHello there!\r\n' },
    { state: 'auth', input: 'C1 APPEND INBOX {5}\r\nhello (\\Seen) {5}\r\nworld\r\n' },
    { state: 'auth', input: 'C1 APPEND Archive CATENATE (TEXT {3}\r\nabc URL "/INBOX/;UID=1/;SECTION=1/;PARTIAL=0.5")\r\n' },
    { state: 'auth', input: 'C1 STATUS INBOX (APPENDLIMIT)\r\n' },
    {
        state: 'auth',
        input: 'C1 APPEND INBOX ~{80}\r\nSubject: bin\r\nContent-Transfer-Encoding: binary\r\n\r\n\x00\x01\x02\xff\r\nbinary data\x00 with NUL\r\n'
    },
    { state: 'auth', input: 'C1 IDLE\r\nDONE\r\n' },
    { state: 'auth', input: 'C1 ENABLE METADATA\r\nC2 SETMETADATA INBOX (/private/comment "hello" /shared/comment {5}\r\nworld)\r\n' },
    { state: 'auth', input: 'C1 GETMETADATA (MAXSIZE 1024 DEPTH infinity) "" (/shared /private/comment)\r\n' },
    { state: 'auth', input: 'C1 SETMETADATA "" (/shared/vendor/vendor.example/x NIL)\r\nC2 GETMETADATA (DEPTH 1) Sent /private\r\n' },
    { state: 'auth', input: 'C1 GETQUOTAROOT INBOX\r\nC2 GETQUOTA "User quota"\r\n' },
    { state: 'auth', input: 'C1 SETQUOTA "User quota" (STORAGE 1 MESSAGE 4 MAILBOX 3)\r\n' },
    { state: 'auth', input: 'C1 STATUS INBOX (DELETED DELETED-STORAGE MAILBOXID)\r\n' },
    { state: 'auth', input: 'C1 UNAUTHENTICATE\r\nC2 LOGIN testuser testpass\r\n' },
    { state: 'auth', input: 'C1 SETACL Archive bob +lrd\r\nC2 GETACL Archive\r\nC3 DELETEACL Archive bob\r\n' },
    { state: 'auth', input: 'C1 MYRIGHTS INBOX\r\nC2 LISTRIGHTS "INBOX" {5}\r\nother\r\n' },
    { state: 'auth', input: 'C1 LIST "" "*" RETURN (MYRIGHTS STATUS (MESSAGES))\r\n' },
    { state: 'selected', input: 'C1 FETCH 1:* (FLAGS UID INTERNALDATE RFC822.SIZE)\r\n' },
    { state: 'selected', input: 'C1 FETCH 1 (BODY.PEEK[HEADER.FIELDS (Subject From)] BODY[TEXT]<0.5>)\r\n' },
    { state: 'selected', input: 'C1 FETCH 3 (BODYSTRUCTURE ENVELOPE BODY[1.MIME] BODY[2]<2.3>)\r\n' },
    { state: 'selected', input: 'C1 FETCH 1:2 (BODY[] RFC822.HEADER RFC822.TEXT BODY)\r\n' },
    { state: 'selected', input: 'C1 FETCH 1,3 (FLAGS) (CHANGEDSINCE 1)\r\n' },
    { state: 'selected', input: 'C1 FETCH 1:* (PREVIEW (LAZY) FLAGS)\r\nC2 FETCH 3 PREVIEW\r\n' },
    { state: 'selected', input: 'C1 UID FETCH 1:* PREVIEW (LAZY) (CHANGEDSINCE 1)\r\n' },
    { state: 'selected', input: 'C1 FETCH 1 (X-GM-MSGID X-GM-THRID X-GM-LABELS MODSEQ)\r\n' },
    { state: 'selected', input: 'C1 UID FETCH 1:* (FLAGS BODY.PEEK[HEADER])\r\n' },
    { state: 'selected', input: 'C1 FETCH 1:* (BINARY.PEEK[1] BINARY.SIZE[1])\r\n' },
    { state: 'selected', input: 'C1 UID FETCH 3 (BINARY[2]<1.3> BINARY.SIZE[1])\r\n' },
    { state: 'selected', input: 'C1 STORE 1 +FLAGS (\\Flagged)\r\n' },
    { state: 'selected', input: 'C1 STORE 1:2 -FLAGS.SILENT (\\Seen)\r\n' },
    { state: 'selected', input: 'C1 STORE 2 (UNCHANGEDSINCE 100) FLAGS (\\Answered $Custom)\r\n' },
    { state: 'selected', input: 'C1 UID STORE 1:* +X-GM-LABELS (Work)\r\n' },
    { state: 'selected', input: 'C1 SEARCH OR FROM sender NOT (SEEN SUBJECT "hello")\r\n' },
    { state: 'selected', input: 'C1 SEARCH CHARSET UTF-8 OR OR TEXT a BODY b NOT OR LARGER 10 SMALLER 5000\r\n' },
    { state: 'selected', input: 'C1 SEARCH SINCE 1-Jan-2020 BEFORE 1-Jan-2030 UID 1:* 1,2\r\n' },
    { state: 'selected', input: 'C1 SEARCH HEADER Subject {5}\r\nhello\r\n' },
    { state: 'selected', input: 'C1 SEARCH MODSEQ 1 X-GM-RAW "hello"\r\n' },
    { state: 'selected', input: 'C1 UID SEARCH NOT DELETED\r\n' },
    { state: 'selected', input: 'C1 SEARCH RETURN (MIN MAX ALL COUNT) MODSEQ "/flags/\\\\seen" all 1\r\n' },
    { state: 'selected', input: 'C1 UID SEARCH RETURN (SAVE MIN) UNSEEN\r\nC2 FETCH $ (FLAGS)\r\nC3 STORE $ +FLAGS (\\Seen)\r\n' },
    { state: 'selected', input: 'C1 SEARCH RETURN () OR $ 1:2 NOT DELETED\r\n' },
    { state: 'selected', input: 'C1 SORT (REVERSE DATE SUBJECT DISPLAYFROM) UTF-8 OR FROM sender 1:2\r\n' },
    { state: 'selected', input: 'C1 UID SORT (ARRIVAL CC TO SIZE REVERSE DISPLAYTO) "US-ASCII" ALL\r\n' },
    { state: 'selected', input: 'C1 THREAD REFERENCES UTF-8 NOT DELETED\r\n' },
    { state: 'selected', input: 'C1 UID THREAD ORDEREDSUBJECT US-ASCII SUBJECT {5}\r\nhello\r\n' },
    { state: 'selected', input: 'C1 FETCH 1:* (EMAILID THREADID SAVEDATE)\r\n' },
    { state: 'selected', input: 'C1 SEARCH OR EMAILID M1 THREADID T2 SAVEDSINCE 1-Jan-2020 SAVEDATESUPPORTED\r\n' },
    { state: 'selected', input: 'C1 COPY 1:2 Archive\r\n' },
    { state: 'selected', input: 'C1 UID COPY 1 "Archive"\r\n' },
    { state: 'selected', input: 'C1 MOVE 2 Archive\r\n' },
    { state: 'selected', input: 'C1 UID MOVE 3 Archive\r\n' },
    { state: 'selected', input: 'C1 STORE 1 +FLAGS (\\Deleted)\r\nC2 EXPUNGE\r\n' },
    { state: 'selected', input: 'C1 STORE 2 +FLAGS (\\Deleted)\r\nC2 UID EXPUNGE 2\r\n' },
    { state: 'selected', input: 'C1 CHECK\r\nC2 CLOSE\r\n' },
    { state: 'selected', input: 'C1 UNSELECT\r\n' },
    { state: 'selected', input: 'C1 REPLACE 1 INBOX (\\Draft) {5}\r\nhello\r\n' },
    { state: 'selected', input: 'C1 UID REPLACE 2 Archive CATENATE (URL "/INBOX/;UID=2/;SECTION=HEADER" TEXT {2}\r\nhi)\r\n' },
    { state: 'selected', input: 'C1 IDLE\r\nDONE\r\nC2 NOOP\r\n' }
];

const TOKENS = [
    '{0}\r\n',
    '{1}\r\n',
    '{5}\r\n',
    '{100}\r\n',
    '{2+}\r\n',
    '{70000}\r\n',
    '{99999999999999999999}\r\n',
    '~{3}\r\n',
    '(',
    ')',
    '[',
    ']',
    '<',
    '>',
    '<0.99999999999>',
    '"',
    '\\',
    '\x00',
    '\xff',
    '\xc3\xa9',
    '\x80',
    '\r',
    '\n',
    '\r\n',
    ' ',
    '*',
    '0',
    '-1',
    '1:*',
    '*:0',
    '0:0',
    '4294967296',
    '99999999999999999999',
    'NIL',
    '()',
    '""',
    'BODY[',
    'UID',
    '%'
];

// mulberry32, small and good enough for picking mutations
function createRandom(seed) {
    let state = seed >>> 0;
    const next = () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    next.int = max => Math.floor(next() * max);
    next.pick = list => list[next.int(list.length)];
    return next;
}

const MUTATIONS = [
    // flip a byte
    (random, str) => {
        const pos = random.int(str.length);
        return str.substr(0, pos) + String.fromCharCode(str.charCodeAt(pos) ^ (1 + random.int(255))) + str.substr(pos + 1);
    },
    // truncate
    (random, str) => str.substr(0, random.int(str.length)),
    // insert a special token
    (random, str) => {
        const pos = random.int(str.length + 1);
        return str.substr(0, pos) + random.pick(TOKENS) + str.substr(pos);
    },
    // duplicate a token
    (random, str) => {
        const parts = str.split(' ');
        const index = random.int(parts.length);
        parts.splice(index, 0, parts[index]);
        return parts.join(' ');
    },
    // drop a token
    (random, str) => {
        const parts = str.split(' ');
        if (parts.length > 1) {
            parts.splice(random.int(parts.length), 1);
        }
        return parts.join(' ');
    },
    // replace a number (sequence numbers, literal sizes, partial ranges) with a hostile one
    (random, str) => {
        const numbers = [];
        str.replace(/[0-9]+/g, (match, offset) => numbers.push([offset, match.length]));
        if (!numbers.length) {
            return str;
        }
        const [offset, length] = random.pick(numbers);
        return str.substr(0, offset) + random.pick(['0', '*', '4294967296', '99999999999999999999', '-1', '1:*', '70000']) + str.substr(offset + length);
    }
];

function mutate(random, input) {
    let str = input;
    const count = 1 + random.int(3);
    for (let i = 0; i < count; i++) {
        str = random.pick(MUTATIONS)(random, str);
    }
    return str;
}

/**
 * Opens a connection and collects everything the server sends. Resolves once the greeting arrived.
 */
function connect(port) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, 'localhost');
        let waiter = null;

        const session = {
            socket,
            received: Buffer.alloc(0),
            sent: '',
            closed: false,
            write(data) {
                if (!session.closed && !socket.destroyed) {
                    session.sent += data;
                    socket.write(Buffer.from(data, 'binary'));
                }
            },
            // tags of the complete tagged responses received so far
            tags() {
                return splitResponses(session.received, { partial: true })
                    .map(response => response.lines[0].toString('binary').match(/^([^ *+][^ ]*) /))
                    .filter(match => match)
                    .map(match => match[1]);
            },
            // number of continuation requests received so far
            continuations() {
                return splitResponses(session.received, { partial: true }).filter(response => response.lines[0][0] === 0x2b).length;
            },
            // resolves with true once test() is true, with false on timeout or when the connection closes
            waitFor(test, timeout) {
                return new Promise(done => {
                    const timer = setTimeout(() => {
                        waiter = null;
                        done(false);
                    }, timeout);
                    waiter = () => {
                        const ok = test();
                        if (ok || session.closed) {
                            clearTimeout(timer);
                            waiter = null;
                            done(ok);
                        }
                    };
                    waiter();
                });
            }
        };

        socket.on('data', chunk => {
            session.received = Buffer.concat([session.received, chunk]);
            if (waiter) {
                waiter();
            }
        });
        socket.on('error', () => false);
        socket.on('close', () => {
            session.closed = true;
            if (waiter) {
                waiter();
            }
        });

        session
            .waitFor(() => session.received.indexOf('\r\n') >= 0, RECOVERY_TIMEOUT)
            .then(ok => (ok ? resolve(session) : reject(new Error('No greeting from the server'))));
    });
}

async function runCommand(session, tag, command) {
    session.write(tag + ' ' + command + '\r\n');
    const ok = await session.waitFor(() => session.tags().includes(tag), RECOVERY_TIMEOUT);
    assert.ok(ok, tag + ' ' + command + ' got no tagged response: ' + JSON.stringify(session.received.toString('binary')));
}

// counts lines sent that start with `tag`, an upper bound for the tagged responses it may get
function countTag(sent, tag) {
    return sent.split(/\r?\n|\r/).filter(line => line.split(' ')[0] === tag).length;
}

async function checkTranscript(session) {
    const responses = await validateResponses(session.received);

    const counts = {};
    session.tags().forEach(tag => {
        counts[tag] = (counts[tag] || 0) + 1;
    });
    Object.keys(counts).forEach(tag => {
        // a mutation may repeat a tag, or even produce one of the fuzzer's own (P1, ZZ ...)
        const limit = countTag(session.sent, tag);
        assert.ok(counts[tag] <= limit, 'Command ' + tag + ' was sent ' + limit + ' times but got ' + counts[tag] + ' tagged responses');
    });

    if (!counts.ZZ && !counts.ZY) {
        // a closed connection is fine only if the server said goodbye first
        assert.ok(session.closed, 'The server never answered the sentinel NOOP');
        assert.ok(
            responses.some(response => /^\* BYE /i.test(response.lines[0].toString('binary'))),
            'The connection was closed without a BYE'
        );
    }
}

async function runInput(port, entry, input) {
    const session = await connect(port);
    try {
        if (entry.state !== 'none') {
            await runCommand(session, 'P1', 'LOGIN testuser testpass');
        }
        if (entry.state === 'selected') {
            await runCommand(session, 'P2', 'SELECT INBOX');
        }

        // Like a real client, wait for the "+" continuation before sending the data of a synchronizing
        // literal (RFC 3501 section 4.3). If the server refuses the literal, send the rest anyway.
        const chunks = input.split(/(?<=\{[0-9]+\}\r\n)/);
        for (let i = 0; i < chunks.length - 1; i++) {
            const continuations = session.continuations();
            session.write(chunks[i]);
            await session.waitFor(() => session.continuations() > continuations, CONTINUATION_TIMEOUT);
        }
        // the extra line break ends a truncated input, an empty line is harmless
        session.write(chunks[chunks.length - 1] + '\r\nZZ NOOP\r\n');
        const ok = await session.waitFor(() => session.tags().includes('ZZ'), SENTINEL_TIMEOUT);
        if (!ok && !session.closed) {
            // Probably a literal swallowed the sentinel, or IDLE / AUTHENTICATE waits for a continuation
            // line. Spaces fill up any pending literal (none can be larger than MAX_LITERAL), the line
            // break ends the command, DONE ends IDLE, and then one more NOOP.
            session.write(' '.repeat(MAX_LITERAL + 16) + '\r\nDONE\r\nZY NOOP\r\n');
            await session.waitFor(() => session.tags().includes('ZY'), RECOVERY_TIMEOUT);
        }
        await checkTranscript(session);
    } catch (err) {
        err.transcript = session.received.toString('binary');
        throw err;
    } finally {
        session.socket.destroy();
    }
}

function startServer() {
    const server = hoodiecrow({ plugins: PLUGINS, storage: getStorage(), maxLiteralSize: MAX_LITERAL });
    return new Promise(resolve => server.listen(0, () => resolve(server)));
}

function closeServer(server) {
    return new Promise(resolve => server.close(resolve));
}

async function checkResponsive(server) {
    const session = await connect(server.address().port);
    try {
        await runCommand(session, 'R1', 'LOGIN testuser testpass');
        await runCommand(session, 'R2', 'SELECT INBOX');
    } finally {
        session.socket.destroy();
    }
}

describe('Fuzzing', () => {
    it('survives mutated commands (FUZZ_SEED=' + SEED + ', FUZZ_ITERATIONS=' + ITERATIONS + ')', async () => {
        const random = createRandom(SEED);
        let server = null;

        try {
            for (let iteration = 0; iteration < ITERATIONS; iteration++) {
                if (iteration % BATCH_SIZE === 0) {
                    if (server) {
                        await checkResponsive(server);
                        await closeServer(server);
                    }
                    server = await startServer();
                }

                const entry = random.pick(CORPUS);
                const input = mutate(random, entry.input);
                try {
                    await runInput(server.address().port, entry, input);
                } catch (err) {
                    // the stack already holds the message, so extend both
                    const details =
                        'Fuzz failure with FUZZ_SEED=' +
                        SEED +
                        ' at iteration ' +
                        iteration +
                        ' (state "' +
                        entry.state +
                        '")\ninput: ' +
                        JSON.stringify(input) +
                        (err.transcript !== undefined ? '\ntranscript: ' + JSON.stringify(err.transcript) : '') +
                        '\n';
                    err.message = details + err.message;
                    err.stack = details + err.stack;
                    throw err;
                }
            }
            await checkResponsive(server);
        } finally {
            if (server) {
                await closeServer(server);
            }
        }
    });
});
