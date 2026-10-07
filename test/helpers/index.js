'use strict';

const { beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert');
const imapkit = require('../../lib/server');
const mockClient = require('../../lib/mock-client');
const { validateThen } = require('./validate-responses');

/**
 * Registers hooks that start a fresh server on a random port before every
 * test of the enclosing `describe` block and close it afterwards.
 *
 * @param {Function} [getOptions] returns the server options, called for every test so that each server gets its own storage
 * @return {Object} context with the current `server` and a `run(commands, callback)` helper that replays commands against it.
 *         Every transcript is checked with the response grammar guardrail before `callback` gets it.
 */
function setupServer(getOptions) {
    const ctx = {
        server: null,
        run(commands, callback) {
            mockClient(ctx.server.address().port, 'localhost', commands, false, resp => validateThen(resp, () => callback(resp)));
        }
    };

    // every server that was started, Node 22 skips afterEach for a test that calls t.skip()
    const servers = new Set();
    const closeServer = (server, done) => {
        servers.delete(server);
        if (!server.server.listening) {
            return done();
        }
        server.close(() => done());
    };

    beforeEach((t, done) => {
        ctx.server = imapkit(getOptions && getOptions());
        servers.add(ctx.server);
        ctx.server.listen(0, done);
    });

    afterEach((t, done) => {
        closeServer(ctx.server, done);
    });

    // close whatever afterEach did not get to
    after((t, done) => {
        const left = [...servers];
        let pending = left.length;
        if (!pending) {
            return done();
        }
        left.forEach(server => closeServer(server, () => --pending || done()));
    });

    return ctx;
}

/**
 * Checks the tagged result of every listed command in a transcript
 *
 * @param {String} resp Transcript as a binary string
 * @param {Object} expected Tag to the expected result, e.g. `{ A1: 'OK', A2: 'BAD' }`
 */
function assertTagged(resp, expected) {
    for (const tag of Object.keys(expected)) {
        const match = resp.match(new RegExp('^' + tag + ' (OK|NO|BAD)\\b', 'm'));
        assert.ok(match, 'no tagged response for ' + tag + '\n' + resp);
        assert.strictEqual(match[1], expected[tag], tag + ' answered ' + match[1] + '\n' + resp);
    }
}

module.exports = { setupServer, assertTagged };
