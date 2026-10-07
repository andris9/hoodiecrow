// Loads the compiled output in dist/ (npm run build) through the package.json exports map, the way
// an installed copy of the package is loaded. Node resolves the package name to the package itself
// when the specifier is used from inside the package.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const built = fs.existsSync(path.join(root, 'dist', 'cjs', 'index.js'));

// a non-literal specifier keeps TypeScript from resolving the built types, dist/ may not exist yet
const packageName: string = 'imapkit';

const listen = (server: any) => new Promise<number>(resolve => server.listen(0, () => resolve(server.address().port)));
const close = (server: any) => new Promise<void>(resolve => server.close(() => resolve()));

describe('Built package', { skip: !built && 'run npm run build first' }, () => {
    it('ships both module formats with type declarations', () => {
        for (const format of ['esm', 'cjs']) {
            for (const name of ['index', 'server', 'types', 'plugins/idle', 'commands/fetch']) {
                assert.ok(fs.existsSync(path.join(root, 'dist', format, name + '.js')), format + ' ' + name);
                assert.ok(fs.existsSync(path.join(root, 'dist', format, name + '.d.ts')), format + ' ' + name + ' declarations');
            }
        }
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'dist', 'cjs', 'package.json'), 'utf8')), { type: 'commonjs' });
    });

    it('keeps the CommonJS shape of require("imapkit")', async () => {
        const imapkit = require(packageName);
        assert.equal(typeof imapkit, 'function');
        assert.equal(imapkit.default, imapkit);
        assert.ok(imapkit.TAG_REGEX instanceof RegExp);
        assert.equal(typeof imapkit.IMAPServer, 'function');
        // the old entry point path
        assert.equal(require(packageName + '/lib/server'), imapkit);

        const server = imapkit({ plugins: ['IDLE'] });
        assert.ok(server instanceof imapkit.IMAPServer);
        await listen(server);
        await close(server);
    });

    it('keeps the CommonJS shape of the modules under lib/', () => {
        // a module with a default export loads as that export, with its named exports as properties
        const mailboxName = require(packageName + '/lib/mailbox-name');
        assert.equal(typeof mailboxName, 'function');
        assert.equal(mailboxName.encode('Ä'), '&AMQ-');
        const idle = require(packageName + '/lib/plugins/idle');
        assert.equal(typeof idle, 'function');
        assert.deepEqual(require(packageName + '/lib/plugins/qresync').requires, ['ENABLE', 'CONDSTORE']);
        // a module with only named exports loads as the exports object
        assert.equal(typeof require(packageName + '/lib/command-states').states.AUTHENTICATED, 'object');
    });

    it('loads as an ES module', async () => {
        const mod = await import(packageName);
        assert.equal(typeof mod.default, 'function');
        assert.equal(mod.TAG_REGEX, mod.default.TAG_REGEX);
        const server = mod.default();
        assert.ok(server instanceof mod.IMAPServer);
        await listen(server);
        await close(server);
    });
});
