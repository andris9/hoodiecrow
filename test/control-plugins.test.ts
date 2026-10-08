// Control API operations of plugins (ACL, QUOTA, METADATA), registered with server.control.register(), and what the
// shared mailbox operations do to plugin data: the control API deletes, renames and creates mailboxes like the
// IMAP commands do (RFC 4314 section 4, RFC 5464 section 4.1).

import { describe, it } from 'node:test';
import assert from 'node:assert';
import imapkit from '../src/server.js';
import { ImapKitError } from '../src/control.js';
import { setupServer } from './helpers/index.js';
import { useSessions } from './helpers/session.js';
import type { AddressInfo } from 'node:net';

const throwsCode = (fn: () => unknown, code: string) =>
    assert.throws(fn, (err: unknown) => {
        assert.ok(err instanceof ImapKitError, 'not an ImapKitError: ' + err);
        assert.strictEqual(err.code, code, err.message);
        return true;
    });

function storage() {
    return {
        INBOX: { messages: [{ raw: 'Subject: one\r\n\r\nBody\r\n', uid: 1 }] },
        '': {
            folders: {
                Shared: { acl: { other: 'lr' }, metadata: { '/shared/comment': 'shared mailbox' }, folders: { Child: {} } }
            }
        }
    };
}

describe('control API: ACL', () => {
    const ctx = setupServer(() => ({ storage: storage(), plugins: ['ACL'] }));

    it('reads and changes ACLs', () => {
        assert.deepStrictEqual(ctx.server.control.getAcl('Shared'), { other: 'lr' });
        assert.deepStrictEqual(ctx.server.control.setAcl('Shared', 'other', '+wi'), { other: 'lrwi' });
        assert.deepStrictEqual(ctx.server.control.setAcl('Shared', 'other', '-l'), { other: 'rwi' });
        assert.deepStrictEqual(ctx.server.control.setAcl('Shared', 'anyone', 'l'), { other: 'rwi', anyone: 'l' });
        assert.deepStrictEqual(ctx.server.control.deleteAcl('Shared', 'anyone'), { other: 'rwi' });
        assert.deepStrictEqual(ctx.server.control.setAcl('Shared', 'other', ''), {});
        throwsCode(() => ctx.server.control.deleteAcl('Shared', 'other'), 'NONEXISTENT');
        throwsCode(() => ctx.server.control.setAcl('Shared', 'other', 'Q'), 'INVALID');
        throwsCode(() => ctx.server.control.setAcl('Shared', '', 'l'), 'INVALID');
        throwsCode(() => ctx.server.control.getAcl('Missing'), 'NONEXISTENT');
    });

    it('applies ACL changes to sessions and emits the acl event', async () => {
        const events: string[] = [];
        ctx.server.on('acl', mailbox => events.push(mailbox.path));
        ctx.server.control.setAcl('Shared', 'other', 'lrs');
        assert.deepStrictEqual(events, ['Shared']);
        ctx.server.control.addUser('other', { password: 'pass' });
        const open = await new Promise<string>(resolve => {
            import('../src/mock-client.js').then(({ default: mockClient }) =>
                mockClient((ctx.server.address() as AddressInfo).port, 'localhost', ['A1 LOGIN other pass', 'A2 MYRIGHTS Shared', 'A3 LOGOUT'], false, resp =>
                    resolve(resp.toString())
                )
            );
        });
        assert.match(open, /^\* MYRIGHTS Shared lrs$/m);
    });

    it('keeps ACLs in the snapshot', () => {
        ctx.server.control.setAcl('Shared', 'anyone', 'lr');
        const snapshot = ctx.server.control.snapshot();
        assert.deepStrictEqual((snapshot[''].folders as any).Shared.acl, { other: 'lr', anyone: 'lr' });
        const copy = imapkit({ storage: snapshot, plugins: ['ACL'] });
        assert.deepStrictEqual(copy.control.getAcl('Shared'), { other: 'lr', anyone: 'lr' });
    });

    it('deletes the ACL with the mailbox and inherits it on create', () => {
        // the mailbox has a child, so a \Noselect placeholder stays, without the ACL (RFC 4314 section 4)
        ctx.server.control.deleteMailbox('Shared');
        assert.deepStrictEqual(ctx.server.control.getAcl('Shared'), {});
        ctx.server.control.setAcl('Shared/Child', 'other', 'lr');
        // a new mailbox and its new superior levels get the ACL of their parent (RFC 4314 section 4, SHOULD)
        ctx.server.control.createMailbox('Shared/Child/Deep/Er');
        assert.deepStrictEqual(ctx.server.control.getAcl('Shared/Child/Deep'), { other: 'lr' });
        assert.deepStrictEqual(ctx.server.control.getAcl('Shared/Child/Deep/Er'), { other: 'lr' });
    });
});

describe('control API: QUOTA', () => {
    const ctx = setupServer(() => ({ storage: storage(), plugins: ['QUOTA'], quota: { MESSAGE: 10 } }));
    const open = useSessions(ctx);

    it('reads and replaces the limits', async () => {
        assert.deepStrictEqual(ctx.server.control.getQuota(), { root: 'User quota', limits: { MESSAGE: 10 }, usage: { STORAGE: 1, MESSAGE: 1, MAILBOX: 3 } });
        assert.deepStrictEqual(ctx.server.control.setQuota({ storage: 5, MAILBOX: 4 }).limits, { STORAGE: 5, MAILBOX: 4 });
        throwsCode(() => ctx.server.control.setQuota({ FILES: 1 }), 'INVALID');
        throwsCode(() => ctx.server.control.setQuota({ STORAGE: -1 }), 'INVALID');
        throwsCode(() => ctx.server.control.setQuota([]), 'INVALID');
        const { cmd } = await open();
        assert.match(await cmd('GETQUOTA "User quota"'), /^\* QUOTA "User quota" \(STORAGE 1 5 MAILBOX 3 4\)$/m);
        ctx.server.control.reset();
        assert.deepStrictEqual(ctx.server.control.getQuota().limits, { MESSAGE: 10 });
    });

    it('refuses a message over the quota when asked to check it like APPEND', () => {
        ctx.server.control.setQuota({ MESSAGE: 1 });
        throwsCode(() => ctx.server.control.addMessage('INBOX', { raw: 'Subject: x\r\n\r\nx\r\n' }, { checks: true }), 'OVERQUOTA');
        assert.strictEqual(ctx.server.control.getMailbox('INBOX').messages, 1);
        // the operator can still go over the limit
        assert.strictEqual(ctx.server.control.addMessage('INBOX', { raw: 'Subject: x\r\n\r\nx\r\n' }).uid, 2);
    });
});

describe('control API: METADATA', () => {
    const ctx = setupServer(() => ({ storage: storage(), plugins: ['ENABLE', 'METADATA'] }));
    const open = useSessions(ctx);

    it('sets annotations, sessions after ENABLE METADATA get unsolicited METADATA', async () => {
        const { cmd } = await open();
        await cmd('ENABLE METADATA');
        assert.deepStrictEqual(ctx.server.control.setMetadata('Shared', { '/shared/comment': 'kommentaar ü', '/private/x': 'y' }), {
            '/shared/comment': 'kommentaar ü',
            '/private/x': 'y'
        });
        assert.match(await cmd('NOOP'), /^\* METADATA Shared \/shared\/comment \/private\/x$/m);
        assert.deepStrictEqual(ctx.server.control.setMetadata('Shared', { '/private/x': null }), { '/shared/comment': 'kommentaar ü' });
        ctx.server.control.setMetadata('', { '/shared/admin': 'mailto:admin@example.com' });
        assert.deepStrictEqual(ctx.server.control.getMetadata(''), { '/shared/admin': 'mailto:admin@example.com' });
        ctx.server.control.reset();
        assert.deepStrictEqual(ctx.server.control.getMetadata(''), {});
        assert.deepStrictEqual(ctx.server.control.getMetadata('Shared'), { '/shared/comment': 'shared mailbox' });
        throwsCode(() => ctx.server.control.setMetadata('Shared', { 'no-slash': 'x' }), 'INVALID');
        throwsCode(() => ctx.server.control.setMetadata('Shared', { '/shared/x': 5 }), 'INVALID');
        throwsCode(() => ctx.server.control.setMetadata('', { '/shared/vendor/imapkit/x': 'x', '/shared/admin': 5 }), 'INVALID');
        throwsCode(() => ctx.server.control.setMetadata('Shared', 'x'), 'INVALID');
        throwsCode(() => ctx.server.control.getMetadata('Missing'), 'NONEXISTENT');
    });

    it('drops annotations with a deleted mailbox and copies them on RENAME INBOX', () => {
        ctx.server.control.deleteMailbox('Shared');
        assert.deepStrictEqual(ctx.server.control.getMetadata('Shared'), {});
        ctx.server.control.setMetadata('INBOX', { '/shared/comment': 'inbox' });
        ctx.server.control.renameMailbox('INBOX', 'Old');
        assert.deepStrictEqual(ctx.server.control.getMetadata('Old'), { '/shared/comment': 'inbox' });
        assert.deepStrictEqual(ctx.server.control.getMetadata('INBOX'), { '/shared/comment': 'inbox' });
    });

    it('has server annotations only with METADATA-SERVER', () => {
        const server = imapkit({ plugins: ['METADATA-SERVER'] });
        assert.deepStrictEqual(server.control.getMetadata(''), {});
        throwsCode(() => server.control.getMetadata('INBOX'), 'INVALID');
    });
});

describe('control API: SPECIAL-USE and OBJECTID', () => {
    const ctx = setupServer(() => ({ storage: storage(), plugins: ['SPECIAL-USE', 'OBJECTID'] }));
    const open = useSessions(ctx);

    it('sets special-use attributes, LIST shows them', async () => {
        assert.deepStrictEqual(ctx.server.control.getMailbox('Shared').specialUse, []);
        assert.deepStrictEqual(ctx.server.control.setSpecialUse('Shared', ['\\Archive', '\\Archive']).specialUse, ['\\Archive']);
        throwsCode(() => ctx.server.control.setSpecialUse('Shared', ['\\Nope']), 'INVALID');
        throwsCode(() => ctx.server.control.setSpecialUse('Shared', '\\Sent'), 'INVALID');
        throwsCode(() => ctx.server.control.setSpecialUse('Missing', []), 'NONEXISTENT');
        const { cmd } = await open();
        assert.match(await cmd('LIST "" Shared'), /^\* LIST \([^)]*\\Archive[^)]*\) "\/" "Shared"$/m);
    });

    it('reports object ids', () => {
        const mailbox = ctx.server.control.getMailbox('INBOX');
        assert.match(mailbox.mailboxId as string, /^F\d+$/);
        const message = ctx.server.control.getMessage('INBOX', 1);
        assert.match(message.emailId as string, /^M\d+$/);
        assert.match(message.threadId as string, /^T\d+$/);
        // a \Noselect name has no MAILBOXID
        ctx.server.control.deleteMailbox('Shared');
        assert.strictEqual(ctx.server.control.getMailbox('Shared').mailboxId, undefined);
    });
});

describe('control API plugin operations over REST', () => {
    it('serves the routes of loaded plugins only', async () => {
        const server = imapkit({ storage: storage(), plugins: ['ACL', 'QUOTA', 'METADATA'], rest: { port: 0 } });
        await server.start();
        try {
            await checkRoutes(server);
        } finally {
            await server.stop();
        }

        // no trace of plugins that are not loaded
        const plain = imapkit({ rest: { port: 0 } });
        await plain.start();
        try {
            assert.strictEqual(plain.control.setAcl, undefined);
            const plainBase = 'http://127.0.0.1:' + (plain.restServer!.address() as AddressInfo).port;
            assert.strictEqual((await fetch(plainBase + '/v1/quota')).status, 404);
        } finally {
            await plain.stop();
        }
    });

    async function checkRoutes(server: ReturnType<typeof imapkit>) {
        const base = 'http://127.0.0.1:' + (server.restServer!.address() as AddressInfo).port;
        const json = { 'Content-Type': 'application/json' };
        assert.deepStrictEqual(await (await fetch(base + '/v1/mailboxes/Shared/acl')).json(), { other: 'lr' });
        const put = await fetch(base + '/v1/mailboxes/Shared/acl/anyone', { method: 'PUT', headers: json, body: JSON.stringify({ rights: 'l' }) });
        assert.deepStrictEqual(await put.json(), { other: 'lr', anyone: 'l' });
        assert.strictEqual((await fetch(base + '/v1/mailboxes/Shared/acl/nobody', { method: 'DELETE' })).status, 404);
        assert.strictEqual((await fetch(base + '/v1/mailboxes/Shared/acl/anyone', { method: 'DELETE' })).status, 200);
        assert.strictEqual(((await (await fetch(base + '/v1/quota')).json()) as any).root, 'User quota');
        const quota = await fetch(base + '/v1/quota', { method: 'PUT', headers: json, body: JSON.stringify({ MESSAGE: 3 }) });
        assert.deepStrictEqual(((await quota.json()) as any).limits, { MESSAGE: 3 });
        const meta = await fetch(base + '/v1/mailboxes/Shared/metadata', { method: 'PUT', headers: json, body: JSON.stringify({ '/shared/a': 'b' }) });
        assert.strictEqual(((await meta.json()) as any)['/shared/a'], 'b');
        assert.deepStrictEqual(
            await (await fetch(base + '/v1/metadata', { method: 'PUT', headers: json, body: JSON.stringify({ '/shared/c': 'd' }) })).json(),
            {
                '/shared/c': 'd'
            }
        );
        assert.deepStrictEqual(await (await fetch(base + '/v1/metadata')).json(), { '/shared/c': 'd' });
        assert.strictEqual(((await (await fetch(base + '/v1/mailboxes/Shared/metadata')).json()) as any)['/shared/a'], 'b');
        const doc = (await (await fetch(base + '/v1/openapi.json')).json()) as any;
        assert.ok(doc.paths['/v1/quota'].put);
        assert.strictEqual(doc.paths['/v1/mailboxes/{path}/special-use'], undefined);
    }

    it('refuses to register an operation twice', () => {
        const server = imapkit({ plugins: ['QUOTA'] });
        assert.throws(() => server.control.register('getQuota', () => 1), /exists already/);
        assert.throws(() => server.control.register('snapshot', () => 1), /exists already/);
    });
});
