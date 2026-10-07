#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import imapkit from '../dist/esm/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));

// Non-strict so that boolean flags also accept an explicit value (`--secure=true`)
const { values: argv } = parseArgs({
    strict: false,
    options: {
        port: { type: 'string', short: 'p' },
        secure: { type: 'boolean', short: 's' },
        debug: { type: 'boolean', short: 'd' },
        help: { type: 'boolean', short: 'h' },
        config: { type: 'string' },
        storage: { type: 'string' },
        script: { type: 'string' },
        plugin: { type: 'string', multiple: true },
        smtpPort: { type: 'string' }
    }
});

const isTrue = value => (value || '').toString().trim().toLowerCase() === 'true';

const configLocation = argv.config || process.env.IMAPKIT_CONFIG;
const storageLocation = argv.storage || process.env.IMAPKIT_STORAGE;
const scriptLocation = argv.script || process.env.IMAPKIT_SCRIPT;
const smtpPort = argv.smtpPort || process.env.IMAPKIT_SMTPPORT;
const pluginsList = []
    .concat(argv.plugin || process.env.IMAPKIT_PLUGINS || [])
    .flatMap(plugin =>
        String(plugin)
            .toUpperCase()
            .trim()
            .split(/\s*,\s*/)
    )
    .filter(Boolean);
const secure = isTrue(argv.secure || process.env.IMAPKIT_SECURE);
const debug = isTrue(argv.debug || process.env.IMAPKIT_DEBUG);

let config = {};

if (configLocation) {
    config = JSON.parse(fs.readFileSync(configLocation, 'utf-8'));
}

if (storageLocation) {
    config.storage = JSON.parse(fs.readFileSync(storageLocation, 'utf-8'));
}

if (scriptLocation) {
    config.script = JSON.parse(fs.readFileSync(scriptLocation, 'utf-8'));
}

if (pluginsList.length) {
    config.plugins = pluginsList;
}

if (secure) {
    config.secureConnection = true;
}

if (debug) {
    config.debug = true;
}

const port = argv.port || process.env.IMAPKIT_PORT || config.port || (secure ? 993 : 143);

if (argv.help) {
    const help = fs.readFileSync(path.join(__dirname, 'help.txt'), 'utf-8');
    // the @help lines of every plugin, collected by the build (scripts/build.js)
    const pluginHelp = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dist', 'plugin-help.json'), 'utf-8'));
    const plugins = Object.keys(pluginHelp).map(key => ({ key, value: pluginHelp[key] }));

    const indent = Math.max(0, ...plugins.map(plugin => plugin.key.length)) + 2;
    const pluginText = plugins.flatMap(plugin => [
        ' ' + plugin.key.padEnd(indent - 1) + (plugin.value[0] || ''),
        ...plugin.value.slice(1).map(line => ' '.repeat(indent) + line)
    ]);

    console.log(
        help
            .replace(/__PLUGINS__/g, pluginText.join('\n'))
            .replace(/__VERSION__/g, packageData.version)
            .replace(/__VBAR__/g, '='.repeat(packageData.version.length))
            .replace(/__HOMEPAGE__/g, packageData.homepage)
            .replace(/__BUGS__/g, packageData.bugs.url)
            .trim()
    );
} else {
    const server = imapkit(config);
    console.log('Starting ImapKit ...');
    server.server.on('error', err => {
        console.error('Failed to start ImapKit on port %s: %s', port, err.message);
        process.exit(1);
    });
    server.listen(port, () => {
        console.log('ImapKit successfully%s listening on port %s', secure ? ' and securely' : '', port);
    });

    if (smtpPort) {
        // loaded on demand, smtp-server is only needed when SMTP is enabled
        import('../dist/esm/smtp-listener.js').then(({ startSMTPServer }) => startSMTPServer(smtpPort, server));
    }
}
