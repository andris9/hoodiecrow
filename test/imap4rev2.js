'use strict';

// IMAP4rev2, RFC 9051 (https://www.rfc-editor.org/rfc/rfc9051.txt), advertised next to IMAP4rev1 (Appendix A)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const hoodiecrow = require('../lib/server');
const { setupServer, assertTagged } = require('./helpers');
const { openSession } = require('./helpers/session');
const mailboxName = require('../lib/mailbox-name');

// commands are binary strings, so UTF-8 text is written octet by octet
const utf8 = str => Buffer.from(str, 'utf-8').toString('binary');

const LOGIN = 'L1 LOGIN testuser testpass';
const ENABLE = 'E1 ENABLE IMAP4rev2';

const GLOBAL_MESSAGE =
    'From: a@example.com\r\nSubject: outer\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n' +
    '--b\r\nContent-Type: text/plain\r\n\r\nhello\r\n' +
    '--b\r\nContent-Type: message/global\r\n\r\nFrom: inner@example.com\r\nSubject: inner\r\n\r\ninner body\r\n' +
    '--b--\r\n';

const storage = () => ({
    INBOX: {
        messages: [
            { raw: 'Subject: hello\r\n\r\nWorld', flags: ['\\Seen', '\\Recent'] },
            { raw: utf8('Subject: Grüße\r\n\r\nKöln'), flags: ['\\Deleted'] },
            { raw: GLOBAL_MESSAGE, flags: ['\\Seen'] }
        ]
    },
    '': {
        separator: '/',
        folders: {
            Sent: { 'special-use': '\\Sent' },
            [mailboxName.encode('Жар')]: {},
            'A&-B': {},
            Parent: { flags: ['\\Noselect'], folders: { Child: {} } },
            Strict: { allowPermanentFlags: false }
        }
    }
});

describe('IMAP4rev2', () => {
    const ctx = setupServer(() => ({ plugins: ['IMAP4rev2', 'UNAUTHENTICATE'], storage: storage() }));

    // runs commands and returns the transcript decoded as UTF-8
    const run = cmds => new Promise(resolve => ctx.run(cmds.concat('ZZ LOGOUT'), resp => resolve(resp.toString('utf-8'))));
    // transcript after ENABLE IMAP4rev2
    const rev2 = async cmds => (await run([LOGIN, ENABLE].concat(cmds))).split(/^E1 OK .*$/m)[1];

    describe('capabilities (RFC 9051 sections 6.1.1 and 7.2.2, Appendix E)', () => {
        it('advertises IMAP4rev2 next to IMAP4rev1 and the folded in extensions', async () => {
            const resp = await run(['A1 CAPABILITY', LOGIN, 'A2 CAPABILITY']);
            const [before, after] = resp.split(/^L1 OK .*$/m);
            assert.match(before, /^\* CAPABILITY IMAP4rev1 .*\bIMAP4rev2\b/m);
            for (const capability of ['AUTH=PLAIN', 'SASL-IR', 'LITERAL-']) {
                assert.match(before, new RegExp('^\\* CAPABILITY .* ' + capability + '( |\\r)', 'm'), capability);
            }
            for (const capability of [
                'ENABLE',
                'NAMESPACE',
                'UNSELECT',
                'UIDPLUS',
                'ESEARCH',
                'SEARCHRES',
                'IDLE',
                'LIST-EXTENDED',
                'LIST-STATUS',
                'MOVE',
                'BINARY',
                'SPECIAL-USE',
                'STATUS=SIZE'
            ]) {
                assert.match(after, new RegExp('^\\* CAPABILITY .* ' + capability + '( |\\r)', 'm'), capability);
            }
        });

        it('ENABLE IMAP4rev2 does not change the CAPABILITY list (section 6.3.1)', async () => {
            const resp = await run([LOGIN, 'A1 CAPABILITY', ENABLE, 'A2 CAPABILITY']);
            const lists = resp.match(/^\* CAPABILITY .*$/gm);
            assert.strictEqual(lists.length, 2);
            assert.strictEqual(lists[0], lists[1]);
            assert.match(resp, /^\* ENABLED IMAP4rev2\r\nE1 OK /m);
        });

        it('can be enabled only before SELECT (RFC 5161 section 3.1)', async () => {
            const resp = await run([LOGIN, 'A1 SELECT INBOX', 'A2 ENABLE IMAP4rev2', 'A3 SEARCH ALL']);
            assert.match(resp, /^A2 BAD /m);
            // the session stays IMAP4rev1
            assert.match(resp, /^\* SEARCH 1 2 3\r$/m);
        });

        it('LITERAL+ replaces the implied LITERAL- in any load order (RFC 7888 section 5)', () => {
            for (const plugins of [
                ['IMAP4rev2', 'LITERAL+'],
                ['LITERAL+', 'IMAP4rev2']
            ]) {
                const server = hoodiecrow({ plugins });
                assert.ok(server.capabilities['LITERAL+'], plugins.join());
                assert.ok(!server.capabilities['LITERAL-'], plugins.join());
                assert.strictEqual(server.nonSyncLiteralLimit, Infinity);
            }
            assert.throws(() => hoodiecrow({ plugins: ['LITERAL-', 'IMAP4rev2', 'LITERAL+'] }), /LITERAL\+ can not be enabled together with LITERAL-/);
            assert.strictEqual(hoodiecrow({ plugins: ['IMAP4rev2'] }).nonSyncLiteralLimit, 4096);
        });

        it('accepts non-synchronizing literals up to 4096 octets (section 4.3)', async () => {
            const resp = await run([LOGIN, 'A1 SELECT {5+}\r\nINBOX', 'A2 SELECT {5000+}\r\n' + 'x'.repeat(5000)]);
            assert.match(resp, /^A1 OK /m);
            assert.match(resp, /^A2 BAD \[TOOBIG\] /m);
        });
    });

    describe('IMAP4rev1 sessions (Appendix A, section 7.2.2)', () => {
        it('keep the RFC 3501 behavior until ENABLE IMAP4rev2', async () => {
            const resp = await run([
                LOGIN,
                'A1 SELECT INBOX',
                'A2 SEARCH ALL',
                'A3 SEARCH NEW',
                'A4 CHECK',
                'A5 LSUB "" Sent',
                'A6 FETCH 1 (FLAGS RFC822.HEADER)',
                'A7 STATUS Sent (RECENT)',
                'A8 SELECT Sent',
                'A9 LIST "" "*"'
            ]);
            assertTagged(resp, { A1: 'OK', A2: 'OK', A3: 'OK', A4: 'OK', A5: 'OK', A6: 'OK', A7: 'OK', A8: 'OK' });
            assert.match(resp, /^\* 1 RECENT\r$/m);
            assert.match(resp, /^\* OK \[UNSEEN 2\] /m);
            assert.doesNotMatch(resp.split(/^A8 OK .*$/m)[0], /^\* LIST /m);
            assert.match(resp, /^\* SEARCH 1 2 3\r$/m);
            assert.doesNotMatch(resp, /ESEARCH/);
            assert.match(resp, /^\* 1 FETCH \(FLAGS \(\\Seen \\Recent\) RFC822\.HEADER /m);
            assert.match(resp, /^\* STATUS Sent \(RECENT 0\)\r$/m);
            // CLOSED is an IMAP4rev2 (and CONDSTORE) response code
            assert.doesNotMatch(resp, /\[CLOSED\]/);
            // modified UTF-7 names
            assert.match(resp, /^\* LIST \(\\HasNoChildren\) "\/" "&BBYEMARA-"\r$/m);
        });

        it('refuse UTF-8 in quoted strings (Appendix A)', async () => {
            const resp = await run([LOGIN, utf8('A1 CREATE "Ä"')]);
            assert.match(resp, /^A1 BAD /m);
        });

        it('describe message/global as a basic part (RFC 3501 section 9 body-type-basic)', async () => {
            const resp = await run([LOGIN, 'A1 EXAMINE INBOX', 'A2 FETCH 3 (BODYSTRUCTURE BODY[2.1] BINARY.SIZE[2])']);
            assert.match(resp, /\("MESSAGE" "GLOBAL" NIL NIL NIL "7BIT" 53 NIL NIL NIL\)/);
            // there is no part 2.1, BINARY of the basic part is allowed
            assert.match(resp, /BODY\[2\.1\] \{0\}\r\n /);
            assert.match(resp, /BINARY\.SIZE\[2\] 53\)/);
        });
    });

    describe('SELECT and EXAMINE (sections 6.3.2 and 6.3.3)', () => {
        it('send the LIST response and leave out RECENT and UNSEEN (Appendix E items 10 to 12)', async () => {
            const resp = await rev2(['A1 SELECT INBOX', 'A2 EXAMINE Sent']);
            const [select, examine] = resp.split(/^A1 OK .*$/m);
            assert.match(select, /^\* FLAGS \(/m);
            assert.match(select, /^\* OK \[PERMANENTFLAGS \(/m);
            assert.match(select, /^\* 3 EXISTS\r$/m);
            assert.match(select, /^\* OK \[UIDVALIDITY 1\] /m);
            assert.match(select, /^\* OK \[UIDNEXT 4\] /m);
            assert.match(select, /^\* LIST \(\\HasNoChildren\) "\/" INBOX\r$/m);
            assert.doesNotMatch(select, /RECENT|UNSEEN/);
            assert.match(resp, /^A1 OK \[READ-WRITE\] /m);

            // special-use attributes are mailbox attributes (section 7.3.1)
            assert.match(examine, /^\* LIST \(\\HasNoChildren \\Sent\) "\/" Sent\r$/m);
            assert.match(examine, /^A2 OK \[READ-ONLY\] /m);
        });

        it('send the CLOSED response code when they close a mailbox (Appendix E item 9)', async () => {
            const resp = await rev2(['A1 SELECT INBOX', 'A2 EXAMINE Sent', 'A3 SELECT Nothing', 'A4 SELECT INBOX', 'A5 SELECT']);
            const parts = resp.split(/^A\d (?:OK|NO) .*$/m);
            assert.doesNotMatch(parts[0], /CLOSED/);
            assert.match(parts[1], /^\* OK \[CLOSED\] [^\r]+\r\n\* FLAGS /m);
            // a failed SELECT closes the mailbox as well
            assert.match(resp, /^\* OK \[CLOSED\] [^\r]+\r\nA3 NO \[NONEXISTENT\] /m);
            // nothing was selected any more
            assert.doesNotMatch(parts[3], /CLOSED/);
            assert.match(resp, /^A5 BAD /m);
            assert.strictEqual(resp.match(/\[CLOSED\]/g).length, 2);
        });

        it('mailbox names are UTF-8 in the LIST response (section 5.1)', async () => {
            const resp = await rev2([utf8('A1 SELECT "Жар"')]);
            assert.match(resp, /^\* LIST \(\\HasNoChildren\) "\/" "Жар"\r$/m);
        });
    });

    // RFC 9208 section 4.1.4: QUOTA adds DELETED for every session
    for (const plugins of [
        ['IMAP4rev2', 'QUOTA'],
        ['QUOTA', 'IMAP4rev2']
    ]) {
        describe('with ' + plugins.join(' and '), () => {
            const ctx3 = setupServer(() => ({ plugins, storage: storage() }));

            it('STATUS DELETED works in IMAP4rev1 sessions too', async () => {
                const resp = await new Promise(resolve => ctx3.run([LOGIN, 'A1 STATUS INBOX (DELETED)', 'ZZ LOGOUT'], resolve));
                assert.match(resp.toString('binary'), /^\* STATUS INBOX \(DELETED 1\)\r\nA1 OK /m);
            });
        });
    }

    describe('with CONDSTORE', () => {
        const ctx2 = setupServer(() => ({ plugins: ['IMAP4rev2', 'CONDSTORE'], storage: storage() }));

        it('ENABLE matches case-insensitively and lists the canonical names (RFC 5161 section 3.2)', async () => {
            const resp = await new Promise(resolve => ctx2.run([LOGIN, 'A1 ENABLE condstore Imap4Rev2 X-UNKNOWN', 'ZZ LOGOUT'], resolve));
            assert.match(resp.toString('binary'), /^\* ENABLED CONDSTORE IMAP4rev2\r\nA1 OK /m);
        });

        it('sends CLOSED once', async () => {
            const resp = await new Promise(resolve => ctx2.run([LOGIN, ENABLE, 'A1 SELECT INBOX', 'A2 SELECT INBOX', 'ZZ LOGOUT'], resolve));
            assert.strictEqual((resp.toString('binary').match(/\[CLOSED\]/g) || []).length, 1, resp.toString());
        });
    });

    describe('SEARCH (section 6.4.4, Appendix E item 4)', () => {
        it('answers with ESEARCH', async () => {
            const resp = await rev2([
                'A1 SELECT INBOX',
                'A2 SEARCH ALL',
                'A3 UID SEARCH DELETED',
                'A4 SEARCH SUBJECT nothing',
                'A5 SEARCH RETURN (MIN COUNT) ALL',
                'A6 SEARCH RETURN () SEEN',
                'A7 SEARCH RETURN (SAVE) SEEN',
                'A8 FETCH $ UID'
            ]);
            assert.match(resp, /^\* ESEARCH \(TAG "A2"\) ALL 1:3\r$/m);
            assert.match(resp, /^\* ESEARCH \(TAG "A3"\) UID ALL 2\r$/m);
            // no ALL when nothing matched, the response is still sent
            assert.match(resp, /^\* ESEARCH \(TAG "A4"\)\r$/m);
            assert.match(resp, /^\* ESEARCH \(TAG "A5"\) MIN 1 COUNT 3\r$/m);
            assert.match(resp, /^\* ESEARCH \(TAG "A6"\) ALL 1,3\r$/m);
            // SAVE alone suppresses the ESEARCH response (section 6.4.4)
            assert.doesNotMatch(resp, /TAG "A7"/);
            assert.match(resp, /^\* 3 FETCH \(UID 3\)\r$/m);
            assert.doesNotMatch(resp, /^\* SEARCH/m);
        });

        it('refuses NEW, OLD and RECENT, they are not in the section 9 grammar', async () => {
            const resp = await rev2(['A1 SELECT INBOX', 'A2 SEARCH NEW', 'A3 SEARCH OLD', 'A4 UID SEARCH NOT RECENT', 'A5 SEARCH SUBJECT NEW']);
            assertTagged(resp, { A2: 'BAD', A3: 'BAD', A4: 'BAD', A5: 'OK' });
        });

        it('assumes UTF-8 without CHARSET, CHARSET is still allowed (section 6.4.4)', async () => {
            const resp = await rev2([
                'A1 SELECT INBOX',
                utf8('A2 SEARCH SUBJECT "Grüße"'),
                utf8('A3 SEARCH CHARSET UTF-8 SUBJECT "Grüße"'),
                'A4 SEARCH CHARSET US-ASCII SUBJECT hello',
                utf8('A5 SEARCH CHARSET US-ASCII SUBJECT "Grüße"'),
                'A6 SEARCH CHARSET ISO-8859-1 SUBJECT hello',
                'A7 SEARCH SUBJECT {2}\r\n\xff\xfe'
            ]);
            assert.match(resp, /^\* ESEARCH \(TAG "A2"\) ALL 2\r$/m);
            assert.match(resp, /^\* ESEARCH \(TAG "A3"\) ALL 2\r$/m);
            assert.match(resp, /^\* ESEARCH \(TAG "A4"\) ALL 1\r$/m);
            assertTagged(resp, { A5: 'BAD', A6: 'NO', A7: 'BAD' });
            assert.match(resp, /^A6 NO \[BADCHARSET \(US-ASCII UTF-8\)\] /m);
        });
    });

    describe('STATUS (section 6.3.11, Appendix E items 3 and 12)', () => {
        it('has DELETED and SIZE, but not RECENT', async () => {
            const resp = await rev2(['A1 STATUS INBOX (MESSAGES DELETED SIZE)', 'A2 STATUS INBOX (RECENT)', 'A3 LIST "" INBOX RETURN (STATUS (RECENT))']);
            assert.match(resp, /^\* STATUS INBOX \(MESSAGES 3 DELETED 1 SIZE \d+\)\r$/m);
            assertTagged(resp, { A1: 'OK', A2: 'BAD', A3: 'BAD' });
        });

        it('DELETED is not available to IMAP4rev1 sessions (RFC 3501 section 6.3.10)', async () => {
            const resp = await run([LOGIN, 'A1 STATUS INBOX (DELETED)', 'A2 LIST "" INBOX RETURN (STATUS (DELETED))', 'A3 STATUS INBOX (RECENT)']);
            assertTagged(resp, { A1: 'BAD', A2: 'BAD', A3: 'OK' });
        });

        it('ENABLE lists IMAP4rev2 in its canonical spelling (RFC 5161 section 3.2)', async () => {
            const resp = await run([LOGIN, 'A1 ENABLE imap4REV2', 'A2 STATUS INBOX (DELETED)']);
            assert.match(resp, /^\* ENABLED IMAP4rev2\r\nA1 OK /m);
            assert.match(resp, /^\* STATUS INBOX \(DELETED 1\)\r$/m);
        });
    });

    describe('removed commands and items', () => {
        it('CHECK and LSUB are BAD (Appendix E items 17 and 19)', async () => {
            const resp = await rev2(['A1 LSUB "" *', 'A2 SELECT INBOX', 'A3 CHECK', 'A4 NOOP', 'A5 LIST (SUBSCRIBED) "" *']);
            assertTagged(resp, { A1: 'BAD', A3: 'BAD', A4: 'OK', A5: 'OK' });
            assert.match(resp, /^A3 BAD .*NOOP/m);
            assert.doesNotMatch(resp, /^\* LSUB/m);
        });

        it('RFC822, RFC822.HEADER and RFC822.TEXT are BAD (Appendix E item 18)', async () => {
            const resp = await rev2([
                'A1 SELECT INBOX',
                'A2 FETCH 1 RFC822',
                'A3 FETCH 1 (UID RFC822.HEADER)',
                'A4 UID FETCH 1 rfc822.text',
                'A5 FETCH 1 (RFC822.SIZE BODY.PEEK[HEADER])'
            ]);
            assertTagged(resp, { A2: 'BAD', A3: 'BAD', A4: 'BAD', A5: 'OK' });
            assert.match(resp, /^\* 1 FETCH \(RFC822\.SIZE 23 BODY\[HEADER\] /m);
        });

        it('\\Recent is not sent (section 2.3.2, Appendix E item 12)', async () => {
            const resp = await rev2(['A1 SELECT INBOX', 'A2 FETCH 1 FLAGS', 'A3 STORE 1 +FLAGS (\\Flagged)', 'A4 STORE 1 +FLAGS (\\Recent)']);
            assert.match(resp, /^\* 1 FETCH \(FLAGS \(\\Seen\)\)\r$/m);
            assert.match(resp, /^\* 1 FETCH \(FLAGS \(\\Seen \\Flagged\)\)\r$/m);
            assert.match(resp, /^A4 BAD /m);
        });
    });

    describe('UTF-8 (sections 4.3, 5.1 and 6.3.12)', () => {
        it('mailbox names and quoted strings are UTF-8', async () => {
            const resp = await rev2([
                utf8('A1 CREATE "Ä/Ö"'),
                'A2 LIST "" *',
                'A3 CREATE "C&D"',
                utf8('A4 STATUS "Ä/Ö" (MESSAGES)'),
                'A5 NAMESPACE',
                'A6 CREATE "&BBY-"'
            ]);
            assertTagged(resp, { A1: 'OK', A3: 'OK', A4: 'OK', A5: 'OK', A6: 'OK' });
            assert.match(resp, /^\* LIST \(\\HasNoChildren\) "\/" "Жар"\r$/m);
            // "&" is an ordinary character
            assert.match(resp, /^\* LIST \(\\HasNoChildren\) "\/" "A&B"\r$/m);
            assert.match(resp, /^\* STATUS "Ä\/Ö" \(MESSAGES 0\)\r$/m);
            const storage = Object.keys(ctx.server.folderCache);
            assert.ok(storage.includes(mailboxName.encode('Ä/Ö')));
            assert.ok(storage.includes('C&-D'));
            assert.ok(storage.includes('&-BBY-'));
        });

        it('mailbox names must be Net-Unicode in Normalization Form C (section 5.1)', async () => {
            const decomposed = String.fromCharCode(0x41, 0x308);
            const resp = await rev2([utf8('A1 CREATE "' + decomposed + '"'), 'A2 CREATE "a\x7fb"']);
            assertTagged(resp, { A1: 'BAD', A2: 'BAD' });
            assert.match(resp, /^A1 BAD .*Normalization Form C/m);
        });

        it('a message with an 8-bit header can be appended', async () => {
            const message = utf8('Subject: Grüße\r\n\r\nHallo');
            const resp = await rev2(['A1 APPEND Sent {' + message.length + '}\r\n' + message]);
            assert.match(resp, /^A1 OK \[APPENDUID 1 1\] /m);
        });

        it('message/global encapsulates a message (sections 6.4.5.1 and 7.5.2)', async () => {
            const resp = await rev2([
                'A1 EXAMINE INBOX',
                'A2 FETCH 3 (BODYSTRUCTURE BODY BODY[2.HEADER] BODY[2.1] BINARY.SIZE[2.1])',
                'A3 FETCH 3 BINARY.SIZE[2]'
            ]);
            assert.match(
                resp,
                /BODYSTRUCTURE \(\("TEXT" "PLAIN" NIL NIL NIL "7BIT" 5 0 NIL NIL NIL\)\("MESSAGE" "GLOBAL" NIL NIL NIL "7BIT" 53 \(NIL "inner" /
            );
            assert.match(resp, /\("TEXT" "PLAIN" NIL NIL NIL "7BIT" 10 0 NIL NIL NIL\) 3 NIL NIL NIL\) "MIXED"/);
            assert.match(
                resp,
                /BODY \(\("TEXT" "PLAIN" NIL NIL NIL "7BIT" 5 0\)\("MESSAGE" "GLOBAL" NIL NIL NIL "7BIT" 53 \(NIL "inner" .*\("TEXT" "PLAIN" NIL NIL NIL "7BIT" 10 0\) 3\) "MIXED"\)/
            );
            assert.match(resp, /BODY\[2\.HEADER\] \{43\}\r\nFrom: inner@example\.com\r\nSubject: inner\r\n\r\n/);
            assert.match(resp, /BODY\[2\.1\] \{10\}\r\ninner body/);
            assert.match(resp, /BINARY\.SIZE\[2\.1\] 10\)/);
            // not a leaf part any more (section 6.4.5)
            assert.match(resp, /^A3 BAD /m);
        });
    });

    describe('keywords (section 2.3.2, Appendix E item 15)', () => {
        it('are kept in a mailbox that does not allow new keywords', async () => {
            const message = 'Subject: x\r\n\r\ny';
            const resp = await rev2([
                'A1 APPEND Strict ($Junk $Phishing) {' + message.length + '}\r\n' + message,
                'A2 SELECT Strict',
                'A3 STORE 1 +FLAGS ($Forwarded $MDNSent $NotJunk $Other)',
                'A4 SEARCH KEYWORD $Phishing'
            ]);
            assert.match(resp, /^\* OK \[PERMANENTFLAGS \(.*\$Forwarded \$MDNSent \$Junk \$NotJunk \$Phishing\)\]/m);
            assert.match(resp, /^\* 1 FETCH \(FLAGS \(\$Junk \$Phishing \$Forwarded \$MDNSent \$NotJunk\)\)\r$/m);
            assert.match(resp, /^\* ESEARCH \(TAG "A4"\) ALL 1\r$/m);
        });
    });

    describe('UIDPLUS and MOVE (sections 6.3.12, 6.4.7 and 6.4.8)', () => {
        it('COPY and MOVE return COPYUID, MOVE before the EXPUNGE', async () => {
            const resp = await rev2(['A1 SELECT INBOX', 'A2 COPY 1 Sent', 'A3 MOVE 1 Sent', 'A4 COPY 1 Parent', 'A5 COPY 1 Nothing']);
            assert.match(resp, /^A2 OK \[COPYUID 1 1 1\] /m);
            assert.match(resp, /^\* OK \[COPYUID 1 1 2\] [^\r]*\r\n\* 1 EXPUNGE\r$/m);
            // the target does not exist, but can be created (Appendix E item 8)
            assert.match(resp, /^A4 NO \[TRYCREATE\] /m);
            assert.match(resp, /^A5 NO \[TRYCREATE\] /m);
        });
    });

    it('UNAUTHENTICATE returns to IMAP4rev1 (RFC 8437 section 4.1)', async () => {
        const resp = await rev2(['A1 UNAUTHENTICATE', utf8('A2 SELECT "Ä"'), 'L2 LOGIN testuser testpass', 'A3 SELECT INBOX', 'A4 SEARCH ALL']);
        assert.match(resp, /^A2 BAD /m);
        assert.match(resp, /^\* SEARCH 1 2 3\r$/m);
        assert.match(resp, /^\* 1 RECENT\r$/m);
    });

    it('unsolicited FETCH responses include the UID and no \\Recent (section 7.5.2)', async () => {
        const open = () =>
            new Promise(resolve => {
                openSession(ctx.server.address().port, session => {
                    const cmd = line => new Promise(done => session.run(line, done));
                    resolve({ cmd, session });
                });
            });
        const a = await open();
        const b = await open();
        try {
            await a.cmd(LOGIN);
            await a.cmd(ENABLE);
            await a.cmd('A1 SELECT INBOX');
            await b.cmd(LOGIN);
            await b.cmd('B1 SELECT INBOX');
            await b.cmd('B2 STORE 1 +FLAGS (\\Flagged)');
            const output = await a.cmd('A2 NOOP');
            assert.match(output, /^\* 1 FETCH \(UID 1 FLAGS \(\\Seen \\Flagged\)\)\r$/m);
        } finally {
            a.session.close();
            b.session.close();
        }
    });
});
