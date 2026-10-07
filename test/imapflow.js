'use strict';

// End to end tests that drive hoodiecrow with ImapFlow, a real standards compliant IMAP client.
// Every test works with parsed results, so a malformed response shows up as a client error or
// as a wrong value, not as a substring mismatch.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { ImapFlow } = require('imapflow');
const { setupServer } = require('./helpers');

const ALL_PLUGINS = [
    'ID',
    'STARTTLS',
    'AUTH-PLAIN',
    'NAMESPACE',
    'IDLE',
    'ENABLE',
    'CONDSTORE',
    'ESEARCH',
    'SEARCHRES',
    'UIDPLUS',
    'MOVE',
    'PREVIEW',
    'SPECIAL-USE',
    'UNSELECT',
    'LITERALPLUS',
    'SASL-IR',
    'X-GM-EXT-1',
    'LIST-EXTENDED',
    'LIST-STATUS',
    'STATUS=SIZE',
    'METADATA'
];

const ATTACHMENT = Buffer.from(Array.from({ length: 300 }, (v, i) => (i * 7) % 256));

const MESSAGE_1 =
    'From: Alice Example <alice@example.com>\r\n' +
    'To: Bob Example <bob@example.com>\r\n' +
    'Cc: carol@example.com\r\n' +
    'Subject: Hello world\r\n' +
    'Message-ID: <m1@example.com>\r\n' +
    'Date: Thu, 01 Jan 2026 10:00:00 +0000\r\n' +
    '\r\n' +
    'Hello Bob,\r\n' +
    'how are you?\r\n';

const MESSAGE_2 =
    'From: Carol <carol@example.com>\r\n' +
    'To: alice@example.com\r\n' +
    'Subject: Report attached\r\n' +
    'X-Priority: 1\r\n' +
    'Date: Sun, 15 Feb 2026 12:00:00 +0000\r\n' +
    'MIME-Version: 1.0\r\n' +
    'Content-Type: multipart/mixed; boundary="bnd"\r\n' +
    '\r\n' +
    '--bnd\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    '\r\n' +
    'See the report.\r\n' +
    '--bnd\r\n' +
    'Content-Type: application/octet-stream; name="data.bin"\r\n' +
    'Content-Disposition: attachment; filename="data.bin"\r\n' +
    'Content-Transfer-Encoding: base64\r\n' +
    '\r\n' +
    ATTACHMENT.toString('base64').replace(/.{76}/g, '$&\r\n').replace(/\r\n$/, '') +
    '\r\n' +
    '--bnd--\r\n';

const MESSAGE_3 =
    'From: Bob Example <bob@example.com>\r\n' +
    'To: Alice Example <alice@example.com>\r\n' +
    'Subject: Re: Hello world\r\n' +
    'In-Reply-To: <m1@example.com>\r\n' +
    'Date: Tue, 10 Mar 2026 08:30:00 +0000\r\n' +
    '\r\n' +
    'Thanks, fine.\r\n';

function storage() {
    return {
        INBOX: {
            messages: [
                { raw: MESSAGE_1, uid: 1, flags: ['\\Seen'], internaldate: '01-Jan-2026 10:00:00 +0000' },
                { raw: MESSAGE_2, uid: 2, flags: ['\\Flagged', '$Work'], internaldate: '15-Feb-2026 12:00:00 +0000' },
                { raw: MESSAGE_3, uid: 5, flags: [], internaldate: '10-Mar-2026 08:30:00 +0000' }
            ]
        },
        '': {
            folders: {
                Sent: { 'special-use': '\\Sent' },
                Trash: { 'special-use': '\\Trash' },
                Drafts: { 'special-use': '\\Drafts', subscribed: false },
                Archive: {
                    folders: {
                        2025: {}
                    }
                }
            }
        }
    };
}

/**
 * Records every completed command as "COMMAND STATUS" (eg. "UID MOVE OK"), so tests can tell which
 * command variant the client used (AUTHENTICATE PLAIN vs LOGIN, MOVE vs COPY)
 */
function recorder(log) {
    return server => {
        server.outputHandlers.push((connection, response, description, parsed) => {
            if (parsed && parsed.command && response.tag === parsed.tag) {
                log.push(parsed.command.toUpperCase() + ' ' + response.command);
            }
        });
    };
}

describe('ImapFlow', () => {
    let clients = [];

    const createClient = (ctx, options) => {
        const client = new ImapFlow(
            Object.assign(
                {
                    host: '127.0.0.1',
                    port: ctx.server.address().port,
                    secure: false,
                    doSTARTTLS: false,
                    tls: { rejectUnauthorized: false },
                    logger: false,
                    auth: { user: 'testuser', pass: 'testpass' }
                },
                options || {}
            )
        );
        // the server closes leftover connections after every test
        client.on('error', () => false);
        clients.push(client);
        return client;
    };

    const connect = async (ctx, options) => {
        const client = createClient(ctx, options);
        await client.connect();
        return client;
    };

    afterEach(async () => {
        for (const client of clients) {
            if (client.usable) {
                await client.logout().catch(() => false);
            }
        }
        clients = [];
    });

    /**
     * Resolves once the predicate returns true, polling every few milliseconds
     */
    const waitFor = (predicate, what, timeout) =>
        new Promise((resolve, reject) => {
            const started = Date.now();
            const check = () => {
                if (predicate()) {
                    return resolve();
                }
                if (Date.now() - started > (timeout || 3000)) {
                    return reject(new Error('Timeout waiting for ' + what));
                }
                setTimeout(check, 5);
            };
            check();
        });

    const fetchAll = async (client, range, query, options) => {
        const list = [];
        for await (const message of client.fetch(range, query, options)) {
            list.push(message);
        }
        return list;
    };

    const readStream = async stream => {
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    };

    describe('with all plugins', () => {
        const log = [];
        const ctx = setupServer(() => {
            log.length = 0;
            return { plugins: ALL_PLUGINS.concat(recorder(log)), id: { name: 'hoodiecrow' }, storage: storage() };
        });

        it('authenticates with AUTHENTICATE PLAIN and sees the extension capabilities', async () => {
            const client = await connect(ctx);
            assert.ok(client.authenticated);
            // AUTH=PLAIN is advertised before login, so ImapFlow prefers it over LOGIN (RFC 4616)
            assert.ok(log.includes('AUTHENTICATE PLAIN OK'), log.join(', '));
            assert.ok(!log.includes('LOGIN OK'), log.join(', '));
            for (const capability of [
                'IMAP4rev1',
                'IDLE',
                'ENABLE',
                'CONDSTORE',
                'UIDPLUS',
                'MOVE',
                'SPECIAL-USE',
                'UNSELECT',
                'NAMESPACE',
                'ID',
                'LITERAL+'
            ]) {
                assert.ok(client.capabilities.has(capability), capability);
            }
            // AUTH=PLAIN is only listed in the Not Authenticated state
            assert.ok(!client.capabilities.has('AUTH=PLAIN'));
            // ImapFlow sends ENABLE CONDSTORE on its own (RFC 5161, RFC 7162 3.1)
            assert.ok(client.enabled.has('CONDSTORE'));
            assert.strictEqual(client.serverInfo && client.serverInfo.name, 'hoodiecrow');
            // NAMESPACE response (RFC 2342 5), ImapFlow keeps the personal namespace
            assert.deepStrictEqual(client.namespace, { prefix: '', delimiter: '/' });
            await client.logout();
            assert.ok(!client.usable);
        });

        it('rejects wrong credentials', async () => {
            const client = createClient(ctx, { auth: { user: 'testuser', pass: 'wrong' } });
            await assert.rejects(client.connect(), err => err.authenticationFailed === true || /auth/i.test(err.message));
        });

        it('upgrades the connection with STARTTLS', async () => {
            const client = await connect(ctx, { doSTARTTLS: true });
            assert.strictEqual(client.secureConnection, true);
            // STARTTLS is not offered again on a secure connection (RFC 3501 6.2.1)
            assert.ok(!client.capabilities.has('STARTTLS'));
            const mailbox = await client.mailboxOpen('INBOX');
            assert.strictEqual(mailbox.exists, 3);
        });

        it('lists mailboxes with STATUS data through LIST-STATUS', async () => {
            const client = await connect(ctx);
            const list = await client.list({ statusQuery: { messages: true, unseen: true, size: true } });
            const inbox = list.find(entry => entry.path === 'INBOX');
            const mailbox = await client.status('INBOX', { messages: true, unseen: true, size: true });
            assert.strictEqual(inbox.status.messages, 3);
            assert.strictEqual(inbox.status.messages, mailbox.messages);
            assert.strictEqual(inbox.status.unseen, mailbox.unseen);
            assert.ok(inbox.status.size > 0);
            assert.strictEqual(inbox.status.size, mailbox.size);
        });

        it('lists mailboxes with special-use attributes and builds a tree', async () => {
            const client = await connect(ctx);
            const list = await client.list();
            const byPath = Object.fromEntries(list.map(entry => [entry.path, entry]));
            assert.deepStrictEqual(Object.keys(byPath).sort(), ['Archive', 'Archive/2025', 'Drafts', 'INBOX', 'Sent', 'Trash']);
            assert.strictEqual(byPath.Sent.specialUse, '\\Sent');
            assert.strictEqual(byPath.Trash.specialUse, '\\Trash');
            assert.strictEqual(byPath.Drafts.specialUse, '\\Drafts');
            assert.ok(!byPath.Drafts.subscribed);
            assert.strictEqual(byPath.Sent.subscribed, true);
            assert.strictEqual(byPath['Archive/2025'].parentPath, 'Archive');
            assert.strictEqual(byPath.Archive.delimiter, '/');
            assert.ok(byPath.Archive.flags.has('\\HasChildren'));

            const tree = await client.listTree();
            const archive = tree.folders.find(folder => folder.path === 'Archive');
            assert.ok(archive);
            assert.deepStrictEqual(
                archive.folders.map(folder => folder.path),
                ['Archive/2025']
            );
        });

        it('opens mailboxes read-write and read-only and reads STATUS', async () => {
            const client = await connect(ctx);

            const mailbox = await client.mailboxOpen('INBOX');
            assert.strictEqual(mailbox.path, 'INBOX');
            assert.strictEqual(mailbox.exists, 3);
            assert.strictEqual(mailbox.uidNext, 6);
            assert.strictEqual(mailbox.uidValidity, 1n);
            assert.strictEqual(mailbox.readOnly, false);
            assert.ok(mailbox.flags.has('$Work'), 'keywords in use are listed in FLAGS');
            assert.ok(mailbox.permanentFlags.has('\\*'));
            assert.strictEqual(typeof mailbox.highestModseq, 'bigint');

            const status = await client.status('Sent', { messages: true, unseen: true, uidNext: true, uidValidity: true, recent: true, highestModseq: true });
            assert.strictEqual(status.messages, 0);
            assert.strictEqual(status.unseen, 0);
            assert.strictEqual(status.uidNext, 1);
            assert.strictEqual(status.recent, 0);
            assert.strictEqual(typeof status.highestModseq, 'bigint');

            const inboxStatus = await client.status('INBOX', { messages: true, unseen: true });
            assert.deepStrictEqual([inboxStatus.messages, inboxStatus.unseen], [3, 2]);

            const examined = await client.mailboxOpen('Sent', { readOnly: true });
            assert.strictEqual(examined.readOnly, true);
            assert.strictEqual(examined.exists, 0);

            await client.mailboxClose();
            assert.strictEqual(client.mailbox, false);
        });

        it('appends with flags and internal date and reports APPENDUID', async () => {
            const client = await connect(ctx);
            const date = new Date('2026-04-05T06:07:08Z');
            const raw = 'From: me@example.com\r\nSubject: appended\r\n\r\nappended body\r\n';

            const result = await client.append('Sent', raw, ['\\Seen', '$Custom'], date);
            // RFC 4315 3: APPENDUID uidvalidity uid
            assert.strictEqual(result.destination, 'Sent');
            assert.strictEqual(result.uid, 1);
            assert.strictEqual(typeof result.uidValidity, 'bigint');

            await client.mailboxOpen('Sent');
            const message = await client.fetchOne('1', { uid: true, flags: true, internalDate: true, size: true, source: true }, { uid: true });
            assert.strictEqual(message.uid, 1);
            assert.ok(message.flags.has('\\Seen'));
            assert.ok(message.flags.has('$Custom'));
            assert.strictEqual(message.internalDate.toISOString(), date.toISOString());
            assert.strictEqual(message.size, Buffer.byteLength(raw));
            assert.strictEqual(message.source.toString(), raw);
        });

        it('appends to a missing mailbox with TRYCREATE', async () => {
            const client = await connect(ctx);
            await assert.rejects(client.append('Missing', 'Subject: x\r\n\r\ny\r\n'), err => err.serverResponseCode === 'TRYCREATE');
        });

        it('fetches envelope, bodystructure, flags, source and sections', async () => {
            const client = await connect(ctx);
            await client.mailboxOpen('INBOX');

            const messages = await fetchAll(client, '1:*', {
                uid: true,
                flags: true,
                envelope: true,
                bodyStructure: true,
                source: true,
                size: true,
                internalDate: true,
                headers: ['subject', 'x-priority'],
                bodyParts: ['1']
            });
            assert.deepStrictEqual(
                messages.map(message => [message.seq, message.uid]),
                [
                    [1, 1],
                    [2, 2],
                    [3, 5]
                ]
            );

            const [first, second, third] = messages;

            assert.strictEqual(first.envelope.subject, 'Hello world');
            assert.strictEqual(first.envelope.messageId, '<m1@example.com>');
            assert.strictEqual(first.envelope.date.toISOString(), '2026-01-01T10:00:00.000Z');
            assert.deepStrictEqual(first.envelope.from, [{ name: 'Alice Example', address: 'alice@example.com' }]);
            assert.deepStrictEqual(first.envelope.to, [{ name: 'Bob Example', address: 'bob@example.com' }]);
            assert.deepStrictEqual(first.envelope.cc, [{ name: '', address: 'carol@example.com' }]);
            // RFC 3501 7.4.2: sender and reply-to default to from
            assert.deepStrictEqual(first.envelope.sender, first.envelope.from);
            assert.deepStrictEqual(first.envelope.replyTo, first.envelope.from);
            assert.strictEqual(third.envelope.inReplyTo, '<m1@example.com>');

            assert.strictEqual(first.source.toString(), MESSAGE_1);
            assert.strictEqual(first.size, Buffer.byteLength(MESSAGE_1));
            assert.strictEqual(second.source.toString(), MESSAGE_2);
            assert.strictEqual(first.internalDate.toISOString(), '2026-01-01T10:00:00.000Z');

            assert.deepStrictEqual([...first.flags], ['\\Seen']);
            assert.deepStrictEqual([...second.flags].sort(), ['$Work', '\\Flagged']);
            assert.deepStrictEqual([...third.flags], []);

            assert.deepStrictEqual(first.bodyStructure, { type: 'text/plain', encoding: '7bit', size: 26, lineCount: 2 });
            assert.strictEqual(second.bodyStructure.type, 'multipart/mixed');
            assert.strictEqual(second.bodyStructure.parameters.boundary, 'bnd');
            const [text, attachment] = second.bodyStructure.childNodes;
            assert.strictEqual(text.part, '1');
            assert.strictEqual(text.type, 'text/plain');
            assert.strictEqual(text.parameters.charset, 'utf-8');
            // the CRLF before the boundary belongs to the delimiter (RFC 2046 5.1.1), so the part has no line break
            assert.strictEqual(text.lineCount, 0);
            assert.strictEqual(attachment.part, '2');
            assert.strictEqual(attachment.type, 'application/octet-stream');
            assert.strictEqual(attachment.encoding, 'base64');
            assert.strictEqual(attachment.disposition, 'attachment');
            assert.strictEqual(attachment.dispositionParameters.filename, 'data.bin');
            assert.strictEqual(attachment.parameters.name, 'data.bin');

            // HEADER.FIELDS returns the requested fields followed by the blank line (RFC 3501 6.4.5)
            assert.strictEqual(second.headers.toString(), 'Subject: Report attached\r\nX-Priority: 1\r\n\r\n');
            assert.strictEqual(first.headers.toString(), 'Subject: Hello world\r\n\r\n');
            assert.strictEqual(first.bodyParts.get('1').toString(), 'Hello Bob,\r\nhow are you?\r\n');
            assert.strictEqual(second.bodyParts.get('1').toString(), 'See the report.');
        });

        it('does not set \\Seen when fetching with BODY.PEEK', async () => {
            const client = await connect(ctx);
            await client.mailboxOpen('INBOX');
            await fetchAll(client, '3', { source: true, bodyParts: ['1'] });
            const message = await client.fetchOne('3', { flags: true });
            assert.ok(!message.flags.has('\\Seen'));
        });

        it('downloads and decodes parts', async () => {
            const client = await connect(ctx);
            await client.mailboxOpen('INBOX');

            const attachment = await client.download('2', '2', { uid: true });
            assert.strictEqual(attachment.meta.contentType, 'application/octet-stream');
            assert.strictEqual(attachment.meta.filename, 'data.bin');
            assert.strictEqual(attachment.meta.encoding, 'base64');
            assert.ok((await readStream(attachment.content)).equals(ATTACHMENT));

            const text = await client.download('2', '1', { uid: true });
            assert.strictEqual(text.meta.charset, 'utf-8');
            assert.strictEqual((await readStream(text.content)).toString(), 'See the report.');

            const full = await client.download('5', false, { uid: true });
            assert.strictEqual((await readStream(full.content)).toString(), MESSAGE_3);

            const many = await client.downloadMany('2', ['1', '2'], { uid: true });
            assert.ok(many['2'].content.equals(ATTACHMENT));
        });

        it('searches with various criteria', async () => {
            const client = await connect(ctx);
            await client.mailboxOpen('INBOX');

            const cases = [
                [{ all: true }, [1, 2, 3]],
                [{ seen: true }, [1]],
                [{ seen: false }, [2, 3]],
                [{ flagged: true }, [2]],
                [{ keyword: '$Work' }, [2]],
                [{ unKeyword: '$Work' }, [1, 3]],
                [{ subject: 'hello' }, [1, 3]],
                [{ from: 'carol' }, [2]],
                [{ to: 'alice@example.com' }, [2, 3]],
                [{ cc: 'carol' }, [1]],
                [{ body: 'report' }, [2]],
                [{ text: 'fine' }, [3]],
                [{ header: { 'x-priority': '1' } }, [2]],
                [{ header: { 'in-reply-to': '' } }, [3]],
                [{ or: [{ from: 'carol' }, { seen: true }] }, [1, 2]],
                [{ not: { subject: 'hello' } }, [2]],
                [{ since: new Date('2026-02-01T00:00:00Z') }, [2, 3]],
                [{ before: new Date('2026-02-15T00:00:00Z') }, [1]],
                [{ on: new Date('2026-02-15T00:00:00Z') }, [2]],
                [{ sentSince: new Date('2026-03-01T00:00:00Z') }, [3]],
                [{ sentBefore: new Date('2026-01-02T00:00:00Z') }, [1]],
                [{ larger: 500 }, [2]],
                [{ smaller: 300 }, [1, 3]],
                [{ uid: '2:5' }, [2, 3]],
                [{ uid: '3:4' }, []],
                [{ seq: '2:*' }, [2, 3]],
                [{ seen: false, flagged: false }, [3]]
            ];

            for (const [query, expected] of cases) {
                assert.deepStrictEqual(await client.search(query), expected, JSON.stringify(query));
            }

            // UID SEARCH returns UIDs
            assert.deepStrictEqual(await client.search({ seen: false }, { uid: true }), [2, 5]);

            // ESEARCH result options (RFC 4731)
            assert.deepStrictEqual(await client.search({ seen: false }, { returnOptions: ['MIN', 'MAX', 'COUNT', 'ALL'] }), {
                min: 2,
                max: 3,
                count: 2,
                all: '2:3'
            });
            assert.deepStrictEqual(await client.search({ seen: false }, { uid: true, returnOptions: ['COUNT', 'ALL'] }), { count: 2, all: '2,5' });
            assert.deepStrictEqual(await client.search({ deleted: true }, { returnOptions: ['MIN', 'COUNT'] }), { count: 0 });
        });

        it('adds, removes and replaces flags', async () => {
            const client = await connect(ctx);
            await client.mailboxOpen('INBOX');

            const flagsOf = async () => (await fetchAll(client, '1:*', { flags: true })).map(message => [...message.flags].sort());

            assert.strictEqual(await client.messageFlagsAdd('1:2', ['\\Answered', '$Done']), true);
            assert.deepStrictEqual(await flagsOf(), [['$Done', '\\Answered', '\\Seen'], ['$Done', '$Work', '\\Answered', '\\Flagged'], []]);
            // keywords in use are listed in the FLAGS response of the next SELECT (RFC 3501 7.2.6)
            assert.ok((await client.mailboxOpen('INBOX')).flags.has('$Done'));

            assert.strictEqual(await client.messageFlagsRemove('5', ['\\Seen'], { uid: true }), true);
            assert.strictEqual(await client.messageFlagsRemove('1', ['\\Answered', '$Done']), true);
            assert.deepStrictEqual(await flagsOf(), [['\\Seen'], ['$Done', '$Work', '\\Answered', '\\Flagged'], []]);

            assert.strictEqual(await client.messageFlagsSet('2,5', ['\\Draft'], { uid: true }), true);
            assert.deepStrictEqual(await flagsOf(), [['\\Seen'], ['\\Draft'], ['\\Draft']]);
        });

        it('copies with COPYUID and moves with MOVE', async () => {
            const client = await connect(ctx);
            await client.mailboxOpen('INBOX');

            const copied = await client.messageCopy('1:2', 'Sent');
            // RFC 4315 3: COPYUID uidvalidity source-uids dest-uids
            assert.strictEqual(copied.destination, 'Sent');
            assert.deepStrictEqual(
                [...copied.uidMap],
                [
                    [1, 1],
                    [2, 2]
                ]
            );

            log.length = 0;
            const moved = await client.messageMove('5', 'Trash', { uid: true });
            assert.deepStrictEqual([...moved.uidMap], [[5, 1]]);
            assert.ok(log.includes('UID MOVE OK'), log.join(', '));
            assert.ok(!log.includes('UID COPY OK'), log.join(', '));
            assert.strictEqual(client.mailbox.exists, 2);

            const sent = await client.status('Sent', { messages: true });
            assert.strictEqual(sent.messages, 2);

            await client.mailboxOpen('Trash');
            const [trashed] = await fetchAll(client, '1:*', { uid: true, envelope: true, source: true });
            assert.strictEqual(trashed.envelope.subject, 'Re: Hello world');
            assert.strictEqual(trashed.source.toString(), MESSAGE_3);
        });

        it('fails to copy into a missing mailbox with TRYCREATE', async () => {
            const client = await connect(ctx);
            await client.mailboxOpen('INBOX');
            const result = await client.messageCopy('1', 'Nowhere');
            // ImapFlow reports a failed copy as false
            assert.strictEqual(result, false);
        });

        it('deletes messages with UID EXPUNGE', async () => {
            const client = await connect(ctx);
            await client.mailboxOpen('INBOX');
            const expunged = [];
            client.on('expunge', event => expunged.push(event.seq));

            // \Deleted on another message must survive a UID EXPUNGE that does not include it (RFC 4315 2.1)
            await client.messageFlagsAdd('1', ['\\Deleted']);
            assert.strictEqual(await client.messageDelete('2', { uid: true }), true);
            assert.deepStrictEqual(expunged, [2]);
            assert.strictEqual(client.mailbox.exists, 2);

            const remaining = await fetchAll(client, '1:*', { uid: true, flags: true });
            assert.deepStrictEqual(
                remaining.map(message => [message.uid, message.flags.has('\\Deleted')]),
                [
                    [1, true],
                    [5, false]
                ]
            );
        });

        it('creates, renames, subscribes and deletes mailboxes', async () => {
            const client = await connect(ctx);

            assert.deepStrictEqual(await client.mailboxCreate('Projects/Alpha'), { path: 'Projects/Alpha', created: true });
            // NO [ALREADYEXISTS] (RFC 5530) lets ImapFlow report an existing mailbox instead of an error
            assert.strictEqual((await client.mailboxCreate('Projects/Alpha')).created, false);
            assert.deepStrictEqual(await client.mailboxRename('Projects', 'Work'), { path: 'Projects', newPath: 'Work' });

            let paths = (await client.list()).map(entry => entry.path);
            assert.ok(paths.includes('Work/Alpha'), paths.join(', '));
            assert.ok(!paths.includes('Projects/Alpha'), paths.join(', '));

            assert.strictEqual(await client.mailboxSubscribe('Drafts'), true);
            assert.strictEqual(await client.mailboxUnsubscribe('Sent'), true);
            const subscribed = (await client.list()).filter(entry => entry.subscribed).map(entry => entry.path);
            assert.ok(subscribed.includes('Drafts'));
            assert.ok(!subscribed.includes('Sent'));

            assert.deepStrictEqual(await client.mailboxDelete('Work/Alpha'), { path: 'Work/Alpha' });
            paths = (await client.list()).map(entry => entry.path);
            assert.ok(!paths.includes('Work/Alpha'), paths.join(', '));

            await assert.rejects(client.mailboxDelete('INBOX'));
        });

        const isIdling = () => [...ctx.server.connections].filter(connection => connection.directNotifications).length === 1;

        it('receives EXISTS and EXPUNGE from another client while idling', async () => {
            const watcher = await connect(ctx);
            const actor = await connect(ctx);

            await watcher.mailboxOpen('INBOX');
            await actor.mailboxOpen('INBOX');

            const events = [];
            watcher.on('exists', event => events.push(['exists', event.count, event.prevCount]));
            watcher.on('expunge', event => events.push(['expunge', event.seq]));

            let idle = watcher.idle();
            await waitFor(isIdling, 'IDLE');

            // RFC 2177 3: while idling the server sends untagged EXISTS and EXPUNGE responses
            await actor.append('INBOX', 'Subject: pushed\r\n\r\nnew\r\n');
            await waitFor(() => events.length >= 1, 'EXISTS');
            assert.deepStrictEqual(events.shift(), ['exists', 4, 3]);

            await actor.messageDelete('1');
            await waitFor(() => events.length >= 1, 'EXPUNGE');
            assert.deepStrictEqual(events.shift(), ['expunge', 1]);

            // any command ends IDLE
            const status = await watcher.status('INBOX', { messages: true });
            assert.strictEqual(status.messages, 3);
            await idle;
            assert.strictEqual(watcher.mailbox.exists, 3);

            // a second IDLE continues with the same mailbox view
            idle = watcher.idle();
            await waitFor(isIdling, 'IDLE');
            await actor.append('INBOX', 'Subject: pushed again\r\n\r\nnew\r\n');
            await waitFor(() => events.length >= 1, 'second EXISTS');
            assert.deepStrictEqual(events.shift(), ['exists', 4, 3]);
            await watcher.noop();
            await idle;

            const seen = await fetchAll(watcher, '1:*', { uid: true, envelope: true });
            assert.deepStrictEqual(
                seen.map(message => message.envelope.subject),
                ['Report attached', 'Re: Hello world', 'pushed', 'pushed again']
            );
        });

        it('receives flag changes from another client while idling', async () => {
            const watcher = await connect(ctx);
            const actor = await connect(ctx);

            await watcher.mailboxOpen('INBOX');
            await actor.mailboxOpen('INBOX');

            const events = [];
            watcher.on('flags', event => events.push([event.seq, [...event.flags].sort()]));

            const idle = watcher.idle();
            await waitFor(isIdling, 'IDLE');

            // RFC 3501 5.2: a server SHOULD send flag updates without the client asking for them
            await actor.messageFlagsAdd('2', ['\\Answered']);
            await waitFor(() => events.length >= 1, 'FETCH', 500);
            assert.deepStrictEqual(events.shift(), [2, ['$Work', '\\Answered', '\\Flagged']]);

            await watcher.noop();
            await idle;
        });

        it('fetches only changed messages with CHANGEDSINCE', async () => {
            const client = await connect(ctx);
            const mailbox = await client.mailboxOpen('INBOX');
            const before = mailbox.highestModseq;

            await client.messageFlagsAdd('2', ['\\Answered']);

            // RFC 7162 3.1.4: FETCH with CHANGEDSINCE returns messages with a higher MODSEQ, and MODSEQ is included
            const changed = await fetchAll(client, '1:*', { uid: true, flags: true }, { changedSince: before });
            assert.deepStrictEqual(
                changed.map(message => message.uid),
                [2]
            );
            assert.ok(changed[0].modseq > before);

            const status = await client.status('INBOX', { highestModseq: true });
            assert.strictEqual(status.highestModseq, changed[0].modseq);
            // RFC 7162 3.1.2: HIGHESTMODSEQ is the highest MODSEQ of all messages in the mailbox
            const all = await fetchAll(client, '1:*', { uid: true });
            assert.strictEqual(
                all.map(message => message.modseq).reduce((a, b) => (a > b ? a : b)),
                status.highestModseq
            );
        });

        it('reads Gmail labels and message ids with X-GM-EXT-1', async () => {
            const client = await connect(ctx);
            await client.mailboxOpen('INBOX');
            const messages = await fetchAll(client, '1:*', { uid: true, labels: true });
            const ids = messages.map(message => message.emailId);
            assert.strictEqual(new Set(ids).size, 3);
            ids.forEach(id => assert.match(id, /^\d+$/));
        });
    });

    describe('without plugins', () => {
        const log = [];
        const ctx = setupServer(() => {
            log.length = 0;
            return { plugins: [recorder(log)], storage: storage() };
        });

        it('logs in with LOGIN and advertises only IMAP4rev1', async () => {
            const client = await connect(ctx);
            assert.ok(log.includes('LOGIN OK'), log.join(', '));
            assert.deepStrictEqual([...client.capabilities.keys()], ['IMAP4rev1']);
            assert.strictEqual(client.enabled.size, 0);
            // without NAMESPACE ImapFlow derives the namespace from LIST "" ""
            assert.strictEqual(client.namespace.delimiter, '/');
        });

        it('lists, opens and fetches', async () => {
            const client = await connect(ctx);
            const list = await client.list();
            assert.deepStrictEqual(list.map(entry => entry.path).sort(), ['Archive', 'Archive/2025', 'Drafts', 'INBOX', 'Sent', 'Trash']);
            // without SPECIAL-USE ImapFlow guesses special-use from the names
            assert.strictEqual(list.find(entry => entry.path === 'Sent').specialUse, '\\Sent');

            const mailbox = await client.mailboxOpen('INBOX');
            assert.strictEqual(mailbox.exists, 3);
            assert.strictEqual(mailbox.highestModseq, undefined);

            const messages = await fetchAll(client, '1:*', { uid: true, envelope: true, bodyStructure: true, source: true });
            assert.deepStrictEqual(
                messages.map(message => message.envelope.subject),
                ['Hello world', 'Report attached', 'Re: Hello world']
            );
            assert.strictEqual(messages[1].source.toString(), MESSAGE_2);
            assert.strictEqual(messages[0].modseq, undefined);
        });

        it('appends without APPENDUID', async () => {
            const client = await connect(ctx);
            const result = await client.append('Sent', 'Subject: x\r\n\r\ny\r\n', ['\\Seen']);
            assert.strictEqual(result.destination, 'Sent');
            assert.strictEqual(result.uid, undefined);
            const status = await client.status('Sent', { messages: true });
            assert.strictEqual(status.messages, 1);
        });

        it('copies without COPYUID and moves with COPY, STORE and EXPUNGE', async () => {
            const client = await connect(ctx);
            await client.mailboxOpen('INBOX');

            const copied = await client.messageCopy('1', 'Sent');
            assert.strictEqual(copied.destination, 'Sent');
            assert.strictEqual(copied.uidMap, undefined);

            log.length = 0;
            const moved = await client.messageMove('2', 'Trash');
            assert.strictEqual(moved.destination, 'Trash');
            assert.ok(log.includes('COPY OK'), log.join(', '));
            assert.ok(log.includes('EXPUNGE OK'), log.join(', '));
            assert.strictEqual(client.mailbox.exists, 2);

            const trash = await client.status('Trash', { messages: true });
            assert.strictEqual(trash.messages, 1);

            const remaining = await fetchAll(client, '1:*', { uid: true });
            assert.deepStrictEqual(
                remaining.map(message => message.uid),
                [1, 5]
            );
        });

        it('deletes with STORE and EXPUNGE', async () => {
            const client = await connect(ctx);
            await client.mailboxOpen('INBOX');
            assert.strictEqual(await client.messageDelete('1:2'), true);
            assert.strictEqual(client.mailbox.exists, 1);
            assert.deepStrictEqual(await client.search({ all: true }, { uid: true }), [5]);
        });

        it('searches and changes flags', async () => {
            const client = await connect(ctx);
            await client.mailboxOpen('INBOX');
            assert.deepStrictEqual(await client.search({ or: [{ flagged: true }, { not: { seen: false } }] }), [1, 2]);
            await client.messageFlagsSet('1:*', ['\\Seen']);
            assert.deepStrictEqual(await client.search({ seen: false }), []);
        });

        it('closes the mailbox without UNSELECT', async () => {
            const client = await connect(ctx);
            await client.mailboxOpen('INBOX');
            await client.messageFlagsAdd('1', ['\\Deleted']);
            log.length = 0;
            // without UNSELECT ImapFlow closes with CLOSE, which expunges (RFC 3501 6.4.2)
            await client.mailboxClose();
            assert.ok(log.includes('CLOSE OK'), log.join(', '));
            const status = await client.status('INBOX', { messages: true });
            assert.strictEqual(status.messages, 2);
        });
    });
});
