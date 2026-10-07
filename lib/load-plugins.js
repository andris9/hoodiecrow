'use strict';

const fs = require('fs');
const path = require('path');

const PLUGINS_DIR = path.join(__dirname, 'plugins');

// Capability spellings that do not match a plugin file name
const ALIASES = {
    'literal+': 'literalplus',
    'literal-': 'literalminus',
    'compress=deflate': 'compress',
    'auth=plain': 'auth-plain',
    'auth=xoauth2': 'xoauth2',
    'status=size': 'status-size',
    'sort=display': 'sort-display',
    'thread=orderedsubject': 'thread-orderedsubject',
    'thread=references': 'thread-references',
    'auth=oauthbearer': 'oauthbearer',
    'utf8=accept': 'utf8-accept',
    'context=search': 'context-search',
    'context=sort': 'context-sort'
};

let available = null;

/**
 * Lists the names of the built-in plugins (file names without extension)
 *
 * @return {Array} plugin names
 */
function listPlugins() {
    if (!available) {
        available = fs
            .readdirSync(PLUGINS_DIR)
            .filter(fileName => /\.js$/.test(fileName))
            .map(fileName => fileName.replace(/\.js$/, ''));
    }
    return available;
}

/**
 * Resolves a plugin name, as given in options.plugins, to a built-in plugin
 *
 * @param {String} name Plugin name, eg. "IDLE" or "LITERAL+"
 * @return {String|false} Resolved plugin name or false if no such plugin exists
 */
function resolvePlugin(name) {
    let key = String(name).trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(ALIASES, key)) {
        key = ALIASES[key];
    }
    return listPlugins().includes(key) ? key : false;
}

/**
 * Loads plugins for a server instance. Built-in plugins are referenced by name,
 * custom plugins are functions. Unknown names throw, repeated plugins are loaded only once.
 * A plugin that needs another plugin lists its name in `plugin.requires`, the required
 * plugin is then loaded first.
 *
 * @param {Object} server IMAPServer instance
 * @param {Array|String|Function} plugins List of plugins to load
 */
function loadPlugins(server, plugins) {
    const loaded = new Set();

    const load = plugin => {
        if (typeof plugin === 'string') {
            const name = resolvePlugin(plugin);
            if (!name) {
                throw new Error('Unknown plugin "' + plugin + '". Available plugins: ' + listPlugins().join(', '));
            }
            plugin = require(path.join(PLUGINS_DIR, name));
        }

        if (typeof plugin !== 'function') {
            throw new TypeError('Invalid plugin, expecting a plugin name or a function');
        }

        if (loaded.has(plugin)) {
            return;
        }
        loaded.add(plugin);

        [].concat(plugin.requires || []).forEach(load);

        plugin(server);
    };

    [].concat(plugins || []).forEach(load);
}

module.exports = loadPlugins;
