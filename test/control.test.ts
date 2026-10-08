// The control API (server.control): inspection and changes from a test, and what connected sessions see of them.
// A change from the API must look to every session like a change another session made (RFC 3501 sections 5.2
// and 7.4.1, RFC 2180), with no session as its origin.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import imapkit from '../src/server.js';
import { ImapKitError } from '../src/control.js';
import { setupServer } from './helpers/index.js';
import { useSessions, openSession } from './helpers/session.js';
import type { Session } from './helpers/session.js';

const message = (n: number) => 'From: sender@example.com\r\nSubject: message ' + n + '\r\n\r\nBody ' + n + '\r\n';

function storage() {
    return {
        INBOX: {
            uidvalidity: 100,
            messages: [1, 2, 3].map(n => ({ raw: message(n), uid: n, flags: n === 1 ? ['\\Seen'] : [], internaldate: '14-Sep-2013 21:22:28 -0300' }))
        },
        '': {
            folders: {
                Archive: {
                    uidvalidity: 200,
                    messages: [{ raw: message(10), uid: 5 }]
                },
                Parent: {
                    flags: ['\\Noselect'],
                    folders: {
                        Child: {}
                    }
                }
            }
        }
    };
}

// asserts that fn throws an ImapKitError with the code
const throwsCode = (fn: () => unknown, code: string) =>
    assert.throws(fn, (err: unknown) => {
        assert.ok(err instanceof ImapKitError, 'not an ImapKitError: ' + err);
        assert.strictEqual(err.code, code, err.message);
        return true;
    });

// waits for the next event of a type that matches
const nextEvent = (emitter: NodeJS.EventEmitter, name: string, match: (event: any) => boolean = () => true) =>
    new Promise<any>(resolve => {
        const listener = (event: any) => {
            if (match(event)) {
                emitter.removeListener(name, listener);
                resolve(event);
            }
        };
        emitter.on(name, listener);
    });

const expect = (session: Session, pattern: RegExp) => new Promise<string>(resolve => session.expect(pattern, resolve));

describe('control API inspection', () => {
    const ctx = setupServer(() => ({ storage: storage() }));
    const open = useSessions(ctx);

    it('lists mailboxes with their status', () => {
        const mailboxes = ctx.server.control.listMailboxes();
        assert.deepStrictEqual(
            mailboxes.map(mailbox => mailbox.path),
            ['Archive', 'INBOX', 'Parent', 'Parent/Child']
        );
        const inbox = ctx.server.control.getMailbox('inbox');
        assert.strictEqual(inbox.path, 'INBOX');
        assert.strictEqual(inbox.messages, 3);
        assert.strictEqual(inbox.unseen, 2);
        assert.strictEqual(inbox.uidnext, 4);
        assert.strictEqual(inbox.uidvalidity, 100);
        assert.strictEqual(inbox.selectable, true);
        assert.strictEqual(inbox.highestModseq, undefined);
        assert.strictEqual(ctx.server.control.getMailbox('Parent').selectable, false);
        throwsCode(() => ctx.server.control.getMailbox('Missing'), 'NONEXISTENT');
    });

    it('lists messages and returns the source on request', () => {
        const messages = ctx.server.control.listMessages('INBOX');
        assert.deepStrictEqual(
            messages.map(entry => [entry.uid, entry.flags, entry.size, entry.raw]),
            [
                [1, ['\\Seen'], message(1).length, undefined],
                [2, [], message(2).length, undefined],
                [3, [], message(3).length, undefined]
            ]
        );
        assert.deepStrictEqual(
            ctx.server.control.listMessages('INBOX', { uids: [3, 2] }).map(entry => entry.uid),
            [2, 3]
        );
        const single = ctx.server.control.getMessage('INBOX', 2);
        assert.strictEqual(single.internaldate, '14-Sep-2013 21:22:28 -0300');
        assert.ok(Buffer.isBuffer(single.raw));
        assert.strictEqual((single.raw as Buffer).toString(), message(2));
        throwsCode(() => ctx.server.control.getMessage('INBOX', 9), 'NONEXISTENT');
        throwsCode(() => ctx.server.control.listMessages('Parent'), 'NONEXISTENT');
        throwsCode(() => ctx.server.control.listMessages('INBOX', { uids: [0] }), 'INVALID');
    });

    it('describes sessions without credentials', async () => {
        await open('INBOX', true);
        const list = ctx.server.control.sessions();
        assert.strictEqual(list.length, 1);
        assert.deepStrictEqual(Object.assign({}, list[0], { session: 0, remoteAddress: null }), {
            session: 0,
            user: 'testuser',
            state: 'Selected',
            mailbox: 'INBOX',
            readOnly: true,
            enabled: [],
            secure: false,
            compressed: false,
            remoteAddress: null
        });
        assert.ok(!JSON.stringify(list).includes('testpass'));
    });
});

describe('control API messages', () => {
    const ctx = setupServer(() => ({ storage: storage(), plugins: ['IDLE', 'CONDSTORE', 'QRESYNC'] }));
    const open = useSessions(ctx);

    it('adds a message that a selected session learns about with EXISTS and \\Recent', async () => {
        const { cmd } = await open('INBOX');
        const added = ctx.server.control.addMessage('INBOX', { raw: 'Subject: héllo\r\n\r\nbody\r\n', flags: ['\\flagged', '$Label'] });
        assert.deepStrictEqual(added, { uid: 4, uidvalidity: 100 });
        const output = await cmd('NOOP');
        assert.match(output, /^\* 4 EXISTS$/m);
        // a unicode string is stored as UTF-8
        assert.strictEqual((ctx.server.control.getMessage('INBOX', 4).raw as Buffer).toString('utf-8'), 'Subject: héllo\r\n\r\nbody\r\n');
        assert.match(await cmd('UID FETCH 4 (FLAGS)'), /^\* 4 FETCH \(FLAGS \(\\Flagged \$Label \\Recent\) UID 4\)$/m);
    });

    it('delivers EXISTS to an idling session right away', async () => {
        const { session } = await open('INBOX');
        const idling = nextEvent(ctx.server, 'session', event => event.type === 'waiting' && event.command === 'IDLE');
        session.raw('I1 IDLE\r\n');
        await idling;
        const exists = expect(session, /^\* 4 EXISTS/);
        ctx.server.control.addMessage('INBOX', { raw: Buffer.from(message(4)), internaldate: new Date(Date.UTC(2020, 0, 2, 3, 4, 5)) });
        assert.match(await exists, /^\* 4 EXISTS$/m);
        // the command event of IDLE comes with its tagged response, after DONE
        const completed = nextEvent(ctx.server, 'command', event => event.command === 'IDLE');
        session.raw('DONE\r\n');
        await expect(session, /^I1 OK/);
        assert.strictEqual((await completed).status, 'OK');
    });

    it('checks the new message', () => {
        throwsCode(() => ctx.server.control.addMessage('Missing', { raw: 'x' }), 'NONEXISTENT');
        throwsCode(() => ctx.server.control.addMessage('Parent', { raw: 'x' }), 'NONEXISTENT');
        throwsCode(() => ctx.server.control.addMessage('INBOX', { raw: '' }), 'INVALID');
        throwsCode(() => ctx.server.control.addMessage('INBOX', { raw: 5 as unknown as string }), 'INVALID');
        throwsCode(() => ctx.server.control.addMessage('INBOX', { raw: 'x', flags: ['\\Recent'] }), 'INVALID');
        throwsCode(() => ctx.server.control.addMessage('INBOX', { raw: 'x', flags: ['bad flag'] }), 'INVALID');
        throwsCode(() => ctx.server.control.addMessage('INBOX', { raw: 'x', internaldate: '2020-01-01' }), 'INVALID');
        throwsCode(() => ctx.server.control.addMessage('INBOX', { raw: 'x', internaldate: new Date('nope') }), 'INVALID');
        assert.strictEqual(ctx.server.control.getMailbox('INBOX').messages, 3);
    });

    it('changes flags, sessions get FETCH with UID and, after ENABLE CONDSTORE, MODSEQ', async () => {
        const plain = await open('INBOX');
        const condstore = await open();
        await condstore.cmd('ENABLE CONDSTORE');
        await condstore.cmd('SELECT INBOX');
        const modseq = ctx.server.control.getMessage('INBOX', 2).modseq as number;

        assert.deepStrictEqual(ctx.server.control.setFlags('INBOX', [2], ['\\Answered', 'Custom'], 'add'), [{ uid: 2, flags: ['\\Answered', 'Custom'] }]);
        assert.ok((ctx.server.control.getMessage('INBOX', 2).modseq as number) > modseq);
        assert.match(await plain.cmd('NOOP'), /^\* 2 FETCH \(UID 2 FLAGS \(\\Answered Custom\)\)$/m);
        assert.match(await condstore.cmd('NOOP'), /^\* 2 FETCH \(UID 2 FLAGS \(\\Answered Custom\) MODSEQ \(\d+\)\)$/m);

        ctx.server.control.setFlags('INBOX', [1, 2], ['\\Answered'], 'remove');
        assert.deepStrictEqual(
            ctx.server.control.listMessages('INBOX').map(entry => entry.flags),
            [['\\Seen'], ['Custom'], []]
        );
        ctx.server.control.setFlags('INBOX', [3], ['\\Deleted']);
        assert.deepStrictEqual(ctx.server.control.getMessage('INBOX', 3).flags, ['\\Deleted']);
        // a message whose flags did not change is not reported
        const output = await plain.cmd('NOOP');
        assert.doesNotMatch(output, /^\* 1 FETCH/m);
        assert.match(output, /^\* 2 FETCH \(UID 2 FLAGS \(Custom\)\)$/m);
        assert.match(output, /^\* 3 FETCH \(UID 3 FLAGS \(\\Deleted\)\)$/m);
    });

    it('refuses invalid flag changes', () => {
        throwsCode(() => ctx.server.control.setFlags('INBOX', [9], ['\\Seen']), 'NONEXISTENT');
        throwsCode(() => ctx.server.control.setFlags('INBOX', [1], ['\\Recent']), 'INVALID');
        throwsCode(() => ctx.server.control.setFlags('INBOX', [1], ['\\Unknown']), 'INVALID');
        throwsCode(() => ctx.server.control.setFlags('INBOX', [1], 'Seen' as unknown as string[]), 'INVALID');
        throwsCode(() => ctx.server.control.setFlags('INBOX', [1], ['\\Seen'], 'toggle' as 'set'), 'INVALID');
        throwsCode(() => ctx.server.control.setFlags('INBOX', '1' as unknown as number[], ['\\Seen']), 'INVALID');
    });

    it('expunges messages, sessions get EXPUNGE or, after ENABLE QRESYNC, VANISHED', async () => {
        const plain = await open('INBOX');
        const qresync = await open();
        await qresync.cmd('ENABLE QRESYNC');
        await qresync.cmd('SELECT INBOX');
        const highest = ctx.server.control.getMailbox('INBOX').highestModseq as number;

        assert.deepStrictEqual(ctx.server.control.expungeMessages('INBOX', [3, 1]), [1, 3]);
        assert.deepStrictEqual(
            ctx.server.control.listMessages('INBOX').map(entry => entry.uid),
            [2]
        );
        assert.ok((ctx.server.control.getMailbox('INBOX').highestModseq as number) > highest);
        const output = await plain.cmd('NOOP');
        assert.match(output, /^\* 1 EXPUNGE\r\n\* 2 EXPUNGE\r\n/m);
        assert.match(output, /^\* 1 EXISTS$/m);
        assert.match(await qresync.cmd('NOOP'), /^\* VANISHED 1,3$/m);
        assert.match(await qresync.cmd(`SELECT INBOX (QRESYNC (100 ${highest}))`), /^\* VANISHED \(EARLIER\) 1,3$/m);
    });

    it('copies and moves messages', async () => {
        const archive = await open('Archive');
        const inbox = await open('INBOX');
        assert.deepStrictEqual(ctx.server.control.copyMessages('INBOX', [2, 1], 'Archive'), {
            uidvalidity: 200,
            uids: [
                { uid: 1, targetUid: 6 },
                { uid: 2, targetUid: 7 }
            ]
        });
        assert.deepStrictEqual(ctx.server.control.moveMessages('INBOX', [3], 'Archive'), { uidvalidity: 200, uids: [{ uid: 3, targetUid: 8 }] });
        assert.deepStrictEqual(ctx.server.control.getMessage('Archive', 6).flags, ['\\Seen']);
        assert.match(await archive.cmd('NOOP'), /^\* 4 EXISTS$/m);
        assert.match(await inbox.cmd('NOOP'), /^\* 3 EXPUNGE$/m);
        throwsCode(() => ctx.server.control.copyMessages('INBOX', [1], 'Missing'), 'NONEXISTENT');
    });

    it('replaces a message with a new UID', () => {
        assert.deepStrictEqual(ctx.server.control.replaceMessage('INBOX', 1, { raw: message(9) }), { uid: 4, uidvalidity: 100 });
        assert.deepStrictEqual(
            ctx.server.control.listMessages('INBOX').map(entry => [entry.uid, entry.flags, entry.internaldate]),
            [
                [2, [], '14-Sep-2013 21:22:28 -0300'],
                [3, [], '14-Sep-2013 21:22:28 -0300'],
                [4, ['\\Seen'], '14-Sep-2013 21:22:28 -0300']
            ]
        );
    });
});

describe('control API UIDVALIDITY reset', () => {
    const ctx = setupServer(() => ({ storage: storage(), plugins: ['CONDSTORE', 'QRESYNC'] }));
    const open = useSessions(ctx);

    const subjects = () =>
        ctx.server.control.listMessages('INBOX', { raw: true }).map(entry => [entry.uid, (entry.raw as Buffer).toString().match(/Subject: (.*)/)?.[1]]);

    it('keeps the UIDs under a new UIDVALIDITY and disconnects selected sessions', async () => {
        const { session } = await open('INBOX');
        const closed = new Promise<string>(resolve => session.whenClosed(resolve));
        const result = ctx.server.control.resetUidValidity('INBOX');
        assert.deepStrictEqual(result, {
            uidvalidity: 201,
            uidnext: 4,
            uids: [
                { uid: 1, newUid: 1 },
                { uid: 2, newUid: 2 },
                { uid: 3, newUid: 3 }
            ]
        });
        assert.match(await closed, /^\* BYE UIDVALIDITY of the selected mailbox changed\r\n$/m);
        assert.strictEqual(ctx.server.control.getMailbox('INBOX').uidvalidity, 201);
        // a mailbox created later gets a higher value still
        assert.strictEqual(ctx.server.control.createMailbox('Later').uidvalidity, 202);
        assert.strictEqual(ctx.server.control.getMailbox('INBOX').messages, 3);
    });

    it('renumbers the UIDs from 1', () => {
        ctx.server.control.expungeMessages('INBOX', [1]);
        const result = ctx.server.control.resetUidValidity('INBOX', { uids: 'renumber', uidvalidity: 500 });
        assert.strictEqual(result.uidvalidity, 500);
        assert.strictEqual(result.uidnext, 3);
        assert.deepStrictEqual(subjects(), [
            [1, 'message 2'],
            [2, 'message 3']
        ]);
    });

    it('shuffles the UIDs in a repeatable order', () => {
        const first = ctx.server.control.resetUidValidity('INBOX', { uids: 'shuffle', seed: 7 });
        assert.deepStrictEqual(first.uids.map(entry => entry.newUid).sort(), [1, 2, 3]);
        const other = imapkit({ storage: storage() });
        assert.deepStrictEqual(other.control.resetUidValidity('INBOX', { uids: 'shuffle', seed: 7 }).uids, first.uids);
        // the messages stay ordered by UID
        assert.deepStrictEqual(
            ctx.server.control.listMessages('INBOX').map(entry => entry.uid),
            [1, 2, 3]
        );
        const moved = first.uids.find(entry => entry.uid !== entry.newUid);
        assert.ok(moved, 'seed 7 moves a message');
        assert.strictEqual(subjects().find(([uid]) => uid === moved.newUid)?.[1], 'message ' + moved.uid);
    });

    it('moves the UIDs above the old UIDNEXT', async () => {
        const result = ctx.server.control.resetUidValidity('INBOX', { uids: 'offset', offset: 10 });
        assert.deepStrictEqual(
            result.uids.map(entry => entry.newUid),
            [14, 15, 16]
        );
        assert.strictEqual(result.uidnext, 17);
        const { cmd } = await open();
        await cmd('ENABLE QRESYNC');
        // the client's state is for the old UIDVALIDITY: no VANISHED, a new UIDVALIDITY, and nothing under the old UIDs
        const output = await cmd('SELECT INBOX (QRESYNC (100 1))');
        assert.match(output, /^\* OK \[UIDVALIDITY 201\]/m);
        assert.doesNotMatch(output, /VANISHED/);
        assert.doesNotMatch(await cmd('UID FETCH 1:3 (FLAGS)'), /^\* \d+ FETCH/m);
        assert.match(await cmd('UID FETCH 14 (FLAGS)'), /^\* 1 FETCH/m);
    });

    it('refuses invalid options', () => {
        throwsCode(() => ctx.server.control.resetUidValidity('INBOX', { uidvalidity: 100 }), 'INVALID');
        throwsCode(() => ctx.server.control.resetUidValidity('INBOX', { uidvalidity: 2 ** 32 }), 'INVALID');
        throwsCode(() => ctx.server.control.resetUidValidity('INBOX', { uids: 'random' as 'keep' }), 'INVALID');
        throwsCode(() => ctx.server.control.resetUidValidity('INBOX', { uids: 'offset', offset: -1 }), 'INVALID');
        throwsCode(() => ctx.server.control.resetUidValidity('INBOX', { uids: 'shuffle', seed: 1.5 }), 'INVALID');
        throwsCode(() => ctx.server.control.resetUidValidity('Parent'), 'NONEXISTENT');
        assert.strictEqual(ctx.server.control.getMailbox('INBOX').uidvalidity, 100);
    });
});

describe('control API with CONTEXT=SEARCH and NOTIFY', () => {
    const ctx = setupServer(() => ({ storage: storage(), plugins: ['ESEARCH', 'CONTEXT=SEARCH', 'NOTIFY'] }));
    const open = useSessions(ctx);

    it('updates a search context', async () => {
        const { cmd } = await open('INBOX');
        assert.match(await cmd('SEARCH RETURN (UPDATE) UNSEEN'), /^\* ESEARCH \(TAG "T\d+"\)/m);
        ctx.server.control.setFlags('INBOX', [2], ['\\Seen'], 'add');
        assert.match(await cmd('NOOP'), /^\* ESEARCH \(TAG "T\d+"\) REMOVEFROM \(0 2\)$/m);
    });

    it('reports new messages to a NOTIFY session', async () => {
        const { session, cmd } = await open();
        await cmd('NOTIFY SET (mailboxes INBOX (MessageNew MessageExpunge))');
        const status = expect(session, /^\* STATUS/);
        ctx.server.control.addMessage('INBOX', { raw: message(4) });
        assert.match(await status, /^\* STATUS INBOX \(MESSAGES 4 UIDNEXT 5\)$/m);
    });
});

describe('control API mailboxes', () => {
    const ctx = setupServer(() => ({ storage: storage() }));
    const open = useSessions(ctx);

    it('creates, renames and deletes mailboxes', async () => {
        const events: any[] = [];
        ctx.server.on('mailbox', event => events.push(event));
        const { cmd } = await open();

        const created = ctx.server.control.createMailbox('New/Sub', { subscribed: true });
        assert.strictEqual(created.path, 'New/Sub');
        assert.strictEqual(created.subscribed, true);
        assert.ok(created.uidvalidity > 200);
        assert.match(await cmd('LSUB "" "New/*"'), /^\* LSUB \([^)]*\) "\/" "New\/Sub"$/m);
        throwsCode(() => ctx.server.control.createMailbox('New/Sub'), 'ALREADYEXISTS');
        throwsCode(() => ctx.server.control.createMailbox('Bad\u00e9'), 'INVALID');
        throwsCode(() => ctx.server.control.createMailbox(''), 'INVALID');

        assert.strictEqual(ctx.server.control.renameMailbox('New/Sub', 'Renamed').path, 'Renamed');
        throwsCode(() => ctx.server.control.renameMailbox('Renamed', 'Archive'), 'ALREADYEXISTS');
        throwsCode(() => ctx.server.control.renameMailbox('Missing', 'Other'), 'NONEXISTENT');

        ctx.server.control.deleteMailbox('Renamed');
        throwsCode(() => ctx.server.control.deleteMailbox('Renamed'), 'NONEXISTENT');
        throwsCode(() => ctx.server.control.deleteMailbox('INBOX'), 'CANNOT');
        assert.doesNotMatch(await cmd('LIST "" "*"'), /Renamed/);

        assert.deepStrictEqual(
            events.map(event => [event.type, event.path, event.origin]),
            [
                ['create', 'New/Sub', null],
                ['subscribe', 'New/Sub', null],
                ['rename', 'Renamed', null],
                ['delete', 'Renamed', null]
            ]
        );
    });

    it('renames INBOX by moving its messages', async () => {
        const { cmd } = await open('INBOX');
        ctx.server.control.renameMailbox('INBOX', 'Old');
        assert.strictEqual(ctx.server.control.getMailbox('INBOX').messages, 0);
        assert.strictEqual(ctx.server.control.getMailbox('Old').messages, 3);
        assert.match(await cmd('NOOP'), /^\* 0 EXISTS$/m);
    });

    it('disconnects the sessions that have a deleted mailbox selected', async () => {
        const { session } = await open('Archive');
        const closed = new Promise<string>(resolve => session.whenClosed(resolve));
        ctx.server.control.deleteMailbox('Archive');
        assert.match(await closed, /^\* BYE /m);
    });

    it('subscribes and unsubscribes', () => {
        assert.strictEqual(ctx.server.control.unsubscribe('Archive'), true);
        assert.strictEqual(ctx.server.control.unsubscribe('Archive'), false);
        assert.strictEqual(ctx.server.control.getMailbox('Archive').subscribed, false);
        assert.strictEqual(ctx.server.control.subscribe('Archive'), true);
        assert.strictEqual(ctx.server.control.subscribe('Archive'), false);
        throwsCode(() => ctx.server.control.subscribe('Parent'), 'NONEXISTENT');
        throwsCode(() => ctx.server.control.unsubscribe(''), 'INVALID');
    });
});

describe('control API snapshot', () => {
    it('round-trips the storage through a new server', () => {
        const server = imapkit({ storage: storage(), plugins: ['CONDSTORE'] });
        server.control.addMessage('INBOX', { raw: 'Subject: \u00fcber\r\n\r\n\u00e4\r\n', flags: ['Custom'], internaldate: '01-Jan-2024 10:00:00 +0000' });
        server.control.setFlags('INBOX', [2], ['\\Flagged'], 'add');
        server.control.expungeMessages('INBOX', [1]);
        server.control.createMailbox('Empty');
        server.control.unsubscribe('Archive');

        const snapshot = server.control.snapshot();
        assert.strictEqual(snapshot.INBOX.subscribed, true);
        assert.deepStrictEqual((snapshot[''].folders as any).Parent.flags, ['\\Noselect']);
        assert.strictEqual((snapshot[''].folders as any).Archive.subscribed, false);

        const copy = imapkit({ storage: JSON.parse(JSON.stringify(snapshot)), plugins: ['CONDSTORE'] });
        assert.deepStrictEqual(copy.control.snapshot(), snapshot);
        assert.deepStrictEqual(copy.control.listMailboxes(), server.control.listMailboxes());
        assert.deepStrictEqual(copy.control.listMessages('INBOX', { raw: true }), server.control.listMessages('INBOX', { raw: true }));
        assert.strictEqual((copy.control.getMessage('INBOX', 4).raw as Buffer).toString('utf-8'), 'Subject: \u00fcber\r\n\r\n\u00e4\r\n');
    });
});

describe('control API reset', () => {
    const ctx = setupServer(() => ({ storage: storage() }));
    const open = useSessions(ctx);

    it('restores the storage and users and disconnects every session', async () => {
        const { session } = await open('INBOX');
        const closed = new Promise<string>(resolve => session.whenClosed(resolve));
        const initial = ctx.server.control.snapshot();
        ctx.server.control.addMessage('INBOX', { raw: message(9) });
        ctx.server.control.createMailbox('Extra');
        ctx.server.control.unsubscribe('Archive');
        ctx.server.control.addUser('other', { password: 'x' });

        ctx.server.control.reset();
        assert.match(await closed, /^\* BYE Server reset$/m);
        assert.deepStrictEqual(ctx.server.control.snapshot(), initial);
        assert.deepStrictEqual(
            ctx.server.control.listUsers().map(user => user.name),
            ['testuser']
        );
        // the server keeps working
        const { cmd } = await open('INBOX');
        assert.match(await cmd('FETCH 1:* (UID)'), /^\* 3 FETCH \(UID 3\)$/m);
    });
});

describe('control API users and sessions', () => {
    const ctx = setupServer(() => ({}));
    const open = useSessions(ctx);

    it('adds, updates and deletes users', async () => {
        ctx.server.control.addUser('other', { password: 'secret', xoauth2: { accessToken: 'token' } });
        throwsCode(() => ctx.server.control.addUser('other', { password: 'x' }), 'ALREADYEXISTS');
        throwsCode(() => ctx.server.control.addUser('', { password: 'x' }), 'INVALID');
        throwsCode(() => ctx.server.control.addUser('third', { password: 5 as unknown as string }), 'INVALID');
        throwsCode(() => ctx.server.control.updateUser('missing', { password: 'x' }), 'NONEXISTENT');
        assert.deepStrictEqual(ctx.server.control.listUsers(), [
            { name: 'other', xoauth2: true },
            { name: 'testuser', xoauth2: true }
        ]);
        ctx.server.control.updateUser('other', { password: 'changed', xoauth2: null as unknown as undefined });
        assert.deepStrictEqual(ctx.server.control.listUsers()[0], { name: 'other', xoauth2: false });
        assert.ok(!JSON.stringify(ctx.server.control.listUsers()).includes('changed'));

        const session = await new Promise<Session>(resolve => openSession(ctx.port, resolve));
        const login = await new Promise<string>(resolve => session.run('L1 LOGIN other changed', resolve));
        assert.match(login, /^L1 OK/m);
        const closed = new Promise<string>(resolve => session.whenClosed(resolve));
        ctx.server.control.deleteUser('other');
        assert.match(await closed, /^\* BYE /m);
        throwsCode(() => ctx.server.control.deleteUser('other'), 'NONEXISTENT');
        assert.deepStrictEqual(
            ctx.server.control.listUsers().map(user => user.name),
            ['testuser']
        );
    });

    it('disconnects sessions with BYE or a reset', async () => {
        const first = await open();
        const second = await open();
        const firstClosed = new Promise<string>(resolve => first.session.whenClosed(resolve));
        const number = ctx.server.control.sessions()[0].session;
        assert.strictEqual(ctx.server.control.disconnect(number, { text: 'Go away' }), 1);
        assert.match(await firstClosed, /^\* BYE Go away\r\n$/m);
        const secondClosed = new Promise<string>(resolve => second.session.whenClosed(resolve));
        assert.strictEqual(ctx.server.control.disconnect({ user: 'testuser' }, { reset: true }), 1);
        assert.doesNotMatch(await secondClosed, /BYE/);
        assert.strictEqual(ctx.server.control.disconnect({ user: 'nobody' }), 0);
        throwsCode(() => ctx.server.control.disconnect({}), 'INVALID');
    });

    it('injects output into a session', async () => {
        const { session } = await open();
        const alert = expect(session, /^\* OK \[ALERT\]/);
        ctx.server.control.inject(ctx.server.control.sessions()[0].session, '* OK [ALERT] Maintenance soon\r\n');
        assert.match(await alert, /^\* OK \[ALERT\] Maintenance soon$/m);
        throwsCode(() => ctx.server.control.inject(9999, 'x'), 'NONEXISTENT');
        throwsCode(() => ctx.server.control.inject(ctx.server.control.sessions()[0].session, 5 as unknown as string), 'INVALID');
    });

    it('emits session and command events', async () => {
        const events: string[] = [];
        ctx.server.on('session', event => events.push(event.type + ' ' + (event.session.mailbox || '-')));
        ctx.server.on('command', event => events.push(event.command + ' ' + event.status));
        const { cmd, session } = await open('INBOX');
        await cmd('EXAMINE INBOX');
        await cmd('CLOSE');
        await cmd('FETCH 1 FLAGS');
        const closing = nextEvent(ctx.server, 'session', event => event.type === 'close');
        session.close();
        await closing;
        assert.deepStrictEqual(events, [
            'open -',
            'LOGIN OK',
            'login -',
            'select INBOX',
            'SELECT OK',
            'select INBOX',
            'EXAMINE OK',
            'CLOSE OK',
            'unselect -',
            'FETCH BAD',
            'close -'
        ]);
    });
});

describe('now option', () => {
    const fixed = new Date(Date.UTC(2024, 0, 2, 3, 4, 5));
    const ctx = setupServer(() => ({ now: fixed, plugins: ['SAVEDATE'] }));
    const open = useSessions(ctx);

    it('fixes the dates the server sets', async () => {
        const expected = ctx.server.formatInternalDate(fixed);
        ctx.server.control.addMessage('INBOX', { raw: message(1) });
        const { cmd } = await open();
        assert.match(await cmd('APPEND INBOX {10}\r\nSubject: 2'), /^T\d+ OK/m);
        const messages = ctx.server.control.listMessages('INBOX');
        assert.deepStrictEqual(
            messages.map(entry => entry.internaldate),
            [expected, expected]
        );
        assert.strictEqual(ctx.server.getMailbox('INBOX')!.messages[0].SAVEDATE, expected);
        assert.strictEqual(ctx.server.now().getTime(), fixed.getTime());
    });

    it('takes a function or a timestamp', () => {
        let tick = 0;
        const server = imapkit({ now: () => Date.UTC(2024, 0, 1) + ++tick * 1000 });
        assert.strictEqual(server.now().getTime(), Date.UTC(2024, 0, 1) + 1000);
        assert.strictEqual(server.now().getTime(), Date.UTC(2024, 0, 1) + 2000);
        assert.strictEqual(imapkit({ now: 5000 }).now().getTime(), 5000);
        const before = Date.now();
        assert.ok(imapkit().now().getTime() >= before);
    });
});

describe('server lifecycle', () => {
    it('starts and stops with promises', async () => {
        const server = imapkit();
        const port = await server.start(0, '127.0.0.1');
        assert.ok(port > 0);
        const session = await new Promise<Session>(resolve => openSession(port, resolve));
        const closed = new Promise<string>(resolve => session.whenClosed(resolve));
        await server.stop();
        await closed;
        assert.strictEqual(server.server.listening, false);
        // a second stop does not fail
        await server.stop();
    });

    it('rejects start when the port is taken', async () => {
        const first = imapkit();
        const port = await first.start();
        const second = imapkit();
        await assert.rejects(second.start(port), /EADDRINUSE/);
        await first.stop();
    });

    it('shuts down gracefully after the last client', async () => {
        const server = imapkit();
        const port = await server.start();
        const session = await new Promise<Session>(resolve => openSession(port, resolve));
        let done = false;
        const shutdown = server.control.shutdown().then(() => {
            done = true;
        });
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.strictEqual(done, false);
        assert.strictEqual(server.server.listening, false);
        session.close();
        await shutdown;
        assert.strictEqual(done, true);
    });
});
