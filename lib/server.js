'use strict';

const Stream = require('stream').Stream;
const util = require('util');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const imapHandler = require('imap-handler');
const formalSyntax = require('imap-handler/lib/formal');
const loadPlugins = require('./load-plugins');
const { getCommandOptions, commandOptions } = require('./command-states');
const validateMailboxName = require('./mailbox-name');
const { MONTHS, monthIndex, isRealDate } = require('./dates');
const fetchHandlers = require('./commands/handlers/fetch');
const { hasSequenceSetKey } = require('./commands/handlers/search');

// longest command line (not counting literals) accepted from a client
const MAX_LINE_LENGTH = 1024 * 1024;
// largest literal accepted after login, override with the maxLiteralSize option
const MAX_LITERAL_SIZE = 64 * 1024 * 1024;
// largest literal accepted before login, enough for any user name or password
const MAX_PREAUTH_LITERAL_SIZE = 64 * 1024;
const LITERAL_TOO_LARGE = 'Literal too large';
// status responses, their text must follow the RFC 3501 section 9 resp-text rules
const STATUS_RESPONSES = new Set(['OK', 'NO', 'BAD', 'BYE', 'PREAUTH']);
// RFC 3501 section 9: tag = 1*<any ASTRING-CHAR except "+">
const TAG_REGEX = new RegExp('^[' + formalSyntax.tag().replace(/[\\\]^-]/g, '\\$&') + ']+$');
// RFC 3501 section 9: atom = 1*ATOM-CHAR
const ATOM_REGEX = new RegExp('^[' + formalSyntax['ATOM-CHAR']().replace(/[\\\]^-]/g, '\\$&') + ']+$');
// failed command handler lookups that are remembered, so unknown commands are not looked up on disk again
const MAX_MISSING_COMMANDS = 1000;

/**
 * Returns the tag to use when answering a raw command line that could not be parsed. A line
 * without a valid tag is answered untagged, a client could not parse the invalid tag anyway.
 *
 * @param {String} line Raw command line
 * @return {String} tag or "*"
 */
function getResponseTag(line) {
    // only SP separates the tag (RFC 3501 section 9: command = tag SP ...)
    const space = line.indexOf(' ');
    const tag = space >= 0 ? line.substr(0, space) : line;
    return tag && TAG_REGEX.test(tag) ? tag : '*';
}

/**
 * Text for a command that is not valid in the current connection state
 *
 * @param {String} command Upper case command name
 * @param {String} state Connection state
 * @return {String} Error text
 */
function stateError(command, state) {
    return command + ' is not allowed in the ' + state + ' state';
}

/**
 * Creates an error for a failed mailbox operation, with a RFC 5530 response code
 *
 * @param {String} message Error message
 * @param {String} code Response code, e.g. "ALREADYEXISTS"
 * @return {Error} Error object
 */
function mailboxError(message, code) {
    const err = new Error(message);
    err.code = code;
    return err;
}

module.exports = function (options) {
    return new IMAPServer(options);
};
module.exports.TAG_REGEX = TAG_REGEX;

function IMAPServer(options) {
    Stream.call(this);

    // shallow copy, so that the caller's options object is never modified
    this.options = Object.assign({}, options);

    if (this.options.secureConnection) {
        this.server = tls.createServer(this.getCredentials(), this.createClient.bind(this));
    } else {
        this.server = net.createServer(this.createClient.bind(this));
    }

    // every connection listens to the notify event
    this.setMaxListeners(0);
    this.connections = new Set();

    this.connectionHandlers = [];
    // run when a connection returns to the Not Authenticated state (UNAUTHENTICATE), each one
    // clears the per-session state its plugin keeps on the connection
    this.resetHandlers = [];
    this.outputHandlers = [];
    this.messageHandlers = [];
    this.fetchHandlers = {};
    this.fetchFilters = [];
    this.searchHandlers = {};
    this.storeHandlers = {};
    this.storeFilters = [];
    // `filter(connection, notification)` functions, a notification only reaches connections they all accept
    this.notifyFilters = [];
    // run on every mailbox in processMailbox, like messageHandlers for messages
    this.mailboxHandlers = [];
    // consulted before messages are added to a mailbox by APPEND, COPY or MOVE, see IMAPConnection#checkAppend
    this.appendChecks = [];
    // carry properties over when a message is copied to another mailbox (COPY, MOVE, RENAME INBOX), see copyMessage
    this.copyHandlers = [];
    // append-data extensions such as CATENATE (RFC 4466 section 2.7), and checks that can refuse
    // a synchronizing literal before it is read, see IMAPConnection#checkLiteral
    this.appendDataHandlers = Object.create(null);
    this.literalFilters = [];
    // can refuse IMAP URLs that read a mailbox (CATENATE), `(connection, mailbox, url)` returns `{ text }` to refuse
    this.urlAccessChecks = [];
    // can leave mailboxes out of a search of several mailboxes (ESEARCH of MULTISEARCH), `(connection, mailbox, named)`
    // returns false for a mailbox that is skipped, `named` is true if the client gave its name
    this.searchAccessChecks = [];
    // run before a command handler, `(connection, parsed)` returns `{ command, code, text }` to refuse the command
    // (e.g. commands with message sequence numbers after ENABLE UIDONLY), see IMAPConnection#processQueue
    this.commandChecks = [];
    // `(connection, parsed, range)` functions that can cut the messages that FETCH, STORE, COPY, MOVE and UID EXPUNGE
    // (and the UID variants) operate on, e.g. MESSAGELIMIT. See IMAPConnection#limitRange
    this.rangeLimits = [];
    // `(connection, messages, query)` functions that can narrow down the messages a SEARCH (or SORT, THREAD) looks
    // at by returning a shorter list, e.g. MESSAGELIMIT. See commands/handlers/search.js
    this.searchLimits = [];
    // `check(connection)` functions, SELECT and EXAMINE send `* OK [CLOSED]` when they close the selected mailbox
    // if any of them is true (CONDSTORE, RFC 7162 section 3.2.11, IMAP4rev2, RFC 9051 section 6.3.2)
    this.closedChecks = [];
    // set by MULTIAPPEND (RFC 3502), otherwise APPEND takes a single message
    this.multiAppend = false;
    this.commandHandlers = {};
    // options of commands that plugins add, core commands are listed in command-states.js
    this.commandOptions = Object.create(null);
    // commands without a handler, so that they are not looked up again
    this.missingCommands = new Set();
    this.capabilities = {};
    this.allowedStatus = ['MESSAGES', 'RECENT', 'UIDNEXT', 'UIDVALIDITY', 'UNSEEN'];
    // values of STATUS items that plugins add, consulted before the built-in items in commands/handlers/status.js
    this.statusHandlers = {};
    // non-synchronizing literals {n+} are accepted when literalPlus is set (LITERAL+ and LITERAL-),
    // up to nonSyncLiteralLimit octets (4096 for LITERAL-, RFC 7888 section 5)
    this.literalPlus = false;
    this.nonSyncLiteralLimit = Infinity;
    // extra options for the imap-handler command parser, e.g. literal8 for BINARY
    this.parserOptions = {
        // items that take a [section] and <partial>, the imap-handler default
        allowSection: ['BODY', 'BODY.PEEK']
    };
    this.referenceNamespace = false;
    // the session whose command is running, see IMAPServer#notify
    this.activeConnection = null;

    // users and storage are deep copied, so that runtime changes never leak into
    // the caller's objects or into other servers built from the same fixture.
    // Without a prototype, user names like "__proto__" or "toString" are plain keys
    this.users = Object.assign(
        Object.create(null),
        this.options.users
            ? structuredClone(this.options.users)
            : {
                  testuser: {
                      password: 'testpass',
                      xoauth2: {
                          accessToken: 'testtoken',
                          sessionTimeout: 3600 * 1000
                      }
                  }
              }
    );

    loadPlugins(this, this.options.plugins);

    this.systemFlags = [].concat(this.options.systemFlags || ['\\Answered', '\\Flagged', '\\Draft', '\\Deleted', '\\Seen']);
    this.storage = this.options.storage
        ? structuredClone(this.options.storage)
        : {
              INBOX: {},
              '': {}
          };
    this.uidvalidityCounter = 0; // highest UIDVALIDITY in use, new mailboxes get a higher one
    // subscribed mailbox names (RFC 3501 section 6.3.6). Names, not mailboxes: a subscription outlives
    // DELETE and stays with the old name on RENAME (RFC 9051 section 6.3.6), see trackSubscription
    this.subscriptions = new Set();
    this.folderCache = Object.create(null);
    this.indexFolders(true);
}
util.inherits(IMAPServer, Stream);

IMAPServer.prototype.listen = function () {
    const args = Array.prototype.slice.call(arguments);
    this.server.listen.apply(this.server, args);
};

IMAPServer.prototype.close = function (callback) {
    this.server.close(callback);
    // close() only completes once all connections are gone
    this.connections.forEach(connection => {
        if (connection.socket) {
            connection.socket.destroy();
        }
    });
};

/**
 * Returns TLS key and certificate. The bundled self-signed certificate is only
 * read from disk when TLS is actually used.
 *
 * @return {Object} TLS options
 */
IMAPServer.prototype.getCredentials = function () {
    if (!this.options.credentials) {
        this.options.credentials = {
            key: fs.readFileSync(__dirname + '/../cert/server.key'),
            cert: fs.readFileSync(__dirname + '/../cert/server.crt')
        };
    }
    return this.options.credentials;
};

IMAPServer.prototype.address = function () {
    return this.server.address();
};

IMAPServer.prototype.createClient = function (socket) {
    const connection = new IMAPConnection(this, socket);
    this.connectionHandlers.forEach(handler => {
        handler(connection);
    });
};

IMAPServer.prototype.registerCapability = function (keyword, handler) {
    this.capabilities[keyword] =
        handler ||
        function () {
            return true;
        };
};

/**
 * Sets the handler of a command
 *
 * @param {String} command Command name, e.g. "UID MOVE"
 * @param {Function} handler Command handler `(connection, parsed, data, callback)`
 * @param {Object|Array} [options] `{ states, noArguments, mailboxArguments, searchCriteria, noExpunge, literal8 }`:
 *   the connection states the command is valid in (any state if not set), if it takes no arguments, the
 *   positions of its mailbox name arguments, the position where its search criteria start, if EXPUNGE responses
 *   are not allowed while it runs, and if it accepts literal8 arguments (true, or the name of the capability that
 *   allows them). A list is read as the states. Without
 *   options, a command keeps its earlier settings
 */
IMAPServer.prototype.setCommandHandler = function (command, handler, options) {
    command = (command || '').toString().toUpperCase();
    this.commandHandlers[command] = handler;
    this.missingCommands.delete(command);
    if (options) {
        this.commandOptions[command] = commandOptions(options);
    }
};

/**
 * Returns the options of a command, see setCommandHandler
 *
 * @param {String} command Command name
 * @return {Object} `{ states, noArguments, mailboxArguments, searchCriteria, noExpunge, literal8 }`, states is false if any state is fine
 */
IMAPServer.prototype.getCommandOptions = function (command) {
    command = (command || '').toString().toUpperCase();
    return this.commandOptions[command] || getCommandOptions(command) || commandOptions();
};

/**
 * Returns the connection states a command may be used in
 *
 * @param {String} command Command name
 * @return {Array|Boolean} List of states, or false if any state is fine
 */
IMAPServer.prototype.getCommandStates = function (command) {
    return this.getCommandOptions(command).states;
};

/**
 * Returns a user account
 *
 * @param {String} username User name
 * @return {Object|false} User data or false if there is no such user
 */
IMAPServer.prototype.getUser = function (username) {
    return (typeof username === 'string' && this.users[username]) || false;
};

/**
 * Returns a mailbox object from folderCache
 *
 * @param {String} path Pathname for the mailbox
 * @return {Object} mailbox object or undefined
 */
IMAPServer.prototype.getMailbox = function (path) {
    if (path.toUpperCase() === 'INBOX') {
        return this.folderCache.INBOX;
    }
    return this.folderCache[path];
};

/**
 * Schedules a notifying message
 *
 * @param {Object} command An object of untagged response message
 * @param {Object|String} mailbox Mailbox the message is related to
 * @param {Object} ignoreConnection if set the selected connection ignores this notification
 * @param {Function} [filter] if set, only connections for which `filter(connection)` is true get the notification
 */
IMAPServer.prototype.notify = function (command, mailbox, ignoreConnection, filter) {
    command.notification = true;
    this.emit('notify', {
        command: command,
        mailbox: mailbox,
        ignoreConnection: ignoreConnection,
        filter: filter,
        // the session whose command caused the change, null for changes from outside (e.g. SMTP)
        origin: this.activeConnection
    });
};

/**
 * Tells plugins that a mailbox was created, deleted, renamed, subscribed or unsubscribed, with a
 * `mailbox` event: `{ type, path, oldPath, mailbox, origin }`. `type` is "create", "delete", "rename",
 * "subscribe" or "unsubscribe", `origin` is the session that made the change
 *
 * @param {String} type Kind of change
 * @param {String} path Storage name of the mailbox
 * @param {Object} [details] `{ oldPath, mailbox }`: the earlier name of a renamed mailbox, the mailbox
 *   object that a DELETE removed
 */
IMAPServer.prototype.mailboxChanged = function (type, path, details) {
    this.emit('mailbox', Object.assign({ type, path, oldPath: null, mailbox: null }, details, { origin: this.activeConnection }));
};

/**
 * Retrieves a function for an IMAP command. If the command is not cached
 * tries to load it from a file in the commands directory
 *
 * @param {String} command Command name
 * @return {Function} handler for the specified command
 */
IMAPServer.prototype.getCommandHandler = function (command) {
    command = (command || '').toString().toUpperCase();

    // try to autoload if not supported
    if (!this.commandHandlers[command] && !this.missingCommands.has(command)) {
        try {
            this.commandHandlers[command] = require('./commands/' + command.toLowerCase());
        } catch {
            if (this.missingCommands.size >= MAX_MISSING_COMMANDS) {
                this.missingCommands.clear();
            }
            this.missingCommands.add(command);
        }
    }

    return this.commandHandlers[command] || false;
};

/**
 * Returns some useful information about a mailbox that can be used with STATUS, SELECT and EXAMINE
 *
 * @param {Object|String} mailbox Mailbox object or path
 */
IMAPServer.prototype.getStatus = function (mailbox) {
    if (typeof mailbox === 'string') {
        mailbox = this.getMailbox(mailbox);
    }
    if (!mailbox) {
        return false;
    }

    const flags = {};
    let seen = 0;
    let unseen = 0;
    // flags stay defined in the mailbox once a message had them, see rememberFlags
    const permanentFlags = [].concat(mailbox.permanentFlags || []);
    (mailbox.knownFlags || []).forEach(flag => this.ensureFlag(permanentFlags, flag));

    let recent = 0;
    // \Recent sets of the sessions that have this mailbox selected
    const recentSets = [];
    this.connections.forEach(connection => {
        if (connection.selectedMailbox === mailbox && connection.recent) {
            recentSets.push(connection.recent);
        }
    });

    mailbox.messages.forEach(message => {
        if (message.flags.indexOf('\\Seen') < 0) {
            unseen++;
        } else {
            seen++;
        }

        if (message.recent || recentSets.some(set => set.has(message))) {
            recent++;
        }

        message.flags.forEach(flag => {
            if (!flags[flag]) {
                flags[flag] = 1;
            } else {
                flags[flag]++;
            }

            if (permanentFlags.indexOf(flag) < 0) {
                permanentFlags.push(flag);
            }
        });
    });

    return {
        flags: flags,
        seen: seen,
        unseen: unseen,
        recent: recent,
        permanentFlags: permanentFlags
    };
};

/**
 * Validates a date value. Useful for validating APPEND dates
 *
 * @param {String} date Date value to be validated
 * @return {Boolean} Returns true if the date string is in IMAP date-time format
 */
IMAPServer.prototype.validateInternalDate = function (date) {
    if (!date || typeof date !== 'string') {
        return false;
    }
    // date-time from RFC 3501 section 9, month names are case-insensitive like all ABNF strings
    const match = date.match(/^( \d|\d\d)-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{4}) (\d{2}):(\d{2}):(\d{2}) [-+](\d{2})(\d{2})$/i);
    if (!match) {
        return false;
    }

    // the values must also make a real date and time
    return (
        isRealDate(match[1], monthIndex(match[2]), match[3]) && Number(match[4]) < 24 && Number(match[5]) < 60 && Number(match[6]) < 61 && Number(match[8]) < 60
    );
};

/**
 * Converts a date object to a valid date-time string format
 *
 * @param {Object} date Date object to be converted
 * @return {String} Returns a valid date-time formatted string
 */
IMAPServer.prototype.formatInternalDate = function (date) {
    const day = date.getDate();
    const month = MONTHS[date.getMonth()];
    const year = date.getFullYear();
    const hour = date.getHours();
    const minute = date.getMinutes();
    const second = date.getSeconds();
    const tz = date.getTimezoneOffset();
    const tzHours = Math.floor(Math.abs(tz) / 60);
    const tzMins = Math.abs(tz) % 60;

    return (
        (day < 10 ? '0' : '') +
        day +
        '-' +
        month +
        '-' +
        year +
        ' ' +
        (hour < 10 ? '0' : '') +
        hour +
        ':' +
        (minute < 10 ? '0' : '') +
        minute +
        ':' +
        (second < 10 ? '0' : '') +
        second +
        ' ' +
        (tz > 0 ? '-' : '+') +
        (tzHours < 10 ? '0' : '') +
        tzHours +
        (tzMins < 10 ? '0' : '') +
        tzMins
    );
};

/**
 * Creates a mailbox with specified path
 *
 * @param {String} path Pathname for the mailbox
 * @param {Object} [defaultMailbox] use this object as the mailbox to add instead of empty'
 * @return {Object} the created mailbox
 */
IMAPServer.prototype.createMailbox = function (path, defaultMailbox) {
    if (!path) {
        throw mailboxError('Invalid mailbox name', 'CANNOT');
    }

    // Ensure case insensitive INBOX
    if (path.toUpperCase() === 'INBOX') {
        throw mailboxError('INBOX can not be modified', 'ALREADYEXISTS');
    }

    // detect namespace for the path
    let namespace = '';
    let storage;
    let folderPath;

    Object.keys(this.storage).forEach(key => {
        if (key === 'INBOX') {
            // Ignore INBOX
            return;
        }
        const ns = key.length ? key.substr(0, key.length - this.storage[key].separator.length) : key;
        if (key.length && (path === ns || path.substr(0, key.length) === key)) {
            if (path === ns) {
                throw mailboxError('Used mailbox name is a namespace value', 'CANNOT');
            }
            namespace = key;
        } else if (!namespace && !key && this.storage[key].type === 'personal') {
            namespace = key;
        }
    });

    if (!this.storage[namespace]) {
        throw mailboxError('Unknown namespace', 'CANNOT');
    } else {
        folderPath = path;
        storage = this.storage[namespace];

        if (storage.type !== 'personal') {
            throw mailboxError('Permission denied', 'NOPERM');
        }

        if (folderPath.substr(-storage.separator.length) === storage.separator) {
            folderPath = folderPath.substr(0, folderPath.length - storage.separator.length);
        }

        if (this.folderCache[folderPath] && this.folderCache[folderPath].flags.indexOf('\\Noselect') < 0) {
            throw mailboxError('Mailbox already exists', 'ALREADYEXISTS');
        }

        path = folderPath;
        folderPath = folderPath.substr(namespace.length).split(storage.separator);
    }

    let parent = storage;
    let curPath = namespace;

    if (curPath) {
        curPath = curPath.substr(0, curPath.length - storage.separator.length);
    }

    folderPath.forEach(folderName => {
        curPath += (curPath.length ? storage.separator : '') + folderName;

        let folder = this.getMailbox(curPath) || false;

        if (folder && folder.flags && folder.flags.indexOf('\\NoInferiors') >= 0) {
            throw mailboxError('Can not create subfolders for ' + folder.path, 'CANNOT');
        }

        // a \Noselect placeholder that is created again is replaced with a new mailbox that only keeps
        // the children, nothing else of a deleted mailbox may come back (RFC 3501 section 6.3.3)
        const isPlaceholder = curPath === path && folder && folder.flags.indexOf('\\Noselect') >= 0;
        if (!folder || isPlaceholder || (curPath === path && defaultMailbox)) {
            const children = folder && folder.folders;
            folder =
                curPath === path && defaultMailbox
                    ? defaultMailbox
                    : {
                          // a recreated mailbox must never reuse an earlier UIDVALIDITY value
                          uidvalidity: ++this.uidvalidityCounter
                      };
            if (children) {
                folder.folders = Object.assign({}, children, folder.folders);
            }
            // a new mailbox is subscribed if its name is, a subscription is not part of the mailbox
            this.trackSubscription(folder);
            this.processMailbox(curPath, folder, namespace);
            parent.folders = parent.folders || {};
            parent.folders[folderName] = folder;
            this.folderCache[curPath] = folder;
        }

        if (parent !== storage) {
            // Remove \HasNoChildren and add \\HasChildren from parent. A \Noselect parent stays \Noselect,
            // it already is the hierarchy level the new mailbox needs
            this.toggleFlags(parent.flags, ['\\HasNoChildren', '\\HasChildren'], 1);
        } else if (folder.namespace === this.referenceNamespace) {
            if (
                this.referenceNamespace.substr(0, this.referenceNamespace.length - this.storage[this.referenceNamespace].separator.length).toUpperCase() ===
                'INBOX'
            ) {
                this.toggleFlags(this.storage.INBOX.flags, ['\\HasNoChildren', '\\HasChildren'], 1);
            }
        }

        parent = folder;
    });

    return this.folderCache[path];
};

/**
 * Deletes a mailbox with specified path
 *
 * @param {String} path Pathname for the mailbox
 * @param {boolean} keepContents If true do not delete messages
 */
IMAPServer.prototype.deleteMailbox = function (path, keepContents) {
    // Ensure case insensitive INBOX
    if (path.toUpperCase() === 'INBOX') {
        throw mailboxError('INBOX can not be modified', 'CANNOT');
    }

    // detect namespace for the path
    let mailbox;
    let storage;
    let namespace = '';
    let folderPath = path;
    let folderName;
    let parent;
    let parentKey;

    Object.keys(this.storage).forEach(key => {
        if (key === 'INBOX') {
            // Ignore INBOX
            return;
        }
        const ns = key.length ? key.substr(0, key.length - this.storage[key].separator.length) : key;
        if (key.length && (path === ns || path.substr(0, key.length) === key)) {
            if (path === ns) {
                throw mailboxError('Used mailbox name is a namespace value', 'CANNOT');
            }
            namespace = key;
        } else if (!namespace && !key && this.storage[key].type === 'personal') {
            namespace = key;
        }
    });

    if (!this.storage[namespace]) {
        throw mailboxError('Unknown namespace', 'CANNOT');
    } else {
        parent = storage = this.storage[namespace];

        if (storage.type !== 'personal') {
            throw mailboxError('Permission denied', 'NOPERM');
        }

        if (folderPath.substr(-storage.separator.length) === storage.separator) {
            folderPath = folderPath.substr(0, folderPath.length - storage.separator.length);
        }

        mailbox = this.folderCache[folderPath];

        if (!mailbox) {
            throw mailboxError('Mailbox does not exist', 'NONEXISTENT');
        }

        if (mailbox.flags.indexOf('\\Noselect') >= 0 && Object.keys(mailbox.folders || {}).length) {
            // RFC 9051 section 6.3.5: deleting a \Noselect name that has inferior names is an error, the RFC 5530
            // section 3 HASCHILDREN response code tells the client to delete the children first
            throw mailboxError('Mailbox has children, delete them first', 'HASCHILDREN');
        }

        folderPath = folderPath.split(storage.separator);
        folderName = folderPath.pop();

        parentKey = folderPath.join(storage.separator);
        if (parentKey !== 'INBOX') {
            parent = this.folderCache[folderPath.join(storage.separator)] || parent;
        }

        if (mailbox.folders && Object.keys(mailbox.folders).length && !keepContents) {
            // Sessions that have the mailbox selected keep the old object, a new SELECT finds the
            // placeholder. The placeholder only keeps the children. Plugin data (MAILBOXID, special-use, metadata, ACL,
            // HIGHESTMODSEQ ...) belongs to the deleted mailbox and must not survive (RFC 3501 section 6.3.4)
            const folder = {
                flags: ['\\Noselect'],
                folders: mailbox.folders
            };
            this.trackSubscription(folder);
            this.processMailbox(mailbox.path, folder, mailbox.namespace);
            parent.folders[folderName] = folder;
            this.folderCache[mailbox.path] = folder;
        } else {
            delete this.folderCache[mailbox.path];
            delete parent.folders[folderName];

            if (parent !== storage) {
                if (parent.flags.indexOf('\\Noselect') >= 0 && !Object.keys(parent.folders || {}).length) {
                    this.deleteMailbox(parent.path);
                } else {
                    this.toggleFlags(parent.flags, ['\\HasNoChildren', '\\HasChildren'], Object.keys(parent.folders || {}).length ? 1 : 0);
                }
            } else if (namespace === this.referenceNamespace) {
                if (
                    this.referenceNamespace.substr(0, this.referenceNamespace.length - this.storage[this.referenceNamespace].separator.length).toUpperCase() ===
                    'INBOX'
                ) {
                    this.toggleFlags(this.storage.INBOX.flags, ['\\HasNoChildren', '\\HasChildren'], Object.keys(storage.folders || {}).length ? 1 : 0);
                }
            }
        }
    }
};

/**
 * Rebuilds folderCache and the path, namespace and flags of every mailbox from storage.
 * INBOX has its own namespace
 *
 * @param {Boolean} [processMessages] If true, messages are prepared as well. Only needed for
 *   messages from the initial storage, as message handlers must not run twice for a message
 */
IMAPServer.prototype.indexFolders = function (processMessages) {
    const folders = Object.create(null);

    const walkTree = (path, separator, branch, namespace) => {
        Object.keys(branch).forEach(key => {
            const curBranch = branch[key];
            const curPath = (path ? path + (path.substr(-1) !== separator ? separator : '') : '') + key;

            folders[curPath] = curBranch;
            this.processMailbox(curPath, curBranch, namespace);
            if (processMessages) {
                this.processMessages(curBranch);
            }

            if (curBranch.folders && Object.keys(curBranch.folders).length) {
                walkTree(curPath, separator, curBranch.folders, namespace);
            }
        });
    };

    // Ensure INBOX namespace always exists
    if (!this.storage.INBOX) {
        this.storage.INBOX = {};
    }

    Object.keys(this.storage).forEach(key => {
        if (key !== 'INBOX') {
            this.storage[key].folders = this.storage[key].folders || {};
            // "INBOX." uses "." as the separator, but "#news" does not use "s"
            this.storage[key].separator = this.storage[key].separator || (/[^a-z0-9]$/i.test(key) ? key.substr(-1) : '/');
            this.storage[key].type = this.storage[key].type || 'personal';

            if (this.storage[key].type === 'personal' && this.referenceNamespace === false) {
                this.referenceNamespace = key;
            }

            walkTree(key, this.storage[key].separator, this.storage[key].folders, key);
        }
    });

    if (!this.referenceNamespace) {
        this.storage[''] = this.storage[''] || {};
        this.storage[''].folders = this.storage[''].folders || {};
        this.storage[''].separator = this.storage[''].separator || '/';
        this.storage[''].type = 'personal';
        this.referenceNamespace = '';
    }

    if (!this.storage.INBOX.separator && this.referenceNamespace !== false) {
        this.storage.INBOX.separator = this.storage[this.referenceNamespace].separator;
    }

    // INBOX is its own namespace, but its subfolders belong to the personal namespace
    folders.INBOX = this.storage.INBOX;
    this.processMailbox('INBOX', this.storage.INBOX, 'INBOX');
    if (processMessages) {
        this.processMessages(this.storage.INBOX);
    }
    if (this.storage.INBOX.folders && Object.keys(this.storage.INBOX.folders).length) {
        walkTree('INBOX', this.storage.INBOX.separator, this.storage.INBOX.folders, this.referenceNamespace);
    }

    if (this.referenceNamespace.substr(0, this.referenceNamespace.length - this.storage[this.referenceNamespace].separator.length).toUpperCase() === 'INBOX') {
        this.toggleFlags(
            this.storage.INBOX.flags,
            ['\\HasChildren', '\\HasNoChildren'],
            this.storage[this.referenceNamespace].folders && Object.keys(this.storage[this.referenceNamespace].folders).length ? 0 : 1
        );
    }

    this.folderCache = folders;
};

/**
 * Ensures uid, flags and internaldate for every message of a mailbox and
 * keeps the message list ordered by UID
 *
 * @param {Object} mailbox Mailbox object
 */
IMAPServer.prototype.processMessages = function (mailbox) {
    const seen = new Set();

    mailbox.messages.forEach((message, i) => {
        // If the input was a raw message, convert it to an object
        if (typeof message === 'string') {
            mailbox.messages[i] = message = {
                raw: message
            };
        }

        this.processMessage(message, mailbox);

        if (seen.has(message.uid)) {
            throw new Error('Duplicate UID ' + message.uid + ' in mailbox ' + mailbox.path);
        }
        seen.add(message.uid);
    });

    mailbox.messages.sort((a, b) => a.uid - b.uid);
};

IMAPServer.prototype.processMailbox = function (path, mailbox, namespace) {
    mailbox.path = path;

    mailbox.namespace = namespace;
    mailbox.uid = mailbox.uid || 1;
    mailbox.uidvalidity = mailbox.uidvalidity || 1;
    this.uidvalidityCounter = Math.max(this.uidvalidityCounter, mailbox.uidvalidity);
    mailbox.flags = [].concat(mailbox.flags || []);
    mailbox.allowPermanentFlags = 'allowPermanentFlags' in mailbox ? mailbox.allowPermanentFlags : true;
    mailbox.permanentFlags = [].concat(mailbox.permanentFlags || this.systemFlags);

    // a mailbox from storage is subscribed unless it says otherwise
    this.trackSubscription(mailbox, true);

    // ensure message array
    mailbox.messages = [].concat(mailbox.messages || []);

    // ensure highest uidnext
    mailbox.uidnext = Math.max.apply(
        Math,
        [mailbox.uidnext || 1].concat(
            mailbox.messages.map(message => {
                return (message.uid || 0) + 1;
            })
        )
    );

    this.toggleFlags(mailbox.flags, ['\\HasChildren', '\\HasNoChildren'], mailbox.folders && Object.keys(mailbox.folders).length ? 0 : 1);

    // Allow plugins to process mailboxes
    this.mailboxHandlers.forEach(handler => {
        handler(this, mailbox);
    });
};

/**
 * Makes `mailbox.subscribed` read and change the subscription of the mailbox name in
 * `server.subscriptions`, so that the subscription stays with the name when the mailbox is deleted
 * or renamed (RFC 3501 section 6.3.6, RFC 9051 section 6.3.6). A `subscribed` value the mailbox
 * already has (from storage) is moved over to the subscription list.
 *
 * @param {Object} mailbox Mailbox object, its `path` is read whenever the subscription is used
 * @param {Boolean} [defaultValue] Subscription of a mailbox without a `subscribed` value. If not
 *   set, the subscription list is left as it is
 */
IMAPServer.prototype.trackSubscription = function (mailbox, defaultValue) {
    const descriptor = Object.getOwnPropertyDescriptor(mailbox, 'subscribed');
    if (descriptor && descriptor.get) {
        return;
    }
    const value = descriptor ? !!descriptor.value : defaultValue;
    Object.defineProperty(mailbox, 'subscribed', {
        enumerable: true,
        configurable: true,
        get: () => this.subscriptions.has(mailbox.path),
        set: subscribed => {
            if (subscribed) {
                this.subscriptions.add(mailbox.path);
            } else {
                this.subscriptions.delete(mailbox.path);
            }
        }
    });
    if (typeof value === 'boolean') {
        mailbox.subscribed = value;
    }
};

/**
 * Toggles listed flags. Vlags with `value` index will be turned on,
 * other listed fields are removed from the array
 *
 * @param {Array} flags List of flags
 * @param {Array} checkFlags Flags to toggle
 * @param {Number} value Flag from checkFlags array with value index is toggled
 */
IMAPServer.prototype.toggleFlags = function (flags, checkFlags, value) {
    [].concat(checkFlags || []).forEach((flag, i) => {
        if (i === value) {
            this.ensureFlag(flags, flag);
        } else {
            this.removeFlag(flags, flag);
        }
    });
};

/**
 * Ensures that a list of flags includes selected flag
 *
 * @param {Array} flags An array of flags to check
 * @param {String} flag If the flag is missing, add it
 */
IMAPServer.prototype.ensureFlag = function (flags, flag) {
    if (flags.indexOf(flag) < 0) {
        flags.push(flag);
    }
};

/**
 * Removes a flag from a list of flags
 *
 * @param {Array} flags An array of flags to check
 * @param {String} flag If the flag is in the list, remove it
 */
IMAPServer.prototype.removeFlag = function (flags, flag) {
    let i;
    if (flags.indexOf(flag) >= 0) {
        for (i = flags.length - 1; i >= 0; i--) {
            if (flags[i] === flag) {
                flags.splice(i, 1);
            }
        }
    }
};

/**
 * Remembers the flags of a message as flags of the mailbox. A keyword stays in the FLAGS and
 * PERMANENTFLAGS of the mailbox after the last message with it is expunged or loses it, like a
 * keyword a client defined (RFC 3501 section 2.3.2, FLAGS lists the flags applicable for the
 * mailbox, section 7.2.6)
 *
 * @param {Object} mailbox Mailbox object
 * @param {Array} flags Flags of a message
 */
IMAPServer.prototype.rememberFlags = function (mailbox, flags) {
    mailbox.knownFlags = mailbox.knownFlags || [];
    flags.forEach(flag => {
        if ((mailbox.permanentFlags || []).indexOf(flag) < 0) {
            this.ensureFlag(mailbox.knownFlags, flag);
        }
    });
};

/**
 * Converts a date-time value from storage or a client to the form it is sent in
 *
 * @param {Date|String} value Date object or date-time string
 * @return {String|*} date-time string, other values are returned as they are
 */
IMAPServer.prototype.normalizeDateTime = function (value) {
    if (value instanceof Date) {
        return this.formatInternalDate(value);
    }
    if (typeof value === 'string') {
        // month names are accepted in any case but always sent as "Jan", "Feb", ...
        return value.replace(/-([a-z]{3})-/i, (m, month) => '-' + (MONTHS[monthIndex(month)] || month) + '-');
    }
    return value;
};

IMAPServer.prototype.processMessage = function (message, mailbox) {
    message.internaldate = this.normalizeDateTime(message.internaldate || new Date());
    message.flags = [].concat(message.flags || []);
    if (message.flags.indexOf('\\Recent') >= 0) {
        // \Recent is not a stored flag, it belongs to the first session that selects the mailbox
        this.removeFlag(message.flags, '\\Recent');
        message.recent = true;
    }
    this.rememberFlags(mailbox, message.flags);
    message.uid = message.uid || mailbox.uidnext++;
    if (message.uid >= mailbox.uidnext) {
        mailbox.uidnext = message.uid + 1;
    }

    // message source is kept as a binary string (one character per octet)
    if (message.raw instanceof Uint8Array) {
        message.raw = Buffer.from(message.raw).toString('binary');
    } else if (typeof message.raw !== 'string') {
        message.raw = message.raw ? String(message.raw) : '';
    }
    if (/[\u0100-\uffff]/.test(message.raw)) {
        // characters outside Latin-1 can only come from a unicode string, so encode it as UTF-8
        message.raw = Buffer.from(message.raw, 'utf-8').toString('binary');
    }

    // Allow plugins to process messages
    this.messageHandlers.forEach(handler => {
        handler(this, message, mailbox);
    });
};

/**
 * Appends a message to a mailbox
 *
 * @param {Object|String} mailbox Mailbox to append to
 * @param {Array} flags Flags for the message
 * @param {String|Date} internaldate Receive date-time for the message
 * @param {String} raw Message source
 * @param {Object} [ignoreConnection] To not advertise new message to selected connection
 * @param {Object} [properties] More properties of the new message, set before message handlers run
 * @return An object of the form { mailbox, message }
 */
IMAPServer.prototype.appendMessage = function (mailbox, flags, internaldate, raw, ignoreConnection, properties) {
    if (typeof mailbox === 'string') {
        mailbox = this.getMailbox(mailbox);
    }

    const message = Object.assign({}, properties, {
        flags: flags,
        internaldate: internaldate,
        raw: raw,
        recent: true
    });

    mailbox.messages.push(message);
    this.processMessage(message, mailbox);

    // a session that has the mailbox selected read-write sees the new message as \Recent
    for (const connection of this.connections) {
        if (connection.selectedMailbox === mailbox && !connection.readOnly && connection.recent) {
            connection.recent.add(message);
            delete message.recent;
            break;
        }
    }

    this.notify(
        {
            tag: '*',
            attributes: [
                mailbox.messages.length,
                {
                    type: 'ATOM',
                    value: 'EXISTS'
                }
            ],
            // the new message, for plugins that report more about it (e.g. NOTIFY)
            message: message
        },
        mailbox,
        ignoreConnection
    );

    return { mailbox: mailbox, message: message };
};

/**
 * Copies a message to a mailbox (COPY, MOVE, RENAME INBOX). The copy is a new message that
 * keeps the flags, internal date and content of the source. `copyHandlers` can carry over more
 * properties of the source, they run before the message handlers see the copy
 *
 * @param {Object} mailbox Target mailbox
 * @param {Object} source Message to copy
 * @return An object of the form { mailbox, message }
 */
IMAPServer.prototype.copyMessage = function (mailbox, source) {
    const properties = {};
    this.copyHandlers.forEach(handler => {
        handler(this, source, properties, mailbox);
    });
    return this.appendMessage(mailbox, [].concat(source.flags || []), source.internaldate, source.raw, false, properties);
};

/**
 * Returns the namespace a mailbox path belongs to by its prefix, INBOX not included
 *
 * @param {String} path Mailbox path, it does not have to exist
 * @return {String|Boolean} the longest matching namespace key, or false
 */
IMAPServer.prototype.getNamespace = function (path) {
    let namespace = false;
    Object.keys(this.storage).forEach(key => {
        if (key !== 'INBOX' && path.substr(0, key.length) === key && (namespace === false || key.length > namespace.length)) {
            namespace = key;
        }
    });
    return namespace;
};

/**
 * Lists the mailboxes that match a LIST or LSUB reference and pattern (RFC 3501 section 6.3.8)
 *
 * @param {String} reference Reference name
 * @param {String} match Mailbox name with possible wildcards
 * @param {Function} [exportName] Converts storage names to the form the client uses, so that the
 *   wildcards match whole characters, see IMAPConnection#exportMailboxName
 * @param {Object} [folders] Mailboxes to choose from by path, defaults to all mailboxes (folderCache)
 * @return {Array} Matching mailbox objects
 */
IMAPServer.prototype.matchFolders = function (reference, match, exportName, folders) {
    let includeINBOX = false;

    folders = folders || this.folderCache;

    exportName = exportName || (name => name);
    reference = reference || '';
    if (reference === '' && this.referenceNamespace !== false) {
        reference = exportName(this.referenceNamespace);
        includeINBOX = true;
    }

    // the reference does not have to be a namespace, use the namespace it belongs to
    let nsKey = false;
    let nsName = '';
    Object.keys(this.storage).forEach(key => {
        const name = exportName(key);
        if (key !== 'INBOX' && reference.substr(0, name.length) === name && (nsKey === false || name.length > nsName.length)) {
            nsKey = key;
            nsName = name;
        }
    });

    if (nsKey === false) {
        return [];
    }

    const namespace = this.storage[nsKey];
    const lookup = reference + match;
    const result = [];

    const pattern =
        '^' +
        lookup
            // escape regex symbols
            .replace(/([\\^$+?!.():=[\]{}|,-])/g, '\\$1')
            .replace(/[*]/g, '.*')
            .replace(/[%]/g, '[^' + namespace.separator.replace(/([\\^$+*?!.():=[\]{}|,-])/g, '\\$1') + ']*') +
        '$';
    const query = new RegExp(pattern, '');

    // INBOX is case-insensitive
    if (includeINBOX && folders.INBOX && ((reference ? reference + namespace.separator : '') + 'INBOX').match(new RegExp(pattern, 'i'))) {
        result.push(folders.INBOX);
    }

    Object.keys(folders).forEach(path => {
        const folder = folders[path];
        if (folder.namespace !== nsKey) {
            return;
        }
        const name = exportName(path);
        if (name.match(query) && (folder.flags.indexOf('\\NonExistent') < 0 || name === match)) {
            result.push(folder);
        }
    });

    return result;
};

/**
 * Returns the subscribed names with their superior hierarchy levels, for LSUB and LIST (SUBSCRIBED).
 * Names that are not mailboxes get a stand-in object with \Noselect, which LIST-EXTENDED reports as
 * \NonExistent (RFC 5258 section 3), and `subscribed` false for a level that is only listed because
 * of a subscribed name below it
 *
 * @return {Object} path to mailbox object or stand-in, usable as the `folders` of matchFolders
 */
IMAPServer.prototype.getSubscriptionTree = function () {
    const tree = Object.create(null);
    const add = (path, subscribed) => {
        tree[path] = tree[path] || this.getMailbox(path) || { path, namespace: this.getNamespace(path), flags: ['\\Noselect'], subscribed };
    };
    const names = [...this.subscriptions].filter(path => path === 'INBOX' || this.getNamespace(path) !== false);
    names.forEach(path => add(path, true));
    names.forEach(path => {
        // superior levels of the name within its namespace
        const namespace = this.getNamespace(path) || '';
        const separator = (this.storage[namespace] || {}).separator;
        for (let index = separator ? path.lastIndexOf(separator) : -1; index > namespace.length; index = path.lastIndexOf(separator, index - 1)) {
            add(path.substr(0, index), false);
        }
    });
    return tree;
};

/**
 * Retrieves an array of messages that fit in the specified range criteria
 *
 * @param {Object|String} mailbox Mailbox to look for the messages
 * @param {String} range Message range (eg. "*:4,5,7:9")
 * @param {Boolean} isUid If true, use UID values, not sequence indexes for comparison
 * @return {Array} An array of messages in the form of [[seqIndex, message]]
 */
IMAPServer.prototype.getMessageRange = function (mailbox, range, isUid) {
    range = (range || '').toString();
    if (typeof mailbox === 'string') {
        mailbox = this.getMailbox(mailbox);
    }

    // sequence-set from RFC 3501 section 9, numbers are nz-number values
    if (!/^([1-9]\d{0,9}|\*)(:([1-9]\d{0,9}|\*))?(,([1-9]\d{0,9}|\*)(:([1-9]\d{0,9}|\*))?)*$/.test(range)) {
        const err = new Error('Invalid sequence set');
        err.imapResponse = 'BAD';
        throw err;
    }

    const result = [];
    const rangeParts = range.split(',');
    const messages = Array.isArray(mailbox) ? mailbox : mailbox.messages;
    let uid;
    const totalMessages = messages.length;
    let maxUid = 0;
    const inRange = function (nr, ranges, total) {
        let range;
        let from;
        let to;
        for (let i = 0, len = ranges.length; i < len; i++) {
            range = ranges[i];
            to = range.split(':');
            from = to.shift();
            if (from === '*') {
                from = total;
            }
            from = Number(from) || 1;
            to = to.pop() || from;
            to = Number((to === '*' && total) || to) || from;

            if (nr >= Math.min(from, to) && nr <= Math.max(from, to)) {
                return true;
            }
        }
        return false;
    };

    messages.forEach(message => {
        if (message.uid > maxUid) {
            maxUid = message.uid;
        }
    });

    for (let i = 0, len = messages.length; i < len; i++) {
        uid = messages[i].uid || 1;
        if (inRange(isUid ? uid : i + 1, rangeParts, isUid ? maxUid : totalMessages)) {
            result.push([i + 1, messages[i]]);
        }
    }

    return result;
};

function IMAPConnection(server, socket) {
    this.server = server;
    this.socket = socket;
    this.options = this.server.options;

    this.state = 'Not Authenticated';

    this.secureConnection = !!this.options.secureConnection;

    this._remainder = '';
    this._command = '';
    this._literalRemaining = 0;

    this.inputHandler = false;

    // a layer between the socket and the IMAP protocol, such as COMPRESS=DEFLATE (RFC 4978). It has
    // the methods write(buffer), receive(chunk), end(callback) and destroy(), and passes data on with
    // connection.writeRaw() and connection.onData(), so it always sits above TLS (RFC 4978 section 3)
    this.transport = null;

    // per connection options for the imap-handler parser and compiler, plugins can change these. The
    // parser options go on top of server.parserOptions
    this.parserOptions = {};
    this.compilerOptions = {};

    // message/global parts encapsulate a message like message/rfc822 parts in BODYSTRUCTURE and in section
    // numbers. IMAP4rev2 sets it (RFC 9051 sections 6.4.5.1 and 7.5.2), IMAP4rev1 describes them as basic parts
    this.messageGlobal = false;

    this._commandQueue = [];
    this._processing = false;

    if (this.options.debug) {
        this.socket.pipe(process.stdout);
    }

    this.socket.on('data', this.receive.bind(this));
    this.socket.on('close', this.onClose.bind(this));
    this.socket.on('error', this.onError.bind(this));

    this.directNotifications = false;
    this._notificationCallback = this.onNotify.bind(this);
    this.notificationQueue = [];
    this.server.on('notify', this._notificationCallback);
    this.server.connections.add(this);

    this.write('* OK Hoodiecrow ready for rumble\r\n');
}

/**
 * Writes protocol output to the client, through the transport layer if there is one
 *
 * @param {Buffer|String} data Data to send, a string is sent as a binary string
 */
IMAPConnection.prototype.write = function (data) {
    if (typeof data === 'string') {
        data = Buffer.from(data, 'binary');
    }
    if (this.transport) {
        this.transport.write(data);
    } else {
        this.writeRaw(data);
    }
};

/**
 * Writes data to the socket, below the transport layer
 *
 * @param {Buffer} data Data to send
 */
IMAPConnection.prototype.writeRaw = function (data) {
    if (this.socket && !this.socket.destroyed) {
        this.socket.write(data);
    }
};

/**
 * Handles data from the socket, through the transport layer if there is one
 *
 * @param {Buffer} chunk Received data
 */
IMAPConnection.prototype.receive = function (chunk) {
    if (this.transport) {
        this.transport.receive(chunk);
    } else {
        this.onData(chunk);
    }
};

/**
 * Closes the connection once everything sent so far, including data a transport layer still
 * holds, is written out
 */
IMAPConnection.prototype.end = function () {
    const socket = this.socket;
    if (!socket) {
        return;
    }
    if (this.transport) {
        this.transport.end(() => socket.end());
    } else {
        socket.end();
    }
};

/**
 * Checks if the client sent anything after the command that is running, that is not processed yet
 *
 * @return {Boolean} true if there is unprocessed input or a queued command
 */
IMAPConnection.prototype.hasPendingInput = function () {
    return !!(this._remainder || this._command || this._literalRemaining || this._commandQueue.length);
};

/**
 * Drops input that is not processed yet, including queued commands
 */
IMAPConnection.prototype.discardInput = function () {
    this._commandQueue = [];
    this._remainder = '';
    this._command = '';
    this._literalRemaining = 0;
    this._skipCommand = false;
    this._earlyLiteral = false;
};

/**
 * Returns the connection to the Not Authenticated state and resets everything but the TLS
 * layer (RFC 8437 section 3): the selected mailbox is closed without EXPUNGE responses, and the
 * plugins clear their session state (ENABLEd extensions, CONDSTORE, COMPRESS, ...) with
 * server.resetHandlers. Call it after the response that ends the session was sent.
 */
IMAPConnection.prototype.resetSession = function () {
    this.state = 'Not Authenticated';
    this.username = false;
    this.selectedMailbox = false;
    this.readOnly = false;
    this.recent = null;
    this.everSelected = false;
    this.notificationQueue = [];
    this.directNotifications = false;
    this.server.resetHandlers.forEach(handler => handler(this));
};

IMAPConnection.prototype.onClose = function () {
    if (this.socket) {
        this.socket.removeAllListeners();
        this.socket = null;
    }
    if (this.transport) {
        this.transport.destroy();
        this.transport = null;
    }
    this.server.removeListener('notify', this._notificationCallback);
    this.server.connections.delete(this);
};

IMAPConnection.prototype.onError = function (err) {
    if (this.options.debug) {
        console.log('Socket error event emitted, %s', Date());
        console.log(err.stack);
    }
    try {
        this.socket.end();
    } catch (E) {
        // socket is already gone
    }
};

IMAPConnection.prototype.onData = function (chunk) {
    let match;
    let str;

    // everything in one read arrived before anything this read causes to be sent
    this._readCount = (this._readCount || 0) + 1;

    str = (chunk || '').toString('binary');

    if (this._discardLine) {
        // skipping the rest of a command line that was too long
        const lineEnd = str.indexOf('\n');
        if (lineEnd < 0) {
            return;
        }
        // the command was not executed, but its tag still gets an answer
        const tag = this._discardLine;
        this._discardLine = false;
        str = str.substr(lineEnd + 1);
        this.sendBad(tag, 'Command line too long', 'LINE TOO LONG');
    }

    if (this._literalRemaining) {
        str = this.readLiteral(str);
        if (this._literalRemaining) {
            return;
        }
    }

    // non-synchronizing literals are only valid when LITERAL+ or LITERAL- is advertised. A literal8 marker `~{n}`
    // (RFC 3516) is matched always, so it is refused when BINARY is not loaded
    const lineEndRegex = this.server.literalPlus
        ? /(?<marker>(?<tilde>~)?\{(?<size>\d+)(?<plus>\+)?\})?(?<cr>\r?)\n/
        : /(?<marker>(?<tilde>~)?\{(?<size>\d+)\})?(?<cr>\r?)\n/;

    this._remainder = str = this._remainder + str;
    while ((match = str.match(lineEndRegex))) {
        const { marker, tilde, size, plus, cr } = match.groups;

        if (!cr) {
            // every command line ends with CRLF (RFC 3501 section 9), a bare LF is refused
            const line = this._command + str.substr(0, match.index + match[0].length - 1);
            this._remainder = str = str.substr(match.index + match[0].length);
            this._command = '';
            if (this._skipCommand) {
                this._skipCommand = false;
            } else {
                this.sendBad(this.inputHandler ? '*' : getResponseTag(line), 'Lines must end with CRLF', 'INVALID LINE ENDING', line);
            }
            continue;
        }

        if (!size || (this._skipCommand && !plus)) {
            // the command is complete, or it was refused already and the client waits in vain
            // for a continuation request
            const line = this._command + str.substr(0, match.index);
            this._remainder = str.substr(match.index + match[0].length);
            this._command = '';
            if (this._skipCommand) {
                this._skipCommand = false;
            } else if (this._earlyLiteral) {
                // the client sent literal data without waiting for the continuation request
                this._earlyLiteral = false;
                this.sendBad(getResponseTag(line), 'Literal data must wait for the continuation request', 'LITERAL TOO EARLY', line);
            } else if (this.inputHandler) {
                this.inputHandler(line);
            } else {
                this.scheduleCommand(line);
            }

            if (this.upgrading) {
                // STARTTLS was accepted, ignore any pipelined plaintext input
                return;
            }

            // a handler may have dropped the input that followed with discardInput()
            str = this._remainder;
            continue;
        }

        const literalSize = Number(size);
        if (!this._skipCommand) {
            const line = this._command + str.substr(0, match.index);
            // the literal marker is part of the first word when it directly follows the tag
            const tag = getResponseTag(line + marker);
            const refusal = this.checkLiteral(line, literalSize, !plus, !!tilde);
            if (refusal) {
                if (plus) {
                    // the client is going to send the literal anyway, so there is no way to recover. A BYE
                    // for a literal that is too large should carry TOOBIG (RFC 7888 section 5)
                    this.sendStatus({ tag: '*' }, line, 'BYE', refusal.text, refusal.text === LITERAL_TOO_LARGE && 'TOOBIG', 'LITERAL REFUSED');
                    this._remainder = this._command = '';
                    this.end();
                    return;
                }
                // refuse a synchronizing literal by not sending a continuation request
                this.sendStatus({ tag }, line, refusal.command, refusal.text, refusal.code || false, 'LITERAL REFUSED');
                this._remainder = str = str.substr(match.index + match[0].length);
                this._command = '';
                continue;
            }
            if (plus && literalSize > this.server.nonSyncLiteralLimit) {
                // RFC 7888 sections 4 and 5: the command is refused with TOOBIG, the literal and the
                // rest of the command are read and dropped
                this.sendStatus(
                    { tag },
                    line,
                    'BAD',
                    'Non-synchronizing literals are limited to ' + this.server.nonSyncLiteralLimit + ' octets',
                    'TOOBIG',
                    'LITERAL TOO BIG'
                );
                this._skipCommand = true;
                this._command = '';
            }
        }

        if (!plus) {
            if (str.length > match.index + match[0].length) {
                // RFC 3501 section 4.3: the client MUST wait for the continuation request
                // before sending the octets of a synchronizing literal
                this._earlyLiteral = true;
            } else if (!this._earlyLiteral) {
                this.write('+ Go ahead\r\n');
            }
        }

        this._remainder = '';
        if (!this._skipCommand) {
            this._command += str.substr(0, match.index + match[0].length);
        }
        this._literalRemaining = literalSize;

        str = this.readLiteral(str.substr(match.index + match[0].length));
        if (this._literalRemaining) {
            return;
        }
        this._remainder = str;
    }

    if (this._remainder.length > MAX_LINE_LENGTH) {
        // RFC 3501 section 7.1.3
        this.sendBad('*', 'Command line too long', 'LINE TOO LONG');
        const tag = getResponseTag(this._command || this._remainder);
        this._remainder = '';
        this._command = '';
        this._skipCommand = false;
        this._discardLine = tag;
    }
};

/**
 * Reads literal data that the current command is waiting for. The data of a command that was
 * refused is dropped.
 *
 * @param {String} str Received data
 * @return {String} the data that follows the literal
 */
IMAPConnection.prototype.readLiteral = function (str) {
    const length = Math.min(this._literalRemaining, str.length);
    if (!this._skipCommand) {
        this._command += str.substr(0, length);
    }
    this._literalRemaining -= length;
    return str.substr(length);
};

/**
 * Sends a BAD response to input that did not make it to a command handler
 *
 * @param {String} tag Tag to answer with, "*" for an untagged response
 * @param {String} text Human readable text
 * @param {String} description Description for output handlers
 * @param {String} [data] Raw input
 */
IMAPConnection.prototype.sendBad = function (tag, text, description, data) {
    this.sendStatus({ tag }, data, 'BAD', text, false, description);
};

/**
 * Checks if a literal may be accepted for the command line received so far. Literals are
 * refused before they are read when they are too large, or when the command is unknown or
 * not allowed in the current state, so the client does not get a continuation request for
 * a command that is going to fail anyway.
 *
 * @param {String} line The command received so far (with earlier literals), up to the literal size marker
 * @param {Number} literalSize Size of the literal in octets
 * @param {Boolean} [synchronizing] true if the literal can still be refused without reading it
 * @param {Boolean} [literal8] The literal is a literal8 `~{n}`
 * @return {Object|Boolean} `{ command, code, text }` for the response that refuses the literal, or false.
 *   Responses from `server.literalFilters` have the same form
 */
IMAPConnection.prototype.checkLiteral = function (line, literalSize, synchronizing, literal8) {
    const refuse = text => ({ command: 'BAD', text });
    const maxLiteralSize = this.getMaxLiteralSize();
    if (literalSize > maxLiteralSize || line.length + literalSize > maxLiteralSize + MAX_LINE_LENGTH) {
        return refuse(LITERAL_TOO_LARGE);
    }

    if (this.inputHandler) {
        // not a command, e.g. a SASL response
        return literal8 ? refuse('Literal8 is not allowed here') : false;
    }

    // tag SP command, and for UID and AUTHENTICATE the word that follows
    const words = line.match(/^[^ ]* ([^ ]*)(?: ([^ ]*))?/);
    let command = ((words && words[1]) || '').toUpperCase();
    if (command === 'UID' || command === 'AUTHENTICATE') {
        command += ' ' + (words[2] || '').toUpperCase();
    }

    if (!/^[A-Z0-9]+( [A-Z0-9]+)?$/.test(command) || !this.server.getCommandHandler(command)) {
        return refuse('Unknown command');
    }

    const options = this.server.getCommandOptions(command);
    if (options.states && options.states.indexOf(this.state) < 0) {
        return refuse(stateError(command, this.state));
    }

    // RFC 3516 section 7: literal8 is only valid where an extension allows it, like BINARY for the APPEND
    // message or METADATA for entry values (RFC 5464 section 5)
    if (literal8 && !(options.literal8 === true || (options.literal8 && Object.hasOwn(this.server.capabilities, options.literal8)))) {
        return refuse('Literal8 is not allowed in ' + command);
    }

    // plugins can refuse a synchronizing literal, e.g. a message that is too large for APPEND.
    // A non-synchronizing literal is read anyway, the command handler refuses it later
    if (synchronizing) {
        for (const filter of this.server.literalFilters) {
            const refusal = filter(this, command, line, literalSize);
            if (refusal) {
                return refusal;
            }
        }
    }

    return false;
};

/**
 * Returns the largest literal the client may send in its current state. Before
 * authentication only small literals (user names, passwords) make sense.
 *
 * @return {Number} Size in bytes
 */
IMAPConnection.prototype.getMaxLiteralSize = function () {
    if (this.state === 'Not Authenticated') {
        return MAX_PREAUTH_LITERAL_SIZE;
    }
    return Number(this.options.maxLiteralSize) || MAX_LITERAL_SIZE;
};

/**
 * Returns the message list of the selected mailbox as this session currently
 * sees it. When another session has expunged messages that this session has
 * not been told about yet, sequence numbers must still refer to the old list.
 *
 * @return {Array} List of messages
 */
IMAPConnection.prototype.getSessionMessages = function () {
    for (let i = 0, len = this.notificationQueue.length; i < len; i++) {
        if (this.notificationQueue[i].mailboxCopy) {
            return this.notificationQueue[i].mailboxCopy;
        }
    }
    return this.selectedMailbox ? this.selectedMailbox.messages : [];
};

/**
 * Resolves the sequence set argument of a command to messages of the selected mailbox, as this
 * session sees it. Plugins can replace it per connection to support other forms of sequence sets
 * (e.g. "$" of SEARCHRES)
 *
 * @param {String} range Sequence set
 * @param {Boolean} isUid If true, the set lists UIDs instead of sequence numbers
 * @return {Array} An array of messages in the form of [[seqIndex, message]]
 */
IMAPConnection.prototype.getMessageRange = function (range, isUid) {
    return this.server.getMessageRange(this.getSessionMessages(), range, isUid);
};

/**
 * Lets `server.rangeLimits` cut the messages a command operates on, after its sequence set argument was resolved.
 * A limit that returns the messages from the highest UID down sets `parsed.highestFirst`, then MOVE and UID EXPUNGE
 * send their EXPUNGE responses in that order too
 *
 * @param {Object} parsed Parsed command
 * @param {Array} range Messages of the sequence set, in the form of [[seqIndex, message]]
 * @return {Array} the messages to operate on, in the same form
 */
IMAPConnection.prototype.limitRange = function (parsed, range) {
    return this.server.rangeLimits.reduce((result, limit) => limit(this, parsed, result) || result, range);
};

/**
 * Refuses a sequence set argument with message sequence numbers past the end of the selected
 * mailbox, as this session sees it. RFC 3501 and RFC 9051 section 9 (seq-number): "The server should
 * respond with a tagged BAD response to a command that uses a message sequence number greater than
 * the number of messages in the selected mailbox. This includes "*" if the selected mailbox is
 * empty." Used for the sequence set of FETCH, STORE, COPY and MOVE, not for UID sets or SEARCH keys
 *
 * @param {String} range Sequence set, already checked by getMessageRange
 * @throws {Error} BAD error if a number is out of range
 */
IMAPConnection.prototype.checkSequenceNumbers = function (range) {
    const total = this.getSessionMessages().length;
    String(range)
        .split(/[,:]/)
        .forEach(value => {
            if (value === '*' ? !total : Number(value) > total) {
                const err = new Error(
                    total ? 'Message sequence number ' + value + ' is greater than the number of messages (' + total + ')' : 'The mailbox is empty'
                );
                err.imapResponse = 'BAD';
                throw err;
            }
        });
};

/**
 * Checks if this session has EXPUNGE notifications that it has not been told about yet
 *
 * @return {Boolean} true if an EXPUNGE response is pending
 */
IMAPConnection.prototype.hasPendingExpunge = function () {
    return this.notificationQueue.some(notification => notification.attributes && (notification.attributes[1] || {}).value === 'EXPUNGE');
};

/**
 * Tells the other sessions that have the selected mailbox open about changed flags, they get
 * an untagged FETCH with the new flags (RFC 3501 section 5.2)
 *
 * @param {Array} messages Messages with changed flags
 */
IMAPConnection.prototype.notifyFlagChanges = function (messages) {
    if (messages.length && this.selectedMailbox) {
        this.server.notify({ tag: '*', flagUpdate: messages }, this.selectedMailbox, this);
    }
};

/**
 * Sends unsolicited FETCH responses with the flags another session changed. The UID is always
 * included, RFC 9051 section 6.3.13 requires it for unsolicited FETCH responses and it is valid
 * in IMAP4rev1 as well.
 *
 * @param {Array} messages Messages with changed flags
 * @param {Map} sequence Message to the sequence number this session knows it by
 */
IMAPConnection.prototype.sendFlagUpdate = function (messages, sequence) {
    const getFlags = this.server.fetchHandlers.FLAGS || fetchHandlers.FLAGS;
    messages.forEach(message => {
        if (!sequence.has(message) || message.ghost) {
            // the message is gone, its EXPUNGE response tells the rest
            return;
        }
        this.send(
            {
                tag: '*',
                notification: true,
                attributes: [
                    sequence.get(message),
                    {
                        type: 'ATOM',
                        value: 'FETCH'
                    },
                    [
                        {
                            type: 'ATOM',
                            value: 'UID'
                        },
                        message.uid,
                        {
                            type: 'ATOM',
                            value: 'FLAGS'
                        },
                        getFlags(this, message, { type: 'ATOM', value: 'FLAGS' })
                    ]
                ]
            },
            'FLAG NOTIFICATION',
            null,
            null,
            message
        );
    });
};

/**
 * Checks if a message has the \Recent flag in this session
 *
 * @param {Object} message Message object
 * @return {Boolean} true if the message is recent for this session
 */
IMAPConnection.prototype.isRecent = function (message) {
    return !!(this.recent && this.recent.has(message));
};

/**
 * Returns the flags of a message as seen by this session, including \Recent
 *
 * @param {Object} message Message object
 * @return {Array} List of flags
 */
IMAPConnection.prototype.getFlags = function (message) {
    return this.isRecent(message) ? message.flags.concat('\\Recent') : message.flags;
};

/**
 * Checks if FETCH may set the \Seen flag in the selected mailbox (RFC 3501 section 6.4.5).
 * Plugins can override it for a connection, e.g. ACL without the "s" right
 *
 * @return {Boolean} true if \Seen may be set
 */
IMAPConnection.prototype.canSetSeen = function () {
    return !this.readOnly;
};

/**
 * Checks if CLOSE may expunge the selected mailbox (RFC 3501 section 6.4.2). Plugins can
 * override it for a connection, e.g. ACL without the "e" right
 *
 * @return {Boolean} true if messages may be expunged
 */
IMAPConnection.prototype.canExpunge = function () {
    return !this.readOnly;
};

IMAPConnection.prototype.onNotify = function (notification) {
    if (
        notification.ignoreConnection === this ||
        (notification.filter && !notification.filter(this)) ||
        !this.server.notifyFilters.every(filter => filter(this, notification))
    ) {
        return;
    }
    const mailbox = typeof notification.mailbox === 'string' ? this.server.getMailbox(notification.mailbox) : notification.mailbox;
    if (!notification.mailbox || (this.selectedMailbox && this.selectedMailbox === mailbox)) {
        let command = notification.command;
        if (command.mailboxCopy && this.notificationQueue.some(queued => queued.mailboxCopy)) {
            // Only the oldest snapshot describes what this session currently sees,
            // so do not keep another copy of the message list around
            command = Object.assign({}, command);
            delete command.mailboxCopy;
        }
        this.queueNotification(command, notification);
    }
};

/**
 * Queues a notification for this session, it is sent before the next tagged response that allows it, or
 * right away while notifications are direct (IDLE). Plugins can replace it per connection to drop
 * notifications or send them at other times (e.g. NOTIFY)
 *
 * @param {Object} command Untagged response
 * @param {Object} notification The `notify` event, `{ command, mailbox, ignoreConnection, filter, origin }`
 */
IMAPConnection.prototype.queueNotification = function (command) {
    this.notificationQueue.push(command);
    if (this.directNotifications) {
        this.processNotifications();
    }
};

IMAPConnection.prototype.upgradeConnection = function (callback) {
    this.upgrading = true;

    // Anything the client sent after STARTTLS in plaintext must not be executed
    // after the upgrade (RFC 9051 section 6.2.1)
    this.discardInput();

    const secureContext = tls.createSecureContext(this.server.getCredentials());
    const socketOptions = {
        secureContext: secureContext,
        isServer: true,
        server: this.server.server,

        // throws if SNICallback is missing, so we set a default callback
        SNICallback: function (servername, cb) {
            cb(null, secureContext);
        }
    };

    // remove all listeners from the original socket besides the error handler
    this.socket.removeAllListeners();
    this.socket.on('error', this.onError.bind(this));

    // upgrade connection
    const secureSocket = new tls.TLSSocket(this.socket, socketOptions);

    const onTLSError = err => {
        // a failed handshake leaves nothing to talk to, so drop the connection
        if (this.options.debug) {
            console.log('TLS error: %s', err.message);
        }
        secureSocket.destroy();
    };

    secureSocket.on('close', this.onClose.bind(this));
    secureSocket.on('error', onTLSError);
    secureSocket.on('clientError', onTLSError);

    secureSocket.on('secure', () => {
        this.secureConnection = true;
        this.socket = secureSocket;
        this.upgrading = false;
        this.socket.on('data', this.receive.bind(this));
        callback();
    });
};

/**
 * Turns the queued notifications into the responses to send. Plugins can replace it per connection
 * to report changes in another form (e.g. VANISHED instead of EXPUNGE with QRESYNC)
 *
 * @param {Array} queue Queued notifications
 * @return {Array} Notifications to send
 */
IMAPConnection.prototype.prepareNotifications = function (queue) {
    return queue;
};

IMAPConnection.prototype.processNotifications = function (data) {
    const options = data && this.server.getCommandOptions(data.command);
    if (options && (options.noExpunge || (options.searchCriteria !== false && this.usesSequenceNumbers(data)))) {
        // EXPUNGE responses are not allowed during FETCH, STORE and SEARCH (RFC 3501 section 7.4.1), during
        // the commands that extensions add to this list (see the noExpunge command option), nor during UID
        // SEARCH with message numbers in the search criteria (RFC 7162 section 3.2.10.2 for VANISHED, EXPUNGE
        // may wait as well, RFC 3501 only allows it during UID commands)
        return;
    }

    if (!this.notificationQueue.length) {
        return;
    }
    const queue = this.prepareNotifications(this.notificationQueue);
    this.notificationQueue = [];

    // Flag updates use the sequence numbers this session knows: before the EXPUNGE responses of
    // the snapshot are sent, the snapshot, afterwards the current message list
    const snapshotIndex = queue.findIndex(notification => notification.mailboxCopy);
    const sequenceMaps = new Map();
    const getSequence = messages => {
        if (!sequenceMaps.has(messages)) {
            sequenceMaps.set(messages, new Map(messages.map((message, i) => [message, i + 1])));
        }
        return sequenceMaps.get(messages);
    };
    const current = this.selectedMailbox ? this.selectedMailbox.messages : [];

    queue.forEach((notification, i) => {
        if (notification.flagUpdate) {
            this.sendFlagUpdate(notification.flagUpdate, getSequence(i < snapshotIndex ? queue[snapshotIndex].mailboxCopy : current));
        } else {
            this.send(notification);
        }
    });
};

/**
 * Compile a command object to a response string and write it to socket.
 * If the command object has a skipResponse property, the command is
 * ignored
 *
 * @param {Object} response Response IMAP command object to be compiled.
 * @param {String} description
 *   An upper-case string uniquely identifying the response for the benefit of
 *   output handlers that wish to augment/replace the given response.
 * @param {Object} parsed
 *   Original parsed IMAP command that this is in response to.
 * @param {String} data
 *   Original raw IMAP command as a binary string.
 * @param {Object} extra
 *   Response-specific payload, usually the subject of the response.  For
 *   example, the STORE command will pass the impacted message for each updated
 *   FETCH result.  (This may have other names when used, like "affected".)
 */
IMAPConnection.prototype.send = function (response, description, parsed) {
    if (!this.socket || this.socket.destroyed) {
        return;
    }

    if (!response.notification && response.tag !== '*') {
        // arguments[2] should be the original command
        this.processNotifications(parsed);
    }

    const args = Array.prototype.slice.call(arguments);
    this.server.outputHandlers.forEach(handler => {
        handler.apply(null, [this].concat(args));
    });

    // No need to display this response to user
    if (response.skipResponse) {
        return;
    }

    if (
        this.notificationQueue.length &&
        parsed &&
        response.tag === parsed.tag &&
        response.command === 'OK' &&
        this.hasPendingExpunge() &&
        this.server.getCommandOptions(parsed.command).noExpunge &&
        !(Array.isArray(response.attributes) && response.attributes.some(attr => attr && attr.type === 'SECTION'))
    ) {
        // After the output handlers, they might add a response code of their own (MODIFIED of CONDSTORE).
        // FETCH, STORE, SEARCH and the like can not report the EXPUNGE of another session (RFC 3501 section 7.4.1),
        // EXPUNGEISSUED tells the client to issue NOOP soon (RFC 5530 section 3, RFC 9051 section 7.1)
        response.attributes = [{ type: 'SECTION', section: [{ type: 'ATOM', value: 'EXPUNGEISSUED' }] }].concat(response.attributes || []);
    }

    // a { type: 'MAILBOX', value } attribute holds a storage name, sent in the form this session uses. It
    // can also be in a list, like the MAILBOX correlator of an ESEARCH response (RFC 7377 section 4)
    const isMailbox = attr => attr && attr.type === 'MAILBOX';
    const hasMailbox = list => list.some(attr => isMailbox(attr) || (Array.isArray(attr) && hasMailbox(attr)));
    const exportList = list =>
        list.map(attr => (isMailbox(attr) ? mailboxAttribute(this.exportMailboxName(attr.value)) : Array.isArray(attr) ? exportList(attr) : attr));
    if (Array.isArray(response.attributes) && hasMailbox(response.attributes)) {
        response = Object.assign({}, response, { attributes: exportList(response.attributes) });
    }

    // RFC 3501 section 9: TEXT-CHAR is 7-bit (CHAR = %x01-7F), so client input echoed in the
    // human readable text of a status response must not carry 8-bit or control octets
    if (STATUS_RESPONSES.has((response.command || '').toString().toUpperCase()) && Array.isArray(response.attributes)) {
        const isUnsafe = attr => attr && attr.type === 'TEXT' && typeof attr.value === 'string' && /[^\x20-\x7e]/.test(attr.value);
        if (response.attributes.some(isUnsafe)) {
            response = Object.assign({}, response, {
                attributes: response.attributes.map(attr =>
                    isUnsafe(attr) ? Object.assign({}, attr, { value: attr.value.replace(/[^\x20-\x7e]/g, '?') }) : attr
                )
            });
        }
    }

    let compiled;
    try {
        compiled = imapHandler.compiler(response, this.compilerOptions);
    } catch (err) {
        // the compiler refuses unsafe output, like line breaks in a TEXT value
        if (this.options.debug) {
            console.log('Failed to compile response: %s', err.message);
        }
        if (response.tag === '*') {
            return;
        }
        compiled = response.tag + ' NO [SERVERBUG] Failed to compile response';
    }

    if (this.options.debug) {
        console.log('SEND: %s', compiled);
    }

    this.write(compiled + '\r\n');
};

/**
 * Sends a tagged status response to a command
 *
 * @param {Object} parsed Parsed command
 * @param {String} data Raw command
 * @param {String} command Response type: OK, NO or BAD
 * @param {String} text Human readable text
 * @param {String|Array} [code] Response code, eg. "TRYCREATE", sent as [TRYCREATE], or a list of
 *   atoms like ["METADATA", "MAXSIZE", 1024], sent as [METADATA MAXSIZE 1024]
 * @param {String} [description] Description for output handlers, defaults to the command name,
 *   with " FAILED" appended for NO and BAD
 */
IMAPConnection.prototype.sendStatus = function (parsed, data, command, text, code, description) {
    const attributes = [];
    if (code) {
        attributes.push({
            type: 'SECTION',
            section: [].concat(code).map(value => ({
                type: 'ATOM',
                value: String(value)
            }))
        });
    }
    attributes.push({
        type: 'TEXT',
        value: text
    });

    if (!description) {
        description = (parsed.command || '').toString().toUpperCase() + (command === 'OK' ? '' : ' FAILED');
    }

    this.send(
        {
            tag: parsed.tag,
            command,
            attributes
        },
        description,
        parsed,
        data
    );
};

/**
 * Checks if a command was sent without waiting for an earlier command in a way that RFC 3501
 * section 5.5 forbids: after any command other than FETCH, STORE or SEARCH (or another command with
 * the noExpunge option, like SORT and THREAD from RFC 5256) the client must
 * wait for the completion result before it sends a command with message sequence numbers,
 * because an EXPUNGE response could change what the numbers refer to. A command was sent
 * without waiting if such a command is still queued or running, or if it completed in the
 * same read as this command arrived in.
 *
 * @param {Object} parsed Parsed command
 * @return {Boolean} true if the command is ambiguous
 */
IMAPConnection.prototype.isAmbiguous = function (parsed) {
    if (!this.usesSequenceNumbers(parsed)) {
        return false;
    }
    if (this._unsafeCompletedRead === this._readCount) {
        return true;
    }
    const isUnsafe = element => element && !this.server.getCommandOptions(element.parsed.command).noExpunge;
    return isUnsafe(this._runningCommand) || this._commandQueue.some(isUnsafe);
};

/**
 * Checks if a command refers to messages by sequence number (RFC 3501 section 5.5)
 *
 * @param {Object} parsed Parsed command
 * @return {Boolean} true if the command uses message sequence numbers
 */
IMAPConnection.prototype.usesSequenceNumbers = function (parsed) {
    const command = (parsed.command || '').toUpperCase();
    if (['FETCH', 'STORE', 'COPY', 'MOVE', 'REPLACE'].indexOf(command) >= 0) {
        // other forms of sequence sets, like "$" of SEARCHRES (RFC 5182 section 2.3), do not use numbers
        const first = parsed.attributes && parsed.attributes[0];
        return !first || /^[\d*]/.test(String(first.value));
    }
    const searchCriteria = this.server.getCommandOptions(command).searchCriteria;
    if (searchCriteria !== false) {
        return hasSequenceSetKey(this.server, (parsed.attributes || []).slice(searchCriteria));
    }
    return false;
};

/**
 * Decodes a SASL client response. It must be valid base64 by the RFC 3501 section 9 grammar,
 * "=" stands for an empty initial response (RFC 4959 section 3).
 *
 * @param {String} str Client response
 * @return {Buffer|Boolean} Decoded value, or false if the input is not valid base64
 */
IMAPConnection.prototype.decodeSaslResponse = function (str) {
    if (str === '=') {
        return Buffer.alloc(0);
    }
    if (typeof str !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(str)) {
        return false;
    }
    return Buffer.from(str, 'base64');
};

/**
 * Returns the target mailbox of APPEND, COPY or MOVE. If messages can not be added
 * to it, a tagged NO is sent and false is returned
 *
 * @param {String} path Mailbox path
 * @param {Object} parsed Parsed command
 * @param {String} data Raw command
 * @param {String} description Description for the failure response
 * @return {Object|false} Mailbox object
 */
IMAPConnection.prototype.getTargetMailbox = function (path, parsed, data, description) {
    const mailbox = this.server.getMailbox(path);
    if (!mailbox) {
        // TRYCREATE tells the client that CREATE would help (RFC 3501 sections 6.3.11 and 6.4.7)
        this.sendStatus(parsed, data, 'NO', 'Target mailbox does not exist', 'TRYCREATE', description);
        return false;
    }
    if (mailbox.flags.indexOf('\\Noselect') >= 0) {
        // a \Noselect name only holds other mailboxes, CREATE turns it into a mailbox, so TRYCREATE applies
        // (RFC 9051 sections 6.3.12 and 6.4.7: unless it is certain that the target can not be created)
        this.sendStatus(parsed, data, 'NO', 'Target mailbox is not selectable', 'TRYCREATE', description);
        return false;
    }
    return mailbox;
};

/**
 * Runs the checks of `server.appendChecks` before messages are added to a mailbox. A check
 * returns nothing if the messages may be added, or `{ code, text, soft }`: a hard failure is
 * sent as a tagged NO with the response code and false is returned, a soft one (`soft: true`)
 * only as an untagged NO warning, e.g. `* NO [OVERQUOTA] ...` (RFC 9208 section 4.3.1).
 *
 * @param {Object} mailbox Target mailbox
 * @param {Array} messages Messages to add, objects with the message source as `raw`
 * @param {Object} parsed Parsed command
 * @param {String} data Raw command
 * @param {String} description Description for the failure response
 * @param {Object} [options] `{ move, source }`, set for MOVE with the source mailbox, or `{ command, replaced }`
 *   for APPEND like commands (APPEND, REPLACE), `replaced` is the message that REPLACE removes
 * @return {Boolean} true if the messages may be added
 */
IMAPConnection.prototype.checkAppend = function (mailbox, messages, parsed, data, description, options) {
    return this.applyChecks(
        this.server.appendChecks.map(check => check(this, mailbox, messages, options || {})),
        parsed,
        data,
        description
    );
};

/**
 * Reports the results of checks like `server.appendChecks`: the first hard failure as a tagged
 * NO, or soft ones as untagged NO warnings
 *
 * @param {Array} results Check results, `{ code, text, soft }` or nothing
 * @param {Object} parsed Parsed command
 * @param {String} data Raw command
 * @param {String} description Description for the failure response
 * @return {Boolean} false if the command failed
 */
IMAPConnection.prototype.applyChecks = function (results, parsed, data, description) {
    results = results.filter(result => result);

    const failure = results.find(result => !result.soft);
    if (failure) {
        this.sendStatus(parsed, data, 'NO', failure.text, failure.code, description);
        return false;
    }

    results.forEach(result => {
        this.send(
            {
                tag: '*',
                command: 'NO',
                attributes: [
                    { type: 'SECTION', section: [{ type: 'ATOM', value: result.code }] },
                    { type: 'TEXT', value: result.text }
                ]
            },
            'CHECK WARNING',
            parsed,
            data
        );
    });
    return true;
};

/**
 * Formats a mailbox name for a response: an atom when possible, otherwise a string. NIL and names
 * like \\Foo would not read back as mailbox names, so these are strings as well
 *
 * @param {String} name Mailbox name as sent to the client
 * @return {Object} Response attribute
 */
function mailboxAttribute(name) {
    return { type: ATOM_REGEX.test(name) && !/^NIL$/i.test(name) ? 'ATOM' : 'STRING', value: name };
}

/**
 * Converts a mailbox name from a command to the name used in storage, which is modified UTF-7
 * (RFC 3501 section 5.1.3). A plugin can replace this per connection, e.g. UTF8=ACCEPT.
 *
 * @param {String} name Mailbox name as a binary string
 * @return {String} Storage name
 * @throws {Error} BAD error if the name is not valid
 */
IMAPConnection.prototype.importMailboxName = function (name) {
    const error = validateMailboxName(name);
    if (error) {
        const err = new Error(error);
        err.imapResponse = 'BAD';
        throw err;
    }
    return name;
};

/**
 * Converts a mailbox name from storage to the form sent to the client. Every response that
 * includes a mailbox name must use this. A plugin can replace this per connection.
 *
 * @param {String} path Storage name
 * @return {String} Mailbox name as a binary string
 */
IMAPConnection.prototype.exportMailboxName = function (path) {
    return path;
};

/**
 * Checks the mailbox name arguments of a command and replaces them with the storage names.
 * Arguments that are not strings are left to the command handler.
 *
 * @param {Object} connection IMAP connection
 * @param {Object} parsed Parsed command
 * @param {Array} positions Argument positions that hold mailbox names
 * @return {String|Boolean} Description of the problem, or false if the names are valid
 */
function importMailboxArguments(connection, parsed, positions) {
    for (const position of positions) {
        const attr = (parsed.attributes || [])[position];
        if (attr && ['STRING', 'ATOM', 'LITERAL'].indexOf(attr.type) >= 0) {
            try {
                attr.value = connection.importMailboxName(attr.value);
            } catch (err) {
                return err.message;
            }
        }
    }
    return false;
}

IMAPConnection.prototype.scheduleCommand = function (data) {
    let parsed;
    const tag = getResponseTag(data);

    try {
        // server.parserOptions are the defaults of plugins, connection.parserOptions win
        parsed = imapHandler.parser(data, Object.assign({ literalPlus: this.server.literalPlus }, this.server.parserOptions, this.parserOptions));
    } catch (E) {
        this.send(
            {
                tag: '*',
                command: 'BAD',
                attributes: [
                    {
                        type: 'SECTION',
                        section: [
                            {
                                type: 'ATOM',
                                value: 'SYNTAX'
                            }
                        ]
                    },
                    {
                        type: 'TEXT',
                        value: E.message
                    }
                ]
            },
            'ERROR MESSAGE',
            null,
            data,
            E
        );

        this.send(
            {
                tag: tag,
                command: 'BAD',
                attributes: [
                    {
                        type: 'TEXT',
                        value: 'Error parsing command'
                    }
                ]
            },
            'ERROR RESPONSE',
            null,
            data,
            E
        );

        return;
    }

    if (this.server.getCommandHandler(parsed.command)) {
        if (this.isAmbiguous(parsed)) {
            this.sendStatus(parsed, data, 'BAD', 'Commands with message sequence numbers must wait for the completion of earlier commands');
            return;
        }
        this._commandQueue.push({
            parsed: parsed,
            data: data
        });
        this.processQueue();
    } else if (/^AUTHENTICATE /i.test(parsed.command)) {
        // an unsupported mechanism is a NO, not a syntax error (RFC 3501 section 6.2.2)
        this.send(
            {
                tag: parsed.tag,
                command: 'NO',
                attributes: [
                    {
                        type: 'TEXT',
                        value: 'Unsupported authentication mechanism'
                    }
                ]
            },
            'UNKNOWN COMMAND',
            parsed,
            data
        );
    } else {
        this.send(
            {
                tag: parsed.tag,
                command: 'BAD',
                attributes: [
                    {
                        type: 'TEXT',
                        value: 'Invalid command ' + parsed.command + ''
                    }
                ]
            },
            'UNKNOWN COMMAND',
            parsed,
            data
        );
    }
};

IMAPConnection.prototype.processQueue = function (force) {
    if (!force && this._processing) {
        return;
    }

    if (!this._commandQueue.length) {
        this._processing = false;
        return;
    }

    this._processing = true;

    const element = this._commandQueue.shift();
    const command = element.parsed.command.toUpperCase();
    this._runningCommand = element;
    const options = this.server.getCommandOptions(command);
    let done = false;
    const next = () => {
        if (done) {
            // a handler must release the queue only once
            return;
        }
        done = true;
        this._runningCommand = null;
        if (!options.noExpunge) {
            // commands with sequence numbers that arrive in the same read did not wait for this one
            this._unsafeCompletedRead = this._readCount;
        }
        if (!this._commandQueue.length) {
            this._processing = false;
        } else {
            this.processQueue(true);
        }
    };

    if (options.states && options.states.indexOf(this.state) < 0) {
        this.sendStatus(element.parsed, element.data, 'BAD', stateError(command, this.state));
        return next();
    }

    if (element.parsed.attributes && options.noArguments) {
        this.sendStatus(element.parsed, element.data, 'BAD', command + ' does not take any arguments');
        return next();
    }

    const nameError = importMailboxArguments(this, element.parsed, options.mailboxArguments);
    if (nameError) {
        this.sendStatus(element.parsed, element.data, 'BAD', nameError);
        return next();
    }

    for (const check of this.server.commandChecks) {
        const refusal = check(this, element.parsed);
        if (refusal) {
            this.sendStatus(element.parsed, element.data, refusal.command || 'BAD', refusal.text, refusal.code);
            return next();
        }
    }

    try {
        // changes made while the handler runs are attributed to this session (the `origin` of notifications)
        this.server.activeConnection = this;
        this.server.getCommandHandler(element.parsed.command)(this, element.parsed, element.data, next);
    } catch (ex) {
        const badInput = ex.imapResponse === 'BAD';
        if (!badInput && this.options.debug) {
            console.error('Error processing command:', ex, '\n', ex.stack);
        }
        this.send(
            {
                tag: element.parsed.tag,
                command: badInput ? 'BAD' : 'NO',
                attributes: [].concat(
                    badInput
                        ? []
                        : {
                              type: 'SECTION',
                              section: [
                                  {
                                      type: 'ATOM',
                                      value: 'SERVERBUG'
                                  }
                              ]
                          },
                    {
                        type: 'TEXT',
                        value: badInput ? ex.message : 'Server error: ' + ex.message
                    }
                )
            },
            badInput ? 'INVALID COMMAND' : 'SERVER ERROR',
            element.parsed,
            element.data
        );
        // keep the connection usable, otherwise every later command would hang
        next();
    } finally {
        this.server.activeConnection = null;
    }
};

/**
 * Removes messages with \Deleted flag
 *
 * @param {Object} mailbox Mailbox to check for
 * @param {Boolean} [ignoreSelf] If set to true, does not send any notices to itself
 * @param {Boolean} [ignoreSelf] If set to true, does not send EXISTS notice to itself
 */
IMAPConnection.prototype.expungeDeleted = function (mailbox, ignoreSelf, ignoreExists) {
    this.expungeSpecificMessages(
        mailbox,
        message => {
            return message.flags.indexOf('\\Deleted') >= 0;
        },
        ignoreSelf,
        ignoreExists
    );
};

/**
 * Given a set of messages in a mailbox (possibly via getMessageRange), remove
 * them from the mailbox and generate EXPUNGE notifications.
 *
 * @param {Object} mailbox Mailbox to check for
 * @param {Function|Array} messagesOrFilterFunc An Array of messages in the
 *     folder that should be removed or a filtering function that indicates
 *     messages to be removed by returning true.
 * @param {Boolean} [ignoreSelf] If set to true, does not send any notices to itself
 * @param {Boolean} [ignoreSelf] If set to true, does not send EXISTS notice to itself
 * @param {Boolean} [highestFirst] If set to true, the EXPUNGE responses go from the highest UID to the lowest
 *     (MESSAGELIMIT, RFC 9738 section 3.1), otherwise from the lowest
 */
IMAPConnection.prototype.expungeSpecificMessages = function (mailbox, messagesOrFilterFunc, ignoreSelf, ignoreExists, highestFirst) {
    let filterFunc;
    if (Array.isArray(messagesOrFilterFunc)) {
        const messageSet = new Set(messagesOrFilterFunc);
        filterFunc = message => messageSet.has(message);
    } else {
        filterFunc = messagesOrFilterFunc;
    }

    // sequence numbers of the removed messages, each one as it is after the earlier EXPUNGE responses. From the
    // highest message down, the earlier responses do not change the sequence numbers of the later ones
    const expunged = [];
    const kept = [];
    mailbox.messages.forEach((message, i) => {
        if (filterFunc(message)) {
            message.ghost = true;
            expunged.push({ seq: highestFirst ? i + 1 : kept.length + 1, message });
        } else {
            kept.push(message);
        }
    });

    if (!expunged.length) {
        return;
    }

    // old copy is required for those sessions that run FETCH before
    // displaying the EXPUNGE notice
    const mailboxCopy = mailbox.messages.slice();

    // update the list in place, other code might hold a reference to it
    kept.forEach((message, i) => {
        mailbox.messages[i] = message;
    });
    mailbox.messages.length = kept.length;

    // lets plugins track the removal (e.g. mod-sequences of CONDSTORE and QRESYNC) before any notification
    this.server.emit(
        'expunge',
        mailbox,
        expunged.map(entry => entry.message),
        this
    );

    (highestFirst ? expunged.slice().reverse() : expunged).forEach(entry => {
        this.server.notify(
            {
                tag: '*',
                attributes: [
                    entry.seq,
                    {
                        type: 'ATOM',
                        value: 'EXPUNGE'
                    }
                ],
                // the removed message, for plugins that report it differently (e.g. VANISHED of QRESYNC)
                message: entry.message
            },
            mailbox,
            ignoreSelf ? this : false
        );
    });

    this.server.notify(
        {
            tag: '*',
            attributes: [
                mailbox.messages.length,
                {
                    type: 'ATOM',
                    value: 'EXISTS'
                }
            ],
            // distribute the old mailbox data with the notification
            mailboxCopy: mailboxCopy
        },
        mailbox,
        ignoreSelf || ignoreExists ? this : false
    );
};
