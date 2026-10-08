// Scripted faults (src/script.ts): rules that make the server deviate from the protocol on purpose, so that a
// client can be tested against a broken or unusual server. Most of these tests read the output with a raw socket,
// as the faults break the response grammar that the guardrail of the other tests checks.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import tls from 'node:tls';
import imapkit from '../src/server.js';
import { setupServer } from './helpers/index.js';
import { connectRaw } from './helpers/raw-client.js';
import DeflateLayer from '../src/deflate-layer.js';
import type { RawClient } from './helpers/raw-client.js';
import type { ScriptContext, ScriptRule } from '../src/script.js';
import type { IMAPResponse } from '../src/types.js';

const message = (n: number) => 'From: sender@example.com\r\nSubject: hello ' + n + '\r\n\r\nBody ' + n + '\r\n';

function storage() {
    return {
        INBOX: {
            messages: [1, 2].map(n => ({ raw: message(n), uid: n }))
        },
        '': {
            folders: {
                Archive: { messages: [{ raw: message(10), uid: 1 }] }
            }
        }
    };
}

/** sends a command and waits for its tagged response */
async function command(client: RawClient, line: string): Promise<string> {
    const tag = line.split(' ')[0];
    const before = client.output().length;
    client.send(line + '\r\n');
    const output = await client.waitFor(new RegExp('^' + tag + ' (OK|NO|BAD)[^\\r\\n]*\\r\\n', 'm'));
    return output.slice(before);
}

async function loggedIn(port: number): Promise<RawClient> {
    const client = await connectRaw(port);
    await client.waitFor(/^\* OK .*\r\n/);
    await command(client, 'L1 LOGIN testuser testpass');
    return client;
}

// Bun and Deno may close a reset connection without a RST, the ECONNRESET checks run on Node only
const node = !('Bun' in globalThis) && !('Deno' in globalThis);

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('Script rules', () => {
    describe('validation', () => {
        const server = imapkit({});
        const refused: [string, unknown, RegExp][] = [
            ['a rule that is not an object', null, /must be an object/],
            ['an unknown event', { on: 'banner', drop: true }, /"on" must be one of/],
            ['an unknown option', { on: 'response', drop: true, dorp: true }, /Unknown script rule option "dorp"/],
            ['an option of another event', { on: 'greeting', command: 'LOGIN', drop: true }, /"command" can not be used with "on": "greeting"/],
            ['mutate for a command', { on: 'command', mutate: () => {} }, /"mutate" can not be used with "on": "command"/],
            ['before for a command', { on: 'command', before: 'x' }, /"before" can not be used/],
            ['run for a response', { on: 'response', run: true }, /"run" can not be used/],
            ['delay for an input line', { on: 'input', delay: 10 }, /"delay" can not be used with "on": "input"/],
            ['untagged for a command', { on: 'command', untagged: true, drop: true }, /"untagged" can not be used/],
            ['a rule without an action', { on: 'response', command: 'FETCH' }, /needs an action/],
            ['a rule with only false actions', { on: 'response', drop: false, close: false }, /needs an action/],
            ['drop with send', { on: 'response', drop: true, send: 'x' }, /"drop" can not be combined/],
            ['drop with run', { on: 'command', drop: true, run: true }, /"drop" can not be combined/],
            ['run with close', { on: 'command', send: 'x', run: true, close: true }, /"run" can not be combined/],
            ['run with truncate', { on: 'command', send: 'x', run: true, truncate: 1 }, /"run" can not be combined/],
            ['chunkDelay without chunk', { on: 'response', chunkDelay: 5, drop: true }, /"chunkDelay" needs "chunk"/],
            ['chunk for a command without send', { on: 'command', chunk: 1 }, /need "send"/],
            ['truncate for an input line without send', { on: 'input', truncate: 1 }, /need "send"/],
            ['nth of 0', { on: 'response', nth: 0, drop: true }, /"nth" must be a positive integer/],
            ['a fractional chunk', { on: 'response', chunk: 1.5 }, /"chunk" must be a positive integer/],
            ['a negative delay', { on: 'response', delay: -1 }, /"delay" must be a non-negative integer/],
            ['a delay that is not a number', { on: 'response', delay: '10' }, /"delay" must be a non-negative integer/],
            ['when that is not a function', { on: 'response', when: true, drop: true }, /"when" must be a function/],
            ['send that is a number', { on: 'response', send: 5 }, /"send" must be a string, a Buffer or a function/],
            ['an unknown close mode', { on: 'response', close: 'abort' }, /"close" must be true, false or "reset"/],
            ['match that is a number', { on: 'response', match: 5, drop: true }, /"match" must be a string or a RegExp/],
            ['literals for a command', { on: 'command', literals: true }, /"literals" can not be used with "on": "command"/],
            ['literals that is not a boolean', { on: 'response', literals: 'yes' }, /"literals" must be true or false/],
            ['defer for a continuation', { on: 'continuation', defer: 'tagged' }, /"defer" can not be used/],
            ['an unknown defer mode', { on: 'response', untagged: true, defer: 'later' }, /"defer" must be "tagged" or "next"/],
            ['defer without untagged', { on: 'response', defer: 'tagged' }, /"defer" needs "untagged": true/],
            ['defer of tagged responses', { on: 'response', untagged: false, defer: 'next' }, /"defer" needs "untagged": true/],
            ['defer with delay', { on: 'response', untagged: true, defer: 'next', delay: 10 }, /"defer" can not be combined with "/],
            ['defer with drop', { on: 'response', untagged: true, defer: 'next', drop: true }, /"defer" can not be combined with "/],
            ['defer with close', { on: 'response', untagged: true, defer: 'tagged', close: true }, /"defer" can not be combined with "/],
            ['an invalid regular expression', { on: 'response', match: '(', drop: true }, /"match" is not a valid regular expression/]
        ];
        for (const [name, rule, error] of refused) {
            it('refuses ' + name, () => {
                assert.throws(
                    () => server.script.add(rule as ScriptRule),
                    (err: Error) => err instanceof TypeError && error.test(err.message)
                );
            });
        }

        it('adds none of a list when one rule is invalid', () => {
            const before = server.script.rules.length;
            assert.throws(() => server.script.add([{ on: 'response', drop: true }, { on: 'response' } as ScriptRule]), TypeError);
            assert.strictEqual(server.script.rules.length, before);
        });

        it('refuses an invalid rule in the script option', () => {
            assert.throws(() => imapkit({ script: [{ on: 'greeting', tag: 'A1', drop: true }] }), /"tag" can not be used/);
        });

        it('keeps a copy of the rule and gives handles', () => {
            const local = imapkit({ script: { on: 'greeting', drop: true } });
            const rule: ScriptRule = { on: 'response', command: 'NOOP', drop: true };
            const [handle] = local.script.add([rule]);
            rule.command = 'LOGOUT';
            assert.strictEqual(handle.rule.command, 'NOOP');
            assert.ok(Object.isFrozen(handle.rule));
            assert.deepStrictEqual(
                local.script.rules.map(item => item.rule.on),
                ['greeting', 'response']
            );
            assert.strictEqual(handle.hits, 0);
            assert.strictEqual(handle.matched, 0);
            handle.remove();
            assert.strictEqual(local.script.rules.length, 1);
            local.script.clear();
            assert.strictEqual(local.script.rules.length, 0);
        });
    });

    describe('greeting', () => {
        const ctx = setupServer(() => ({ storage: storage() }));

        it('replaces the greeting', async () => {
            ctx.server.script.add({ on: 'greeting', send: '* BYE Too many connections\r\n', close: true });
            const client = await connectRaw(ctx.port);
            const { output } = await client.closed();
            assert.strictEqual(output, '* BYE Too many connections\r\n');
        });

        it('drops the greeting, the server still answers commands', async () => {
            ctx.server.script.add({ on: 'greeting', drop: true });
            const client = await connectRaw(ctx.port);
            const output = await command(client, 'A1 NOOP');
            assert.match(output, /^A1 OK/);
            assert.doesNotMatch(client.output(), /^\* OK ImapKit/m);
            client.close();
        });

        it('adds output before and after the greeting', async () => {
            ctx.server.script.add({ on: 'greeting', before: 'garbage\r\n', after: '* 0 EXISTS\r\n' });
            const client = await connectRaw(ctx.port);
            const output = await client.waitFor(/EXISTS\r\n/);
            assert.match(output, /^garbage\r\n\* OK ImapKit ready for rumble\r\n\* 0 EXISTS\r\n$/);
            client.close();
        });

        it('delays the greeting', async () => {
            ctx.server.script.add({ on: 'greeting', delay: 150 });
            const client = await connectRaw(ctx.port);
            await client.waitFor(/^\* OK/);
            assert.ok(client.reads[0].time >= 100, 'greeting arrived after ' + client.reads[0].time + 'ms');
            client.close();
        });

        it('sends the greeting in pieces', async () => {
            ctx.server.script.add({ on: 'greeting', chunk: 5, chunkDelay: 30 });
            const client = await connectRaw(ctx.port);
            const output = await client.waitFor(/rumble\r\n/);
            assert.strictEqual(output, '* OK ImapKit ready for rumble\r\n');
            assert.ok(client.reads.length >= 3, 'greeting arrived in ' + client.reads.length + ' reads');
            assert.strictEqual(client.reads[0].data, '* OK ');
        });

        it('truncates the greeting and closes the connection', async () => {
            ctx.server.script.add({ on: 'greeting', truncate: 7 });
            const client = await connectRaw(ctx.port);
            const { output } = await client.closed();
            assert.strictEqual(output, '* OK Im');
        });

        it('matches the session number', async () => {
            ctx.server.script.add({ on: 'greeting', session: 2, send: '* PREAUTH second\r\n' });
            const first = await connectRaw(ctx.port);
            await first.waitFor(/^\* OK/);
            const second = await connectRaw(ctx.port);
            await second.waitFor(/^\* PREAUTH second\r\n/);
            first.close();
            second.close();
        });
    });

    describe('response', () => {
        const ctx = setupServer(() => ({ storage: storage(), plugins: ['IDLE'] }));

        it('sends a string as a literal, through the guardrail', (t, done) => {
            const handle = ctx.server.script.add({
                on: 'response',
                command: 'FETCH',
                untagged: true,
                mutate: response => {
                    // ENVELOPE strings are plain values in the response tree, the compiler quotes them
                    const walk = (list: unknown[]) =>
                        list.forEach((node, i) => {
                            if (Array.isArray(node)) {
                                walk(node);
                            } else if (typeof node === 'string') {
                                list[i] = { type: 'LITERAL', value: node };
                            }
                        });
                    walk(response.attributes || []);
                }
            });
            ctx.run(['L1 LOGIN testuser testpass', 'S1 SELECT INBOX', 'F1 FETCH 1 (ENVELOPE)', 'F2 FETCH 2 (ENVELOPE)'], resp => {
                const output = resp.toString('binary');
                assert.match(output, /^\* 1 FETCH \(ENVELOPE \(NIL \{7\}\r\nhello 1 \(\(NIL NIL \{6\}\r\nsender \{11\}\r\nexample\.com\)\)/m);
                assert.match(output, /\{7\}\r\nhello 2/);
                assert.match(output, /^F2 OK/m);
                assert.strictEqual(handle.hits, 2);
                done();
            });
        });

        it('changes only the copy of a notification that one session gets', async () => {
            ctx.server.script.add({
                on: 'response',
                session: 1,
                match: /EXISTS/,
                mutate: response => {
                    (response.attributes as unknown[])[0] = 99;
                }
            });
            const first = await loggedIn(ctx.port);
            const second = await loggedIn(ctx.port);
            await command(first, 'S1 SELECT INBOX');
            await command(second, 'S1 SELECT INBOX');
            first.send('A1 APPEND INBOX {5}\r\n');
            await first.waitFor(/^\+ /m);
            first.send('hello\r\n');
            await first.waitFor(/^A1 OK/m);
            const secondNoop = await command(second, 'N1 NOOP');
            // the first session sees every EXISTS changed, the second one the real count
            assert.match(first.output(), /^\* 99 EXISTS\r\n[\s\S]*^\* 99 EXISTS\r\nA1 OK/m);
            assert.doesNotMatch(first.output(), /^\* \d EXISTS/m);
            assert.match(secondNoop, /^\* 3 EXISTS\r\n/m);
            first.close();
            second.close();
        });

        it('replaces a response with an invalid literal', async () => {
            ctx.server.script.add({ on: 'response', command: 'FETCH', untagged: true, send: '* 1 FETCH (BODY[] {100}\r\nshort)\r\n' });
            const client = await loggedIn(ctx.port);
            await command(client, 'S1 SELECT INBOX');
            const output = await command(client, 'F1 FETCH 1 BODY[]');
            assert.match(output, /^\* 1 FETCH \(BODY\[\] \{100\}\r\nshort\)\r\nF1 OK /);
            client.close();
        });

        it('replaces a tagged response, $TAG is the tag', async () => {
            ctx.server.script.add({ on: 'response', command: 'NOOP', untagged: false, send: '$TAG NO [UNAVAILABLE] Not now\r\n' });
            const client = await loggedIn(ctx.port);
            assert.strictEqual(await command(client, 'X7 NOOP'), 'X7 NO [UNAVAILABLE] Not now\r\n');
            client.close();
        });

        it('sends the output of a function, strings with wide characters as UTF-8', async () => {
            const contexts: ScriptContext[] = [];
            ctx.server.script.add({
                on: 'response',
                command: 'NOOP',
                untagged: false,
                send: context => {
                    contexts.push(context);
                    return context.tag + ' OK Žluťoučký\r\n';
                }
            });
            const client = await loggedIn(ctx.port);
            const output = await command(client, 'A1 NOOP');
            assert.strictEqual(Buffer.from(output, 'binary').toString('utf-8'), 'A1 OK Žluťoučký\r\n');
            assert.strictEqual(contexts.length, 1);
            const context = contexts[0];
            assert.strictEqual(context.event, 'response');
            assert.strictEqual(context.command, 'NOOP');
            assert.strictEqual(context.tag, 'A1');
            assert.strictEqual(context.state, 'Authenticated');
            assert.strictEqual(context.user, 'testuser');
            assert.strictEqual(context.mailbox, null);
            assert.strictEqual(typeof context.description, 'string');
            assert.match(context.data, /^A1 OK .*\r\n$/);
            assert.strictEqual((context.response as IMAPResponse).command, 'OK');
            client.close();
        });

        it('sends a Buffer as it is', async () => {
            ctx.server.script.add({ on: 'response', command: 'NOOP', send: Buffer.from('A1 OK caf\xc3\xa9 $TAG\r\n', 'binary') });
            const client = await loggedIn(ctx.port);
            assert.strictEqual(await command(client, 'A1 NOOP'), 'A1 OK caf\xc3\xa9 $TAG\r\n');
            client.close();
        });

        it('drops responses and adds others', async () => {
            ctx.server.script.add([
                { on: 'response', command: 'SELECT', match: /^\* \d+ EXISTS/, drop: true },
                { on: 'response', command: 'SELECT', untagged: false, before: '* 7 RECENT\r\n' }
            ]);
            const client = await loggedIn(ctx.port);
            const output = await command(client, 'S1 SELECT INBOX');
            assert.doesNotMatch(output, /EXISTS/);
            assert.match(output, /^\* 7 RECENT\r\nS1 OK \[READ-WRITE\]/m);
            client.close();
        });

        it('fires from the nth match, at most `times` times', async () => {
            const handle = ctx.server.script.add({ on: 'response', command: 'NOOP', untagged: false, nth: 2, times: 2, send: '$TAG BAD scripted\r\n' });
            const client = await loggedIn(ctx.port);
            const results = [];
            for (let i = 1; i <= 4; i++) {
                results.push((await command(client, 'N' + i + ' NOOP')).split(' ')[1]);
            }
            assert.deepStrictEqual(results, ['OK', 'BAD', 'BAD', 'OK']);
            assert.strictEqual(handle.hits, 2);
            assert.strictEqual(handle.matched, 4);
            client.close();
        });

        it('lets a later rule handle what an exhausted or waiting rule does not', async () => {
            ctx.server.script.add([
                { on: 'response', command: 'NOOP', untagged: false, nth: 2, send: '$TAG NO second\r\n' },
                { on: 'response', command: 'NOOP', untagged: false, times: 1, send: '$TAG NO first\r\n' }
            ]);
            const client = await loggedIn(ctx.port);
            assert.strictEqual(await command(client, 'N1 NOOP'), 'N1 NO first\r\n');
            assert.strictEqual(await command(client, 'N2 NOOP'), 'N2 NO second\r\n');
            client.close();
        });

        it('matches the tag, the description, the state, the user and the mailbox', async () => {
            ctx.server.script.add([
                { on: 'response', tag: /^Z/, untagged: false, send: '$TAG NO tag\r\n' },
                { on: 'response', description: 'LOGIN SUCCESS', after: '* OK [ALERT] scripted\r\n' },
                { on: 'response', state: 'Selected', mailbox: 'Archive', user: 'testuser', command: 'NOOP', send: '$TAG NO archive\r\n' },
                { on: 'response', state: ['Authenticated'], user: 'nobody', drop: true }
            ]);
            const client = await connectRaw(ctx.port);
            await client.waitFor(/^\* OK/);
            assert.match(await command(client, 'L1 LOGIN testuser testpass'), /^L1 OK .*\r\n\* OK \[ALERT\] scripted\r\n$/);
            assert.strictEqual(await command(client, 'Z1 NOOP'), 'Z1 NO tag\r\n');
            assert.match(await command(client, 'N1 NOOP'), /^N1 OK/);
            await command(client, 'S1 SELECT INBOX');
            assert.match(await command(client, 'N2 NOOP'), /^N2 OK/);
            await command(client, 'S2 SELECT Archive');
            assert.strictEqual(await command(client, 'N3 NOOP'), 'N3 NO archive\r\n');
            client.close();
        });

        it('matches with when', async () => {
            ctx.server.script.add({ on: 'response', command: 'NOOP', when: context => context.tag === 'B2', send: '$TAG NO when\r\n' });
            const client = await loggedIn(ctx.port);
            assert.match(await command(client, 'B1 NOOP'), /^B1 OK/);
            assert.strictEqual(await command(client, 'B2 NOOP'), 'B2 NO when\r\n');
            client.close();
        });

        it('takes a string match as a regular expression', async () => {
            ctx.server.script.add({ on: 'response', match: '^\\* CAPABILITY', send: '* CAPABILITY IMAP4rev1 BROKEN\r\n' });
            const client = await loggedIn(ctx.port);
            assert.match(await command(client, 'C1 CAPABILITY'), /^\* CAPABILITY IMAP4rev1 BROKEN\r\nC1 OK/);
            client.close();
        });

        it('keeps the order of output behind a delay', async () => {
            ctx.server.script.add({ on: 'response', command: 'SELECT', match: /EXISTS/, delay: 150 });
            const client = await loggedIn(ctx.port);
            const started = Date.now();
            const output = await command(client, 'S1 SELECT INBOX');
            assert.ok(Date.now() - started >= 100);
            assert.match(output, /^\* FLAGS[\s\S]*^\* 2 EXISTS\r\n[\s\S]*^S1 OK/m);
            const exists = client.reads.findIndex(read => /EXISTS/.test(read.data));
            assert.ok(client.reads[exists].time - client.reads[exists - 1].time >= 100, 'EXISTS waited for the delay');
            assert.doesNotMatch(client.reads[exists - 1].data, /EXISTS/);
            client.close();
        });

        it('closes the connection after LOGOUT once the delayed output is sent', async () => {
            ctx.server.script.add({ on: 'response', command: 'LOGOUT', untagged: true, delay: 100 });
            const client = await loggedIn(ctx.port);
            client.send('O1 LOGOUT\r\n');
            const { output } = await client.closed();
            assert.match(output, /^\* BYE[^\r]*\r\nO1 OK[^\r]*\r\n$/m);
        });

        it('closes the connection after a response', async () => {
            ctx.server.script.add({ on: 'response', command: 'SELECT', untagged: false, close: true });
            const client = await loggedIn(ctx.port);
            client.send('S1 SELECT INBOX\r\nN1 NOOP\r\n');
            const { output } = await client.closed();
            assert.match(output, /^S1 OK [^\r]*\r\n$/m);
            assert.doesNotMatch(output, /^N1/m);
        });

        it('closes the connection in the middle of a literal', async () => {
            ctx.server.script.add({ on: 'response', command: 'FETCH', untagged: true, truncate: 30, delay: 20 });
            const client = await loggedIn(ctx.port);
            await command(client, 'S1 SELECT INBOX');
            client.send('F1 FETCH 1 BODY[]\r\n');
            const { output } = await client.closed();
            assert.match(output, /\* 1 FETCH \(BODY\[\] \{\d+\}\r\nFrom: $/);
        });

        it('sends a NO [SERVERBUG] when a mutated tagged response does not compile', async () => {
            ctx.server.script.add({
                on: 'response',
                command: 'NOOP',
                untagged: false,
                mutate: () => ({ tag: 'N1', command: 'OK', attributes: [{ type: 'TEXT', value: 'line\r\nbreak' }] })
            });
            const client = await loggedIn(ctx.port);
            assert.strictEqual(await command(client, 'N1 NOOP'), 'N1 NO [SERVERBUG] Failed to compile response\r\n');
            client.close();
        });

        it('drops a mutated untagged response that does not compile', async () => {
            ctx.server.script.add({
                on: 'response',
                command: 'CAPABILITY',
                untagged: true,
                mutate: response => {
                    response.attributes = [{ type: 'TEXT', value: 'line\nbreak' }];
                }
            });
            const client = await loggedIn(ctx.port);
            assert.match(await command(client, 'C1 CAPABILITY'), /^C1 OK/);
            client.close();
        });

        it('emits a script event', async () => {
            const events: unknown[] = [];
            ctx.server.on('script', event => events.push(event));
            ctx.server.script.add({ on: 'response', command: 'NOOP', untagged: false, after: '' });
            const client = await loggedIn(ctx.port);
            await command(client, 'N1 NOOP');
            assert.strictEqual(events.length, 1);
            assert.deepStrictEqual(Object.assign({}, events[0], { rule: undefined }), {
                rule: undefined,
                event: 'response',
                session: 1,
                tag: 'N1',
                command: 'NOOP'
            });
            client.close();
        });

        it('matches unsolicited responses during IDLE', async () => {
            ctx.server.script.add({ on: 'response', session: 1, command: 'IDLE', match: /EXISTS/, send: '* 1 EXPUNGE\r\n' });
            const first = await loggedIn(ctx.port);
            const second = await loggedIn(ctx.port);
            await command(first, 'S1 SELECT INBOX');
            first.send('I1 IDLE\r\n');
            await first.waitFor(/^\+ idling\r\n/m);
            second.send('A1 APPEND INBOX {5}\r\n');
            await second.waitFor(/^\+ /m);
            second.send('hello\r\n');
            await first.waitFor(/^\* 1 EXPUNGE\r\n/m);
            first.close();
            second.close();
        });
    });

    describe('continuation', () => {
        const ctx = setupServer(() => ({ storage: storage(), plugins: ['IDLE', 'AUTH-PLAIN', 'SASL-IR', 'XOAUTH2'] }));

        it('replaces the continuation request of a literal', async () => {
            const contexts: ScriptContext[] = [];
            ctx.server.script.add({ on: 'continuation', description: 'LITERAL', when: context => !!contexts.push(context), send: '+\r\n' });
            const client = await loggedIn(ctx.port);
            client.send('A1 APPEND INBOX {5}\r\n');
            await client.waitFor(/^\+\r\n/m);
            client.send('hello\r\n');
            await client.waitFor(/^A1 OK/m);
            assert.strictEqual(contexts[0].tag, 'A1');
            assert.strictEqual(contexts[0].command, 'APPEND');
            client.close();
        });

        it('withholds the continuation request', async () => {
            ctx.server.script.add({ on: 'continuation', command: 'LOGIN', drop: true });
            const client = await connectRaw(ctx.port);
            await client.waitFor(/^\* OK/);
            client.send('L1 LOGIN {8}\r\n');
            await wait(100);
            assert.doesNotMatch(client.output(), /^\+/m);
            client.close();
        });

        it('resets the connection after the IDLE continuation of a longer session (#81)', async () => {
            ctx.server.script.add({ on: 'continuation', description: 'IDLE', close: 'reset' });
            const client = await connectRaw(ctx.port);
            await client.waitFor(/^\* OK/);
            for (const line of [
                '1 CAPABILITY',
                '2 LOGIN testuser testpass',
                '3 CAPABILITY',
                '4 LIST "" ""',
                '5 LIST "" "INBOX"',
                '6 LSUB "" "INBOX"',
                '7 SELECT INBOX'
            ]) {
                await command(client, line);
            }
            client.send('8 IDLE\r\n');
            const { output, error } = await client.closed();
            assert.match(output, /\r\n\+ idling\r\n$/);
            if (node) {
                assert.strictEqual((error as NodeJS.ErrnoException | null)?.code, 'ECONNRESET');
            }
        });

        it('replaces the continuation of IDLE', async () => {
            ctx.server.script.add({ on: 'continuation', command: 'IDLE', send: '* OK still here\r\n' });
            const client = await loggedIn(ctx.port);
            await command(client, 'S1 SELECT INBOX');
            client.send('I1 IDLE\r\n');
            await client.waitFor(/^\* OK still here\r\n/m);
            client.send('DONE\r\n');
            await client.waitFor(/^I1 OK/m);
            assert.doesNotMatch(client.output(), /^\+ idling/m);
            client.close();
        });

        it('replaces the empty SASL challenge', async () => {
            ctx.server.script.add({ on: 'continuation', description: 'AUTHENTICATE PLAIN', send: '+ bm90IGVtcHR5\r\n' });
            const client = await connectRaw(ctx.port);
            await client.waitFor(/^\* OK/);
            client.send('A1 AUTHENTICATE PLAIN\r\n');
            await client.waitFor(/^\+ bm90IGVtcHR5\r\n/m);
            client.send(Buffer.from('\x00testuser\x00testpass').toString('base64') + '\r\n');
            await client.waitFor(/^A1 OK/m);
            client.close();
        });

        it('sees continuations that are sent as responses', async () => {
            const handle = ctx.server.script.add({ on: 'continuation', command: 'AUTHENTICATE XOAUTH2', send: '+ e30=\r\n' });
            const client = await connectRaw(ctx.port);
            await client.waitFor(/^\* OK/);
            const token = Buffer.from('user=testuser\x01auth=Bearer wrong\x01\x01').toString('base64');
            client.send('A1 AUTHENTICATE XOAUTH2 ' + token + '\r\n');
            await client.waitFor(/^\+ e30=\r\n/m);
            client.send('\r\n');
            await client.waitFor(/^A1 NO/m);
            assert.strictEqual(handle.hits, 1);
            client.close();
        });
    });

    describe('command', () => {
        const ctx = setupServer(() => ({ storage: storage(), plugins: ['IDLE', 'MOVE'] }));

        it('answers a command instead of running it', async () => {
            ctx.server.script.add({ on: 'command', command: 'LOGIN', send: '$TAG OK pretend\r\n' });
            const client = await connectRaw(ctx.port);
            await client.waitFor(/^\* OK/);
            assert.strictEqual(await command(client, 'L1 LOGIN testuser testpass'), 'L1 OK pretend\r\n');
            // the session did not log in
            assert.match(await command(client, 'S1 SELECT INBOX'), /^S1 BAD/);
            client.close();
        });

        it('sends output before running the command', async () => {
            ctx.server.script.add({ on: 'command', command: 'SELECT', send: '* 5 EXISTS\r\n', run: true });
            const client = await loggedIn(ctx.port);
            const output = await command(client, 'S1 SELECT INBOX');
            assert.match(output, /^\* 5 EXISTS\r\n\* FLAGS/);
            assert.match(output, /^S1 OK \[READ-WRITE\]/m);
            client.close();
        });

        it('runs a command with message numbers after a scripted output', async () => {
            ctx.server.script.add({ on: 'command', command: 'COPY', send: '* OK scripted\r\n', run: true });
            const client = await loggedIn(ctx.port);
            await command(client, 'S1 SELECT INBOX');
            assert.match(await command(client, 'C1 COPY 1 Archive'), /^\* OK scripted\r\nC1 OK/);
            client.close();
        });

        it('ignores a command', async () => {
            ctx.server.script.add({ on: 'command', tag: 'N1', drop: true });
            const client = await loggedIn(ctx.port);
            client.send('N1 NOOP\r\n');
            assert.match(await command(client, 'N2 NOOP'), /^N2 OK [^\r]*\r\n$/);
            assert.doesNotMatch(client.output(), /^N1/m);
            client.close();
        });

        it('delays a command and keeps the order of pipelined commands', async () => {
            ctx.server.script.add({ on: 'command', command: 'NOOP', times: 1, delay: 120 });
            const client = await loggedIn(ctx.port);
            const started = Date.now();
            client.send('N1 NOOP\r\nC1 CAPABILITY\r\n');
            const output = await client.waitFor(/^C1 OK/m);
            assert.ok(Date.now() - started >= 100);
            assert.match(output, /^N1 OK[^\r]*\r\n\* CAPABILITY[^\r]*\r\nC1 OK/m);
            client.close();
        });

        it('delays a scripted answer', async () => {
            ctx.server.script.add({ on: 'command', command: 'NOOP', delay: 100, send: '$TAG OK late\r\n' });
            const client = await loggedIn(ctx.port);
            const started = Date.now();
            assert.strictEqual(await command(client, 'N1 NOOP'), 'N1 OK late\r\n');
            assert.ok(Date.now() - started >= 80);
            client.close();
        });

        it('resets the connection', async () => {
            // after the greeting, so that the socket is connected before the reset
            ctx.server.script.add({ on: 'command', command: 'NOOP', close: 'reset' });
            const client = await loggedIn(ctx.port);
            const before = client.output();
            client.send('N1 NOOP\r\n');
            const { output } = await client.closed();
            assert.strictEqual(output, before);
        });

        it('closes the connection instead of answering', async () => {
            ctx.server.script.add({ on: 'command', command: 'SELECT', send: '* BYE going away\r\n', close: true });
            const client = await loggedIn(ctx.port);
            client.send('S1 SELECT INBOX\r\n');
            const { output } = await client.closed();
            assert.match(output, /\* BYE going away\r\n$/);
        });

        it('sends a part of the answer in pieces, then closes', async () => {
            ctx.server.script.add({ on: 'command', command: 'NOOP', send: '$TAG OK NOOP completed\r\n', chunk: 4, chunkDelay: 5, truncate: 10 });
            const client = await loggedIn(ctx.port);
            client.send('N1 NOOP\r\n');
            const { output } = await client.closed();
            assert.match(output, /\r\nN1 OK NOOP$/);
        });

        it('answers commands that do not parse or do not exist', async () => {
            ctx.server.script.add([
                { on: 'command', command: 'XFOO', send: '$TAG OK XFOO done\r\n' },
                { on: 'command', match: /^B1 FETCH \(/, send: '$TAG OK parsed anyway\r\n' }
            ]);
            const client = await loggedIn(ctx.port);
            assert.strictEqual(await command(client, 'A1 XFOO bar'), 'A1 OK XFOO done\r\n');
            assert.strictEqual(await command(client, 'B1 FETCH ((('), 'B1 OK parsed anyway\r\n');
            client.close();
        });

        it('runs a command that does not parse as usual with run', async () => {
            ctx.server.script.add({ on: 'command', command: 'FETCH', send: '* OK before\r\n', run: true });
            const client = await loggedIn(ctx.port);
            const output = await command(client, 'B1 FETCH (((');
            assert.match(output, /^\* OK before\r\n\* BAD \[SYNTAX\][^\r]*\r\nB1 BAD/);
            client.close();
        });

        it('sees the state when the command line arrives', async () => {
            ctx.server.script.add({ on: 'command', state: 'Not Authenticated', command: 'NOOP', send: '$TAG NO not yet\r\n' });
            const client = await connectRaw(ctx.port);
            await client.waitFor(/^\* OK/);
            assert.strictEqual(await command(client, 'N1 NOOP'), 'N1 NO not yet\r\n');
            await command(client, 'L1 LOGIN testuser testpass');
            assert.match(await command(client, 'N2 NOOP'), /^N2 OK/);
            client.close();
        });

        it('takes a command with literals as one line', async () => {
            const lines: string[] = [];
            ctx.server.script.add({ on: 'command', command: 'APPEND', when: context => !!lines.push(context.data), send: '$TAG NO [OVERQUOTA] full\r\n' });
            const client = await loggedIn(ctx.port);
            client.send('A1 APPEND INBOX {5}\r\n');
            await client.waitFor(/^\+ Go ahead/m);
            client.send('hello\r\n');
            await client.waitFor(/^A1 NO \[OVERQUOTA\] full\r\n/m);
            assert.deepStrictEqual(lines, ['A1 APPEND INBOX {5}\r\nhello']);
            client.close();
        });
    });

    describe('input', () => {
        const ctx = setupServer(() => ({ storage: storage(), plugins: ['IDLE', 'AUTH-PLAIN'] }));

        it('ignores DONE, the server keeps idling', async () => {
            ctx.server.script.add({ on: 'input', command: 'IDLE', match: /^DONE$/, times: 1, drop: true });
            const client = await loggedIn(ctx.port);
            await command(client, 'S1 SELECT INBOX');
            client.send('I1 IDLE\r\n');
            await client.waitFor(/^\+ idling/m);
            client.send('DONE\r\n');
            await wait(80);
            assert.doesNotMatch(client.output(), /^I1/m);
            client.send('DONE\r\n');
            await client.waitFor(/^I1 OK/m);
            client.close();
        });

        it('answers an input line, and runs it with run', async () => {
            ctx.server.script.add({ on: 'input', tag: 'A1', send: '* OK got it\r\n', run: true });
            const client = await connectRaw(ctx.port);
            await client.waitFor(/^\* OK ImapKit/);
            client.send('A1 AUTHENTICATE PLAIN\r\n');
            await client.waitFor(/^\+ /m);
            client.send(Buffer.from('\x00testuser\x00testpass').toString('base64') + '\r\n');
            const output = await client.waitFor(/^A1 OK/m);
            assert.match(output, /^\* OK got it\r\nA1 OK/m);
            client.close();
        });

        it('closes the connection on an input line', async () => {
            ctx.server.script.add({ on: 'input', close: 'reset' });
            const client = await loggedIn(ctx.port);
            await command(client, 'S1 SELECT INBOX');
            client.send('I1 IDLE\r\n');
            await client.waitFor(/^\+ idling/m);
            client.send('DONE\r\n');
            const { output } = await client.closed();
            assert.doesNotMatch(output, /^I1/m);
        });
    });

    describe('COMPRESS', () => {
        const ctx = setupServer(() => ({ storage: storage(), plugins: ['COMPRESS=DEFLATE'] }));

        it('sends a delayed COMPRESS response uncompressed, and compresses what follows', async () => {
            ctx.server.script.add({ on: 'response', command: 'COMPRESS', delay: 80 });
            const client = await loggedIn(ctx.port);
            const before = client.output().length;
            client.send('C1 COMPRESS DEFLATE\r\n');
            await client.waitFor(/^C1 OK[^\r]*\r\n/m);
            assert.match(client.output().slice(before), /^C1 OK[^\r]*\r\n$/);

            let plain = '';
            const decompressed = new Promise<void>(resolve => {
                const layer = new DeflateLayer({
                    writeRaw: chunk => client.socket.write(chunk),
                    onData: chunk => {
                        plain += chunk.toString('binary');
                        if (/^N1 OK/m.test(plain)) {
                            resolve();
                        }
                    }
                });
                client.socket.removeAllListeners('data');
                client.socket.on('data', chunk => layer.receive(chunk));
                layer.write(Buffer.from('N1 NOOP\r\n'));
            });
            await decompressed;
            assert.match(plain, /^N1 OK/m);
            client.close();
        });
    });

    describe('literals', () => {
        const nested = 'From: inner@example.com\r\nSubject: inner\r\nContent-Type: text/plain\r\n\r\nInner body\r\n';
        const multipart = [
            'From: sender@example.com',
            'Subject: parts',
            'Content-Type: multipart/mixed; boundary="xyz"',
            '',
            '--xyz',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'Hello',
            '--xyz',
            'Content-Type: message/rfc822',
            '',
            nested,
            '--xyz',
            'Content-Type: application/octet-stream; name="a.bin"',
            'Content-Transfer-Encoding: base64',
            '',
            'AAEC',
            '--xyz--',
            ''
        ].join('\r\n');
        const ctx = setupServer(() => ({
            plugins: ['NAMESPACE', 'LIST-EXTENDED', 'ESEARCH', 'ID', 'SAVEDATE'],
            id: { name: 'ImapKit' },
            storage: {
                INBOX: { messages: [{ raw: multipart, uid: 1 }] },
                '': { separator: '/', folders: { Parent: { subscribed: true, folders: { Child: { subscribed: true } } } } }
            }
        }));

        it('sends strings as literals and keeps the quoted-only positions, through the guardrail', (t, done) => {
            const handle = ctx.server.script.add({ on: 'response', untagged: true, literals: true });
            ctx.run(
                [
                    'L1 LOGIN testuser testpass',
                    'N1 NAMESPACE',
                    'L2 LIST "" "*"',
                    'L3 LIST (SUBSCRIBED RECURSIVEMATCH) "" "P*"',
                    'I1 ID NIL',
                    'S1 SELECT INBOX',
                    'F1 FETCH 1 (BODYSTRUCTURE INTERNALDATE SAVEDATE ENVELOPE)',
                    'F2 FETCH 1 (BODY)',
                    'E1 SEARCH RETURN (MIN) ALL'
                ],
                resp => {
                    const output = resp.toString('binary');
                    // namespace-descr: the prefix is a string, the delimiter only DQUOTE QUOTED-CHAR DQUOTE
                    assert.match(output, /^\* NAMESPACE \(\(\{0\}\r\n "\/"\)\) NIL NIL\r\n/m);
                    // mailbox-list: the delimiter stays quoted, the name is a literal
                    assert.match(output, /^\* LIST \(\\HasNoChildren\) "\/" \{5\}\r\nINBOX\r\n/m);
                    // CHILDINFO takes quoted strings only (RFC 5258 section 6), the tag is an astring
                    assert.match(output, /^\* LIST \(\\Subscribed \\HasChildren\) "\/" \{6\}\r\nParent \(\{9\}\r\nCHILDINFO \("SUBSCRIBED"\)\)\r\n/m);
                    assert.match(output, /^\* ID \(\{4\}\r\nname \{7\}\r\nImapKit\)\r\n/m);
                    // date-time is quoted only
                    assert.match(output, /INTERNALDATE "\d{2}-\w{3}-\d{4} [\d:]{8} [+-]\d{4}" SAVEDATE "/);
                    // media-text and media-message stay quoted, the subtypes and parameters are strings
                    assert.match(output, /BODYSTRUCTURE \(\("TEXT" \{5\}\r\nPLAIN \(\{7\}\r\nCHARSET \{5\}\r\nutf-8\)/);
                    assert.match(output, /\("MESSAGE" "RFC822" NIL NIL NIL \{4\}\r\n7BIT \d+ \(NIL \{5\}\r\ninner /);
                    assert.match(output, /\(NIL \{5\}\r\ninner [\s\S]*?\) \("TEXT" \{5\}\r\nPLAIN NIL NIL NIL \{4\}\r\n7BIT 12 1 /);
                    assert.match(output, /\(\{11\}\r\nAPPLICATION \{12\}\r\nOCTET-STREAM \(\{4\}\r\nNAME \{5\}\r\na\.bin\)/);
                    assert.match(output, /\{5\}\r\nMIXED \(\{8\}\r\nBOUNDARY \{3\}\r\nxyz\)/);
                    assert.match(output, /^\* 1 FETCH \(BODY \(\("TEXT" \{5\}\r\nPLAIN /m);
                    assert.match(output, /ENVELOPE \(NIL \{5\}\r\nparts \(\(NIL NIL \{6\}\r\nsender \{11\}\r\nexample\.com\)\)/);
                    assert.match(output, /^\* ESEARCH \(TAG \{2\}\r\nE1\) MIN 1\r\n/m);
                    // tagged responses have no strings, response codes take no literals
                    assert.match(output, /^S1 OK \[READ-WRITE\]/m);
                    assert.ok(handle.hits > 10);
                    done();
                }
            );
        });

        it('applies after mutate', (t, done) => {
            ctx.server.script.add({
                on: 'response',
                command: 'FETCH',
                untagged: true,
                literals: true,
                mutate: response => {
                    (response.attributes as unknown[])[2] = [{ type: 'ATOM', value: 'PREVIEW' }, 'changed'];
                }
            });
            ctx.run(['L1 LOGIN testuser testpass', 'S1 SELECT INBOX', 'F1 FETCH 1 (FLAGS)'], resp => {
                assert.match(resp.toString('binary'), /^\* 1 FETCH \(PREVIEW \{7\}\r\nchanged\)\r\n/m);
                done();
            });
        });

        it('leaves responses without attributes alone', async () => {
            ctx.server.script.add({ on: 'response', command: 'SELECT', match: /EXISTS/, literals: true });
            const client = await loggedIn(ctx.port);
            assert.match(await command(client, 'S1 SELECT INBOX'), /^\* 1 EXISTS\r\n/m);
            client.close();
        });
    });

    describe('defer', () => {
        const ctx = setupServer(() => ({ storage: storage(), plugins: ['IDLE'] }));

        it('sends an untagged response after the tagged response of its command', async () => {
            const handle = ctx.server.script.add({ on: 'response', command: 'UID FETCH', untagged: true, match: /UID 2/, times: 1, defer: 'tagged' });
            const client = await loggedIn(ctx.port);
            await command(client, 'S1 SELECT INBOX');
            const before = client.output().length;
            client.send('F1 UID FETCH 1:2 (FLAGS)\r\n');
            const output = (await client.waitFor(/\* 2 FETCH [^\r]*\r\n$/)).slice(before);
            assert.match(output, /^\* 1 FETCH \(FLAGS \(\) UID 1\)\r\nF1 OK [^\r]*\r\n\* 2 FETCH \(FLAGS \(\) UID 2\)\r\n$/);
            assert.strictEqual(handle.hits, 1);
            client.close();
        });

        it('sends an untagged response within the answer to the next command', async () => {
            ctx.server.script.add({ on: 'response', command: 'FETCH', untagged: true, match: /^\* 2 FETCH/, defer: 'next' });
            const client = await loggedIn(ctx.port);
            await command(client, 'S1 SELECT INBOX');
            assert.match(await command(client, 'F1 FETCH 1:2 (FLAGS)'), /^\* 1 FETCH \(FLAGS \(\)\)\r\nF1 OK [^\r]*\r\n$/);
            assert.match(await command(client, 'N1 NOOP'), /^\* 2 FETCH \(FLAGS \(\)\)\r\nN1 OK [^\r]*\r\n$/);
            client.close();
        });

        it('changes the held response with send, before and after', async () => {
            ctx.server.script.add({ on: 'response', command: 'FETCH', untagged: true, defer: 'tagged', send: '* $TAG late\r\n', after: '* 9 EXISTS\r\n' });
            const client = await loggedIn(ctx.port);
            await command(client, 'S1 SELECT INBOX');
            client.send('F1 FETCH 1 (FLAGS)\r\n');
            const output = await client.waitFor(/EXISTS\r\n$/);
            assert.match(output, /^F1 OK [^\r]*\r\n\* F1 late\r\n\* 9 EXISTS\r\n$/m);
            client.close();
        });

        it('holds an unsolicited response for the next command', async () => {
            ctx.server.script.add({ on: 'response', session: 1, untagged: true, match: /^\* 3 EXISTS/, defer: 'next' });
            const first = await loggedIn(ctx.port);
            const second = await loggedIn(ctx.port);
            await command(first, 'S1 SELECT INBOX');
            first.send('I1 IDLE\r\n');
            await first.waitFor(/^\+ idling\r\n/m);
            second.send('A1 APPEND INBOX {5}\r\n');
            await second.waitFor(/^\+ /m);
            second.send('hello\r\n');
            await second.waitFor(/^A1 OK/m);
            const idleStart = first.output().length;
            first.send('DONE\r\n');
            // the EXISTS belongs to IDLE, it goes with the answer to the command after it
            assert.doesNotMatch((await first.waitFor(/^I1 OK[^\r]*\r\n/m)).slice(idleStart), /EXISTS/);
            assert.match(await command(first, 'N1 NOOP'), /^\* 3 EXISTS\r\n[\s\S]*N1 OK/);
            first.close();
            second.close();
        });

        it('sends held responses with LOGOUT, the next command', async () => {
            ctx.server.script.add({ on: 'response', command: 'FETCH', untagged: true, defer: 'next' });
            const client = await loggedIn(ctx.port);
            await command(client, 'S1 SELECT INBOX');
            await command(client, 'F1 FETCH 1 (FLAGS)');
            client.send('O1 LOGOUT\r\n');
            const { output } = await client.closed();
            // LOGOUT is the next command, the held FETCH goes out before its BYE
            assert.match(output, /\* 1 FETCH \(FLAGS \(\)\)\r\n\* BYE[^\r]*\r\nO1 OK/);
            assert.strictEqual(client.socket.destroyed, true);
        });

        it('drops held responses when the connection closes', async () => {
            ctx.server.script.add({ on: 'response', command: 'FETCH', untagged: true, defer: 'next' });
            const client = await loggedIn(ctx.port);
            await command(client, 'S1 SELECT INBOX');
            await command(client, 'F1 FETCH 1 (FLAGS)');
            const [connection] = [...ctx.server.connections];
            assert.strictEqual(connection._deferredOutput?.length, 1);
            client.close();
            await client.closed();
            for (let i = 0; i < 20 && ctx.server.connections.size; i++) {
                await wait(10);
            }
            assert.strictEqual(connection._deferredOutput, null);
        });
    });

    describe('reset on TLS (#84)', () => {
        /** collects what a TLS socket receives and resolves with the output and the error once it is closed */
        const untilClosed = (socket: tls.TLSSocket, received: () => string) =>
            new Promise<{ output: string; error: NodeJS.ErrnoException | null }>((resolve, reject) => {
                let error: NodeJS.ErrnoException | null = null;
                const timer = setTimeout(() => reject(new Error('Connection still open, received:\n' + JSON.stringify(received()))), 3000);
                socket.on('error', err => {
                    error = err;
                });
                socket.on('close', () => {
                    clearTimeout(timer);
                    resolve({ output: received(), error });
                });
            });

        describe('STARTTLS', () => {
            const ctx = setupServer(() => ({ plugins: ['STARTTLS'] }));

            it('resets the TCP socket under the TLS layer', async () => {
                ctx.server.script.add({ on: 'command', command: 'CAPABILITY', nth: 2, drop: true, close: 'reset' });
                const client = await connectRaw(ctx.port);
                await client.waitFor(/^\* OK/);
                await command(client, 'C1 CAPABILITY');
                await command(client, 'T1 STARTTLS');
                client.socket.removeAllListeners('data');
                const secure = tls.connect({ socket: client.socket, rejectUnauthorized: false });
                let output = '';
                secure.on('data', chunk => {
                    output += chunk.toString('binary');
                });
                await new Promise(resolve => secure.once('secureConnect', resolve));
                const closed = untilClosed(secure, () => output);
                secure.write('C2 CAPABILITY\r\n');
                const result = await closed;
                assert.strictEqual(result.output, '');
                if (node) {
                    assert.strictEqual(result.error?.code, 'ECONNRESET');
                }
            });
        });

        describe('implicit TLS', () => {
            const ctx = setupServer(() => ({ secureConnection: true }));

            it('resets the TCP socket of a TLS connection', async () => {
                ctx.server.script.add({ on: 'command', command: 'NOOP', close: 'reset' });
                const secure = tls.connect({ port: ctx.port, host: 'localhost', rejectUnauthorized: false });
                let output = '';
                secure.on('data', chunk => {
                    output += chunk.toString('binary');
                    if (/^\* OK[^\r]*\r\n$/.test(output)) {
                        secure.write('N1 NOOP\r\n');
                    }
                });
                const result = await untilClosed(secure, () => output);
                assert.match(result.output, /^\* OK[^\r]*\r\n$/);
                if (node) {
                    assert.strictEqual(result.error?.code, 'ECONNRESET');
                }
            });
        });
    });
});
