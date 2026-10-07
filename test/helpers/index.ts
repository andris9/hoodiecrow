import { beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert';
import imapkit from '../../src/server.js';
import mockClient from '../../src/mock-client.js';
import { validateThen } from './validate-responses.js';
import type { AddressInfo } from 'node:net';
import type { IMAPServer } from '../../src/server.js';
import type { IMAPServerOptions } from '../../src/types.js';

/** The context setupServer() returns, `server` is the server of the running test */
export interface TestContext {
    server: IMAPServer;
    /** the port the server of the running test listens on */
    readonly port: number;
    /** replays the commands, `resp` is the transcript (a Buffer, tests usually turn it into a string) */
    run(commands: string[], callback: (resp: any) => void): void;
}

/**
 * Registers hooks that start a fresh server on a random port before every
 * test of the enclosing `describe` block and close it afterwards.
 *
 * @param {Function} [getOptions] returns the server options, called for every test so that each server gets its own storage
 * @return {Object} context with the current `server` and a `run(commands, callback)` helper that replays commands against it.
 *         Every transcript is checked with the response grammar guardrail before `callback` gets it.
 */
function setupServer(getOptions?: () => IMAPServerOptions): TestContext {
    const ctx: TestContext = {
        server: null as unknown as IMAPServer,
        get port() {
            return (ctx.server.address() as AddressInfo).port;
        },
        run(commands, callback) {
            mockClient(ctx.port, 'localhost', commands, false, resp => validateThen(resp, () => callback(resp)));
        }
    };

    // every server that was started, Node 22 skips afterEach for a test that calls t.skip()
    const servers = new Set<IMAPServer>();
    const closeServer = (server: IMAPServer, done: () => void) => {
        servers.delete(server);
        if (!server.server.listening) {
            return done();
        }
        server.close(() => done());
    };

    // the hooks return promises, Deno does not pass a done callback to node:test hooks
    beforeEach(
        () =>
            new Promise<void>(resolve => {
                ctx.server = imapkit(getOptions && getOptions());
                servers.add(ctx.server);
                ctx.server.listen(0, () => resolve());
            })
    );

    afterEach(() => new Promise<void>(resolve => closeServer(ctx.server, resolve)));

    // close whatever afterEach did not get to
    after(() => Promise.all([...servers].map(server => new Promise<void>(resolve => closeServer(server, resolve)))));

    return ctx;
}

/**
 * Checks the tagged result of every listed command in a transcript
 *
 * @param {String} resp Transcript as a binary string
 * @param {Object} expected Tag to the expected result, e.g. `{ A1: 'OK', A2: 'BAD' }`
 */
function assertTagged(resp: string, expected: Record<string, string>): void {
    for (const tag of Object.keys(expected)) {
        const match = resp.match(new RegExp('^' + tag + ' (OK|NO|BAD)\\b', 'm'));
        assert.ok(match, 'no tagged response for ' + tag + '\n' + resp);
        assert.strictEqual(match[1], expected[tag], tag + ' answered ' + match[1] + '\n' + resp);
    }
}

export { setupServer, assertTagged };
