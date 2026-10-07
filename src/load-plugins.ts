import { plugins as builtinPlugins } from './plugins/index.js';
import type { IMAPServer, Plugin } from './types.js';

// Capability spellings that do not match a plugin file name
const ALIASES: Record<string, string> = {
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

/**
 * Lists the names of the built-in plugins (file names without extension)
 *
 * @return {Array} plugin names
 */
function listPlugins(): string[] {
    return Object.keys(builtinPlugins);
}

/**
 * Resolves a plugin name, as given in options.plugins, to a built-in plugin
 *
 * @param {String} name Plugin name, eg. "IDLE" or "LITERAL+"
 * @return {String|false} Resolved plugin name or false if no such plugin exists
 */
function resolvePlugin(name: string): string | false {
    let key = String(name).trim().toLowerCase();
    if (Object.hasOwn(ALIASES, key)) {
        key = ALIASES[key];
    }
    return Object.hasOwn(builtinPlugins, key) ? key : false;
}

/**
 * Loads plugins for a server instance. Built-in plugins are referenced by name,
 * custom plugins are functions. Unknown names throw, repeated plugins are loaded only once.
 * A plugin that needs another plugin lists its name in `plugin.requires`, the required
 * plugin is then loaded first. Once every plugin is loaded, the server emits `pluginsLoaded`: a plugin
 * that has to wrap what other plugins set up (commands, output handlers), whatever the load order,
 * does that in a `server.once('pluginsLoaded', ...)` listener. Listeners run in plugin load order.
 *
 * @param {Object} server IMAPServer instance
 * @param {Array|String|Function} plugins List of plugins to load
 */
function loadPlugins(server: IMAPServer, plugins: (string | Plugin)[] | string | Plugin | null | undefined): void {
    const loaded = new Set<Plugin>();

    const load = (entry: string | Plugin) => {
        let plugin = entry;
        if (typeof plugin === 'string') {
            const name = resolvePlugin(plugin);
            if (!name) {
                throw new Error('Unknown plugin "' + plugin + '". Available plugins: ' + listPlugins().join(', '));
            }
            plugin = builtinPlugins[name];
        }

        if (typeof plugin !== 'function') {
            throw new TypeError('Invalid plugin, expecting a plugin name or a function');
        }

        if (loaded.has(plugin)) {
            return;
        }
        loaded.add(plugin);

        ([] as string[]).concat(plugin.requires || []).forEach(load);

        plugin(server);
    };

    ([] as (string | Plugin)[]).concat(plugins || []).forEach(load);

    server.emit('pluginsLoaded');
}

export default loadPlugins;

export { listPlugins };
