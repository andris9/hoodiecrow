#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const imapkit = require('../lib/server');
const packageData = require('../package.json');

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
        plugin: { type: 'string', multiple: true },
        smtpPort: { type: 'string' }
    }
});

const isTrue = value => (value || '').toString().trim().toLowerCase() === 'true';

const configLocation = argv.config || process.env.IMAPKIT_CONFIG;
const storageLocation = argv.storage || process.env.IMAPKIT_STORAGE;
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
    const pluginsDir = path.join(__dirname, '..', 'lib', 'plugins');

    const plugins = fs.readdirSync(pluginsDir).map(fileName => {
        const file = fs.readFileSync(path.join(pluginsDir, fileName), 'utf-8');
        return {
            key: fileName.replace(/\.js$/i, '').toUpperCase(),
            value: Array.from(file.matchAll(/@help (.*)/gim), match => match[1])
        };
    });

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
        require('../lib/smtp-listener').startSMTPServer(smtpPort, server);
    }
}
