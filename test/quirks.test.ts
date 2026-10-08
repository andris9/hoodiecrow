// Quirk presets (#87): named sets of script rules that make the server behave like a known real server.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import imapkit, { quirks } from '../src/index.js';
import { setupServer } from './helpers/index.js';
import { connectRaw } from './helpers/raw-client.js';

const raw =
    'Content-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nhello\r\n--x\r\nContent-Type: text/plain\r\n\r\n' +
    'a long second part that has more than one hundred octets, so it stays a literal even with the yahoo quirk on\r\n--x--\r\n';

const storage = () => ({ INBOX: { messages: [{ raw, uid: 1 }] } });

const run = (ctx: ReturnType<typeof setupServer>, commands: string[]) =>
    new Promise<string>(resolve =>
        ctx.run(['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', ...commands, 'ZZ LOGOUT'], resp => resolve(resp.toString('binary')))
    );

describe('quirks', () => {
    it('refuses unknown quirks', () => {
        assert.throws(() => imapkit({ quirks: ['nope'] }), /Unknown quirk "nope". Available quirks: james-fetchgroup/);
    });

    it('refuse to remove a plugin that another listed plugin requires', () => {
        // RFC 9051 Appendix E: IMAP4rev2 folds in UIDPLUS and MOVE (sections 6.3.12, 6.4.7, 6.4.8 and 6.4.9), so a
        // server that advertises IMAP4rev2 can not leave them out
        assert.throws(() => imapkit({ plugins: ['IMAP4rev2'], quirks: ['no-move'] }), /^Error: IMAP4rev2 requires MOVE, which the "no-move" quirk removes$/);
        assert.throws(
            () => imapkit({ plugins: ['IDLE', 'imap4rev2'], quirks: ['no-uidplus'] }),
            /^Error: imap4rev2 requires UIDPLUS, which the "no-uidplus" quirk removes$/
        );
        // a plugin the quirk removes only because it is listed is still left out
        assert.strictEqual(imapkit({ plugins: ['MOVE', 'QRESYNC'], quirks: ['no-move'] }).capabilities.MOVE, undefined);
    });

    it('are exported as data', () => {
        assert.deepStrictEqual(Object.keys(quirks), [
            'james-fetchgroup',
            'james-late-fetch',
            'yahoo-quoted-sections',
            'm365-throttle',
            'no-uidplus',
            'no-move'
        ]);
        assert.ok(Object.values(quirks).every(quirk => typeof quirk.description === 'string'));
    });

    describe('james-fetchgroup', () => {
        const ctx = setupServer(() => ({ storage: storage(), quirks: 'james-fetchgroup' }));

        it('answers only the first section of a part', async () => {
            const output = await run(ctx, [
                'A3 FETCH 1 (BODY.PEEK[2.MIME] BODY.PEEK[2])',
                'A4 FETCH 1 (BODY.PEEK[1] BODY.PEEK[1.MIME])',
                'A5 FETCH 1 (BODY.PEEK[1] BODY.PEEK[2])',
                'A6 UID FETCH 1 (BODY.PEEK[HEADER] BODY.PEEK[TEXT])'
            ]);
            assert.match(output, /^\* 1 FETCH \(BODY\[2\.MIME\] \{28\}\r\nContent-Type: text\/plain\r\n\r\n BODY\[2\] \{0\}\r\n\)\r\nA3 OK/m);
            assert.match(output, /^\* 1 FETCH \(BODY\[1\] \{5\}\r\nhello BODY\[1\.MIME\] \{0\}\r\n\)\r\nA4 OK/m);
            // different parts are both answered
            assert.match(output, /^\* 1 FETCH \(BODY\[1\] \{5\}\r\nhello BODY\[2\] \{10\d\}\r\n/m);
            assert.match(output, /BODY\[TEXT\] \{0\}\r\n UID 1\)\r\nA6 OK/);
        });
    });

    describe('yahoo-quoted-sections', () => {
        const ctx = setupServer(() => ({ storage: storage(), quirks: ['yahoo-quoted-sections'] }));

        it('sends short sections as quoted strings', async () => {
            const output = await run(ctx, ['A3 FETCH 1 (BODY.PEEK[1] BODY.PEEK[2] BODY.PEEK[2.MIME])']);
            assert.match(output, /^\* 1 FETCH \(BODY\[1\] "hello" BODY\[2\] \{10\d\}\r\n/m);
            // line breaks can not be in a quoted string
            assert.match(output, /BODY\[2\.MIME\] \{28\}\r\n/);
        });
    });

    describe('no-move and no-uidplus', () => {
        const ctx = setupServer(() => ({ plugins: ['MOVE', 'uidplus', 'IDLE'], quirks: ['no-move', 'no-uidplus'] }));

        it('leave the plugins out', async () => {
            const output = await new Promise<string>(resolve => ctx.run(['A1 CAPABILITY', 'ZZ LOGOUT'], resp => resolve(resp.toString())));
            assert.match(output, /^\* CAPABILITY .*\bIDLE\b/m);
            assert.doesNotMatch(output, /\bMOVE\b|\bUIDPLUS\b/);
        });
    });

    // the tagged results of `count` commands, for a seed
    const results = async (options: Record<string, unknown>, command: string, count: number) => {
        const server = imapkit(Object.assign({ storage: storage() }, options));
        const port = await server.start();
        const client = await connectRaw(port);
        await client.waitFor(/^\* OK/);
        client.send('L1 LOGIN testuser testpass\r\n');
        await client.waitFor(/^L1 (OK|BAD)/m);
        client.send('L2 SELECT INBOX\r\n');
        await client.waitFor(/^L2 (OK|BAD)/m);
        for (let i = 1; i <= count; i++) {
            client.send('C' + i + ' ' + command + '\r\n');
            await client.waitFor(new RegExp('^C' + i + ' (OK|NO|BAD)[^\\r\\n]*\\r\\n', 'm'));
        }
        const output = client.output();
        client.close();
        await server.stop();
        return output;
    };

    it('m365-throttle refuses some commands, repeatable with scriptSeed', async () => {
        const first = await results({ quirks: ['m365-throttle'], scriptSeed: 7 }, 'NOOP', 40);
        const throttled = first.match(/^C\d+ BAD Request is throttled\. Suggested Backoff Time: 1000 milliseconds$/gm) || [];
        assert.ok(throttled.length > 0 && throttled.length < 40, throttled.length + ' throttled');
        assert.strictEqual(await results({ quirks: ['m365-throttle'], scriptSeed: 7 }, 'NOOP', 40), first);
    });

    it('james-late-fetch sends some FETCH responses after the tagged OK', async () => {
        const output = await results({ quirks: ['james-late-fetch'], scriptSeed: 3 }, 'FETCH 1 (UID)', 30);
        const late = (output.match(/^C\d+ OK FETCH Completed\r\n\* 1 FETCH \(UID 1\)$/gm) || []).length;
        assert.ok(late > 0 && late < 30, late + ' of 30 late');
        // every FETCH is answered, early or late
        assert.strictEqual((output.match(/^\* 1 FETCH \(UID 1\)$/gm) || []).length, 30);
        assert.strictEqual(await results({ quirks: ['james-late-fetch'], scriptSeed: 3 }, 'FETCH 1 (UID)', 30), output);
    });
});
