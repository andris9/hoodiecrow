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
 * @param {Map} [exclude] Plugins a quirk preset leaves out, plugin name to quirk name
 * @throws {Error} when a loaded plugin requires an excluded one
 */
function loadPlugins(server: IMAPServer, plugins: (string | Plugin)[] | string | Plugin | null | undefined, exclude?: Map<string, string>): void {
    const loaded = new Set<Plugin>();
    // plugins a quirk preset leaves out (no-move), they are not loaded even when listed, and the quirk that removes them
    const excluded = new Map<Plugin, string>();
    (exclude || new Map<string, string>()).forEach((quirk, name) => {
        const resolved = resolvePlugin(name);
        if (resolved) {
            excluded.set(builtinPlugins[resolved], quirk);
        }
    });

    const load = (entry: string | Plugin) => {
        let plugin = entry;
        if (typeof plugin === 'string') {
            const name = resolvePlugin(plugin);
            if (!name && plugin.toUpperCase() === 'XTOYBIRD') {
                throw new Error(
                    'XTOYBIRD was removed in 5.0.0, use the control API (server.control.snapshot(), server.control.addUser() ...) instead, see the README'
                );
            }
            if (!name) {
                throw new Error('Unknown plugin "' + plugin + '". Available plugins: ' + listPlugins().join(', '));
            }
            plugin = builtinPlugins[name];
        }

        if (typeof plugin !== 'function') {
            throw new TypeError('Invalid plugin, expecting a plugin name or a function');
        }

        if (loaded.has(plugin) || excluded.has(plugin)) {
            return;
        }
        loaded.add(plugin);

        const requires = ([] as string[]).concat(plugin.requires || []);
        requires.forEach(name => {
            const required = resolvePlugin(name);
            const quirk = required && excluded.get(builtinPlugins[required]);
            if (quirk) {
                // the plugin can not work without it (IMAP4rev2 folds in MOVE and UIDPLUS, RFC 9051 Appendix E), so
                // advertising it without the required plugin would break its RFC
                throw new Error((typeof entry === 'string' ? entry.trim() : plugin.name) + ' requires ' + name + ', which the "' + quirk + '" quirk removes');
            }
        });
        requires.forEach(load);

        plugin(server);
    };

    ([] as (string | Plugin)[]).concat(plugins || []).forEach(load);

    server.emit('pluginsLoaded');
}

export default loadPlugins;

export { listPlugins };
