'use strict';

const Stream = require('stream').Stream;
const util = require('util');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const imapHandler = require('imap-handler');
const loadPlugins = require('./load-plugins');
const { getCommandStates, takesNoArguments, usesSequenceNumbers } = require('./command-states');
const validateMailboxName = require('./mailbox-name');

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// longest command line (not counting literals) accepted from a client
const MAX_LINE_LENGTH = 1024 * 1024;
// largest literal accepted after login, override with the maxLiteralSize option
const MAX_LITERAL_SIZE = 64 * 1024 * 1024;
// largest literal accepted before login, enough for any user name or password
const MAX_PREAUTH_LITERAL_SIZE = 64 * 1024;

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
    this.outputHandlers = [];
    this.messageHandlers = [];
    this.fetchHandlers = {};
    this.fetchFilters = [];
    this.searchHandlers = {};
    this.storeHandlers = {};
    this.storeFilters = [];
    this.commandHandlers = {};
    // states for commands that plugins add, core commands are listed in command-states.js
    this.commandStates = Object.create(null);
    this.capabilities = {};
    this.allowedStatus = ['MESSAGES', 'RECENT', 'UIDNEXT', 'UIDVALIDITY', 'UNSEEN'];
    this.literalPlus = false;
    this.referenceNamespace = false;

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

IMAPServer.prototype.setCommandHandler = function (command, handler, states) {
    command = (command || '').toString().toUpperCase();
    this.commandHandlers[command] = handler;
    if (states) {
        this.commandStates[command] = [].concat(states);
    }
};

/**
 * Returns the connection states a command may be used in
 *
 * @param {String} command Command name
 * @return {Array|Boolean} List of states, or false if any state is fine
 */
IMAPServer.prototype.getCommandStates = function (command) {
    command = (command || '').toString().toUpperCase();
    return this.commandStates[command] || getCommandStates(command);
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
 */
IMAPServer.prototype.notify = function (command, mailbox, ignoreConnection) {
    command.notification = true;
    this.emit('notify', {
        command: command,
        mailbox: mailbox,
        ignoreConnection: ignoreConnection
    });
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

    let handler;

    // try to autoload if not supported
    if (!this.commandHandlers[command]) {
        try {
            handler = require('./commands/' + command.toLowerCase());
            this.setCommandHandler(command, handler);
        } catch (E) {
            //console.log(E);
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
    const permanentFlags = [].concat(mailbox.permanentFlags || []);

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
    const day = Number(match[1]);
    const month = MONTHS.indexOf(match[2].toLowerCase());
    const year = Number(match[3]);
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return day >= 1 && day <= daysInMonth && Number(match[4]) < 24 && Number(match[5]) < 60 && Number(match[6]) < 61 && Number(match[8]) < 60;
};

/**
 * Converts a date object to a valid date-time string format
 *
 * @param {Object} date Date object to be converted
 * @return {String} Returns a valid date-time formatted string
 */
IMAPServer.prototype.formatInternalDate = function (date) {
    const day = date.getDate();
    const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getMonth()];
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

        if (curPath === path && defaultMailbox) {
            if (folder && folder.folders) {
                // keep the children of a \Noselect placeholder that gets replaced
                defaultMailbox.folders = Object.assign({}, folder.folders, defaultMailbox.folders);
            }
            folder = defaultMailbox;
            this.processMailbox(curPath, folder, namespace);
            parent.folders = parent.folders || {};
            parent.folders[folderName] = folder;
            this.folderCache[curPath] = folder;
        } else if (!folder) {
            folder = {
                subscribed: false,
                // a recreated mailbox must never reuse an earlier UIDVALIDITY value
                uidvalidity: ++this.uidvalidityCounter
            };
            this.processMailbox(curPath, folder, namespace);
            parent.folders = parent.folders || {};
            parent.folders[folderName] = folder;
            this.folderCache[curPath] = folder;
        } else if (curPath === path && folder.flags.indexOf('\\Noselect') >= 0) {
            // turn a \Noselect placeholder into a real mailbox
            this.removeFlag(folder.flags, '\\Noselect');
            folder.messages = [];
            folder.uidvalidity = ++this.uidvalidityCounter;
        }

        if (parent !== storage) {
            // Remove NoSelect if needed
            this.removeFlag(parent.flags, '\\Noselect');

            // Remove \HasNoChildren and add \\HasChildren from parent
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

        if (!mailbox || (mailbox.flags.indexOf('\\Noselect') >= 0 && Object.keys(mailbox.folders || {}).length)) {
            throw mailboxError('Mailbox does not exist', 'NONEXISTENT');
        }

        folderPath = folderPath.split(storage.separator);
        folderName = folderPath.pop();

        parentKey = folderPath.join(storage.separator);
        if (parentKey !== 'INBOX') {
            parent = this.folderCache[folderPath.join(storage.separator)] || parent;
        }

        if (mailbox.folders && Object.keys(mailbox.folders).length && !keepContents) {
            // anyone who has this mailbox selected is going to stay with
            // `reference` object. any new select is going to go to `folder`
            const reference = mailbox;
            const folder = {};

            Object.keys(reference).forEach(key => {
                folder[key] = reference[key];
            });
            folder.messages = [];
            folder.flags = [].concat(reference.flags);

            this.ensureFlag(folder.flags, '\\Noselect');
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

    mailbox.subscribed = 'subscribed' in mailbox ? !!mailbox.subscribed : true;

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

IMAPServer.prototype.processMessage = function (message, mailbox) {
    // internaldate should always be a Date object
    message.internaldate = message.internaldate || new Date();
    if (Object.prototype.toString.call(message.internaldate) === '[object Date]') {
        message.internaldate = this.formatInternalDate(message.internaldate);
    } else if (typeof message.internaldate === 'string') {
        // month names are accepted in any case but always sent as "Jan", "Feb", ...
        message.internaldate = message.internaldate.replace(
            /-([a-z]{3})-/i,
            (m, month) => '-' + month.charAt(0).toUpperCase() + month.substr(1).toLowerCase() + '-'
        );
    }
    message.flags = [].concat(message.flags || []);
    if (message.flags.indexOf('\\Recent') >= 0) {
        // \Recent is not a stored flag, it belongs to the first session that selects the mailbox
        this.removeFlag(message.flags, '\\Recent');
        message.recent = true;
    }
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
 * @return An object of the form { mailbox, message }
 */
IMAPServer.prototype.appendMessage = function (mailbox, flags, internaldate, raw, ignoreConnection) {
    if (typeof mailbox === 'string') {
        mailbox = this.getMailbox(mailbox);
    }

    const message = {
        flags: flags,
        internaldate: internaldate,
        raw: raw,
        recent: true
    };

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
            ]
        },
        mailbox,
        ignoreConnection
    );

    return { mailbox: mailbox, message: message };
};

IMAPServer.prototype.matchFolders = function (reference, match) {
    let includeINBOX = false;

    reference = reference || '';
    if (reference === '' && this.referenceNamespace !== false) {
        reference = this.referenceNamespace;
        includeINBOX = true;
    }

    // the reference does not have to be a namespace, use the namespace it belongs to
    let nsKey = false;
    Object.keys(this.storage).forEach(key => {
        if (key !== 'INBOX' && reference.substr(0, key.length) === key && (nsKey === false || key.length > nsKey.length)) {
            nsKey = key;
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
    if (includeINBOX && ((reference ? reference + namespace.separator : '') + 'INBOX').match(new RegExp(pattern, 'i'))) {
        result.push(this.folderCache.INBOX);
    }

    Object.keys(this.folderCache).forEach(path => {
        if (
            path.match(query) &&
            (this.folderCache[path].flags.indexOf('\\NonExistent') < 0 || this.folderCache[path].path === match) &&
            this.folderCache[path].namespace === nsKey
        ) {
            result.push(this.folderCache[path]);
        }
    });

    return result;
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

    this._commandQueue = [];
    this._processing = false;

    if (this.options.debug) {
        this.socket.pipe(process.stdout);
    }

    this.socket.on('data', this.onData.bind(this));
    this.socket.on('close', this.onClose.bind(this));
    this.socket.on('error', this.onError.bind(this));

    this.directNotifications = false;
    this._notificationCallback = this.onNotify.bind(this);
    this.notificationQueue = [];
    this.server.on('notify', this._notificationCallback);
    this.server.connections.add(this);

    this.socket.write('* OK Hoodiecrow ready for rumble\r\n');
}

IMAPConnection.prototype.onClose = function () {
    if (this.socket) {
        this.socket.removeAllListeners();
        this.socket = null;
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
        this.send({ tag: tag, command: 'BAD', attributes: [{ type: 'TEXT', value: 'Command line too long' }] }, 'LINE TOO LONG');
    }

    if (this._literalRemaining) {
        if (this._literalRemaining > str.length) {
            this._literalRemaining -= str.length;
            this._command += str;
            return;
        }
        this._command += str.substr(0, this._literalRemaining);
        str = str.substr(this._literalRemaining);
        this._literalRemaining = 0;
    }

    // non-synchronizing literals are only valid when LITERAL+ is advertised
    const lineEndRegex = this.server.literalPlus ? /(\{(\d+)(\+)?\})?(\r?)\n/ : /(\{(\d+)\})?(\r?)\n/;

    this._remainder = str = this._remainder + str;
    while ((match = str.match(lineEndRegex))) {
        const crIndex = this.server.literalPlus ? 4 : 3;
        if (!match[crIndex]) {
            // every command line ends with CRLF (RFC 3501 section 9), a bare LF is refused
            const line = this._command + str.substr(0, match.index + match[0].length - 1);
            const tag = this.inputHandler ? '*' : (line.match(/^([^\s]+)/) || [])[1] || '*';
            this.send({ tag: tag, command: 'BAD', attributes: [{ type: 'TEXT', value: 'Lines must end with CRLF' }] }, 'INVALID LINE ENDING', null, line);
            this._remainder = str = str.substr(match.index + match[0].length);
            this._command = '';
            continue;
        }

        if (!match[2]) {
            const line = this._command + str.substr(0, match.index);
            if (this._earlyLiteral) {
                // the client sent literal data without waiting for the continuation request
                this._earlyLiteral = false;
                const tag = (line.match(/^([^\s]+)/) || [])[1] || '*';
                this.send(
                    { tag: tag, command: 'BAD', attributes: [{ type: 'TEXT', value: 'Literal data must wait for the continuation request' }] },
                    'LITERAL TOO EARLY',
                    null,
                    line
                );
            } else if (this.inputHandler) {
                this.inputHandler(line);
            } else {
                this.scheduleCommand(line);
            }

            if (this.upgrading) {
                // STARTTLS was accepted, ignore any pipelined plaintext input
                return;
            }

            this._remainder = str = str.substr(match.index + match[0].length);
            this._command = '';
            continue;
        }

        const literalSize = Number(match[2]);
        const literalError = this.checkLiteral(this._command + str.substr(0, match.index), literalSize);
        if (literalError) {
            const line = this._command + str.substr(0, match.index);
            if (match[3] === '+') {
                // the client is going to send the literal anyway, so there is no way to recover
                this.send({ tag: '*', command: 'BYE', attributes: [{ type: 'TEXT', value: literalError }] }, 'LITERAL REFUSED');
                this._remainder = this._command = '';
                if (this.socket) {
                    this.socket.end();
                }
                return;
            }
            // refuse a synchronizing literal by not sending a continuation request
            const tag = (line.match(/^([^\s]+)/) || [])[1] || '*';
            this.send({ tag: tag, command: 'BAD', attributes: [{ type: 'TEXT', value: literalError }] }, 'LITERAL REFUSED', null, line);
            this._remainder = str = str.substr(match.index + match[0].length);
            this._command = '';
            continue;
        }

        if (match[3] !== '+') {
            if (str.length > match.index + match[0].length) {
                // RFC 3501 section 4.3: the client MUST wait for the continuation request
                // before sending the octets of a synchronizing literal
                this._earlyLiteral = true;
            } else if (!this._earlyLiteral && this.socket && !this.socket.destroyed) {
                this.socket.write('+ Go ahead\r\n');
            }
        }

        this._remainder = '';
        this._command += str.substr(0, match.index + match[0].length);
        this._literalRemaining = literalSize;

        str = str.substr(match.index + match[0].length);

        if (this._literalRemaining > str.length) {
            this._command += str;
            this._literalRemaining -= str.length;
            return;
        } else {
            this._command += str.substr(0, this._literalRemaining);
            this._remainder = str = str.substr(this._literalRemaining);
            this._literalRemaining = 0;
        }
    }

    if (this._remainder.length > MAX_LINE_LENGTH) {
        // RFC 3501 section 7.1.3
        this.send({ tag: '*', command: 'BAD', attributes: [{ type: 'TEXT', value: 'Command line too long' }] }, 'LINE TOO LONG');
        const tag = ((this._command || this._remainder).match(/^([^\s]+)/) || [])[1];
        this._remainder = '';
        this._command = '';
        // a tag can only be used if it is a valid one, otherwise "*" is used
        this._discardLine = tag && /^(?:(?![(){%*"\\+])[!-~])+$/.test(tag) ? tag : '*';
    }
};

/**
 * Checks if a literal may be accepted for the command line received so far. Literals are
 * refused before they are read when they are too large, or when the command is unknown or
 * not allowed in the current state, so the client does not get a continuation request for
 * a command that is going to fail anyway.
 *
 * @param {String} line Command line up to the literal size marker
 * @param {Number} literalSize Size of the literal in octets
 * @return {String|Boolean} Reason to refuse the literal, or false
 */
IMAPConnection.prototype.checkLiteral = function (line, literalSize) {
    const maxLiteralSize = this.getMaxLiteralSize();
    if (literalSize > maxLiteralSize || line.length + literalSize > maxLiteralSize + MAX_LINE_LENGTH) {
        return 'Literal too large';
    }

    if (this.inputHandler) {
        // not a command, e.g. a SASL response
        return false;
    }

    const words = line.split(' ');
    let command = (words[1] || '').toUpperCase();
    if (['UID', 'AUTHENTICATE'].indexOf(command) >= 0) {
        command += ' ' + (words[2] || '').toUpperCase();
    }

    if (!/^[A-Z0-9]+( [A-Z0-9]+)?$/.test(command) || !this.server.getCommandHandler(command)) {
        return 'Unknown command';
    }

    const states = this.server.getCommandStates(command);
    if (states && states.indexOf(this.state) < 0) {
        return command + ' is not allowed in the ' + this.state + ' state';
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
 * Checks if this session has EXPUNGE notifications that it has not been told about yet
 *
 * @return {Boolean} true if an EXPUNGE response is pending
 */
IMAPConnection.prototype.hasPendingExpunge = function () {
    return this.notificationQueue.some(notification => notification.attributes && (notification.attributes[1] || {}).value === 'EXPUNGE');
};

/**
 * Sends an unsolicited FETCH with the flags another session changed. The sequence number
 * is the one this session knows, so EXPUNGE responses that are still queued are taken
 * into account. The UID is always included, RFC 9051 section 6.3.13 requires it for
 * unsolicited FETCH responses and it is valid in IMAP4rev1 as well.
 *
 * @param {Object} message Message with changed flags
 * @param {Array} pending Notifications queued after this one
 */
IMAPConnection.prototype.sendFlagUpdate = function (message, pending) {
    const snapshot = pending.find(notification => notification.mailboxCopy);
    const messages = snapshot ? snapshot.mailboxCopy : this.selectedMailbox ? this.selectedMailbox.messages : [];
    const index = messages.indexOf(message);
    if (index < 0 || message.ghost) {
        // the message is gone, its EXPUNGE response tells the rest
        return;
    }

    this.send(
        {
            tag: '*',
            notification: true,
            attributes: [
                index + 1,
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
                    this.getFlags(message).map(flag => ({
                        type: 'ATOM',
                        value: flag
                    }))
                ]
            ]
        },
        'FLAG NOTIFICATION',
        null,
        null,
        message
    );
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

IMAPConnection.prototype.onNotify = function (notification) {
    if (notification.ignoreConnection === this) {
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
        this.notificationQueue.push(command);
        if (this.directNotifications) {
            this.processNotifications();
        }
    }
};

IMAPConnection.prototype.upgradeConnection = function (callback) {
    this.upgrading = true;

    // Anything the client sent after STARTTLS in plaintext must not be executed
    // after the upgrade (RFC 9051 section 6.2.1)
    this._commandQueue = [];
    this._remainder = '';
    this._command = '';
    this._literalRemaining = 0;

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
        this.socket.on('data', this.onData.bind(this));
        callback();
    });
};

IMAPConnection.prototype.processNotifications = function (data) {
    let notification;
    for (let i = 0; i < this.notificationQueue.length; i++) {
        notification = this.notificationQueue[i];

        if (data && ['FETCH', 'STORE', 'SEARCH'].indexOf((data.command || '').toUpperCase()) >= 0) {
            continue;
        }

        if (notification.flagUpdate) {
            this.sendFlagUpdate(notification.flagUpdate, this.notificationQueue.slice(i + 1));
            this.notificationQueue.splice(i, 1);
            i--;
            continue;
        }

        this.send(notification);
        this.notificationQueue.splice(i, 1);
        i--;
        continue;
    }
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

    if (response.tag !== '*' && response.tag !== '+' && ['OK', 'NO', 'BAD'].indexOf((response.command || '').toUpperCase()) >= 0) {
        this.commandCompleted(response.tag);
    }

    let compiled;
    try {
        compiled = imapHandler.compiler(response);
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

    if (this.socket && !this.socket.destroyed) {
        this.socket.write(Buffer.from(compiled + '\r\n', 'binary'));
    }
};

/**
 * Sends a tagged status response to a command
 *
 * @param {Object} parsed Parsed command
 * @param {String} data Raw command
 * @param {String} command Response type: OK, NO or BAD
 * @param {String} text Human readable text
 * @param {String} [code] Response code, eg. "TRYCREATE", sent as [TRYCREATE]
 * @param {String} [description] Description for output handlers, defaults to the command name,
 *   with " FAILED" appended for NO and BAD
 */
IMAPConnection.prototype.sendStatus = function (parsed, data, command, text, code, description) {
    const attributes = [];
    if (code) {
        attributes.push({
            type: 'SECTION',
            section: [
                {
                    type: 'ATOM',
                    value: code
                }
            ]
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
 * Returns the target mailbox of APPEND, COPY or MOVE. If messages can not be added
 * to it, a tagged NO is sent and false is returned
 *
 * @param {String} path Mailbox path
 * @param {Object} parsed Parsed command
 * @param {String} data Raw command
 * @param {String} description Description for the failure response
 * @return {Object|false} Mailbox object
 */
/**
 * Checks if a command was sent without waiting for an earlier command in a way that RFC 3501
 * section 5.5 forbids: after any command other than FETCH, STORE or SEARCH the client must
 * wait for the completion result before it sends a command with message sequence numbers,
 * because an EXPUNGE response could change what the numbers refer to. A command was sent
 * without waiting if it arrived in the same read as the completion of an earlier command,
 * or while that command was still running.
 *
 * @param {Object} parsed Parsed command
 * @return {Boolean} true if the command is ambiguous
 */
IMAPConnection.prototype.isAmbiguous = function (parsed) {
    const read = this._readCount || 0;
    // commands completed before this read are not relevant any more
    this._outstanding = (this._outstanding || []).filter(entry => entry.completedIn === null || entry.completedIn >= read);

    const waiting = this._outstanding.some(entry => ['FETCH', 'STORE', 'SEARCH'].indexOf(entry.command) < 0);
    const ambiguous = waiting && usesSequenceNumbers(parsed);

    this._outstanding.push({
        tag: parsed.tag,
        command: (parsed.command || '').toUpperCase(),
        completedIn: ambiguous ? read : null
    });
    return ambiguous;
};

/**
 * Marks a command as completed once its tagged response is sent
 *
 * @param {String} tag Command tag
 */
IMAPConnection.prototype.commandCompleted = function (tag) {
    const entries = this._outstanding || [];
    for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].tag === tag && entries[i].completedIn === null) {
            entries[i].completedIn = this._readCount || 0;
            return;
        }
    }
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
 * Checks that a mailbox name argument uses modified UTF-7 (RFC 3501 section 5.1.3) and
 * sends a tagged BAD if it does not
 *
 * @param {String} name Mailbox name from the command
 * @param {Object} parsed Parsed command
 * @param {String} data Raw command
 * @param {String} [description] Description for output handlers
 * @return {Boolean} true if the name is valid
 */
IMAPConnection.prototype.checkMailboxName = function (name, parsed, data, description) {
    const error = validateMailboxName(name);
    if (error) {
        this.sendStatus(parsed, data, 'BAD', error, false, description);
        return false;
    }
    return true;
};

IMAPConnection.prototype.getTargetMailbox = function (path, parsed, data, description) {
    if (!this.checkMailboxName(path, parsed, data, description)) {
        return false;
    }
    const mailbox = this.server.getMailbox(path);
    if (!mailbox) {
        // TRYCREATE tells the client that CREATE would help (RFC 3501 sections 6.3.11 and 6.4.7)
        this.sendStatus(parsed, data, 'NO', 'Target mailbox does not exist', 'TRYCREATE', description);
        return false;
    }
    if (mailbox.flags.indexOf('\\Noselect') >= 0) {
        this.sendStatus(parsed, data, 'NO', 'Target mailbox is not selectable', false, description);
        return false;
    }
    return mailbox;
};

IMAPConnection.prototype.scheduleCommand = function (data) {
    let parsed;
    const tag = (data.match(/\s*([^\s]+)/) || [])[1] || '*';

    try {
        parsed = imapHandler.parser(data, {
            literalPlus: this.server.literalPlus
        });
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
    let done = false;
    const next = () => {
        if (done) {
            // a handler must release the queue only once
            return;
        }
        done = true;
        if (!this._commandQueue.length) {
            this._processing = false;
        } else {
            this.processQueue(true);
        }
    };

    const states = this.server.getCommandStates(element.parsed.command);
    if (states && states.indexOf(this.state) < 0) {
        this.sendStatus(element.parsed, element.data, 'BAD', element.parsed.command.toUpperCase() + ' is not allowed in the ' + this.state + ' state');
        return next();
    }

    if (element.parsed.attributes && takesNoArguments(element.parsed.command.toUpperCase())) {
        this.sendStatus(element.parsed, element.data, 'BAD', element.parsed.command.toUpperCase() + ' does not take any arguments');
        return next();
    }

    try {
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
 */
IMAPConnection.prototype.expungeSpecificMessages = function (mailbox, messagesOrFilterFunc, ignoreSelf, ignoreExists) {
    let filterFunc;
    if (Array.isArray(messagesOrFilterFunc)) {
        const messageSet = new Set(messagesOrFilterFunc);
        filterFunc = message => messageSet.has(message);
    } else {
        filterFunc = messagesOrFilterFunc;
    }

    // sequence numbers of the removed messages, each one as it is after the earlier EXPUNGE responses
    const expunged = [];
    const kept = [];
    mailbox.messages.forEach(message => {
        if (filterFunc(message)) {
            message.ghost = true;
            expunged.push(kept.length + 1);
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

    expunged.forEach(seq => {
        this.server.notify(
            {
                tag: '*',
                attributes: [
                    seq,
                    {
                        type: 'ATOM',
                        value: 'EXPUNGE'
                    }
                ]
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
