'use strict';

const { beforeEach, afterEach } = require('node:test');
const hoodiecrow = require('../../lib/server');
const mockClient = require('../../lib/mock-client');

/**
 * Registers hooks that start a fresh server on a random port before every
 * test of the enclosing `describe` block and close it afterwards.
 *
 * @param {Function} [getOptions] returns the server options, called for every test so that each server gets its own storage
 * @return {Object} context with the current `server` and a `run(commands, callback)` helper that replays commands against it
 */
function setupServer(getOptions) {
    const ctx = {
        server: null,
        run(commands, callback) {
            mockClient(ctx.server.address().port, 'localhost', commands, false, callback);
        }
    };

    beforeEach((t, done) => {
        ctx.server = hoodiecrow(getOptions && getOptions());
        ctx.server.listen(0, done);
    });

    afterEach((t, done) => {
        ctx.server.close(done);
    });

    return ctx;
}

module.exports = { setupServer };
