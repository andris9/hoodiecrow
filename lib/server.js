"use strict";

var Stream = require("stream").Stream,
    util = require("util"),
    net = require("net"),
    tls = require("tls"),
    fs = require("fs"),
    imapHandler = require("imap-handler"),
    starttls = require("./starttls");

module.exports = function(options){
    return new IMAPServer(options);
};

function IMAPServer(options){
    Stream.call(this);

    this.options = options || {};
    this.options.credentials = this.options.credentials || {
        key: fs.readFileSync(__dirname + "/../cert/server.key"),
        cert: fs.readFileSync(__dirname + "/../cert/server.crt")
    };

    if(this.options.secureConnection){
        this.server = tls.createServer(this.options.credentials, this.createClient.bind(this));
    }else{
        this.server = net.createServer(this.createClient.bind(this));
    }

    this.connectionHandlers = [];
    this.outputHandlers = [];
    this.messageHandlers = [];
    this.fetchHandlers = {};
    this.fetchFilters = [];
    this.searchHandlers = {};
    this.storeHandlers = {};
    this.storeFilters = [];
    this.commandHandlers = {};
    this.capabilities = {};
    this.allowedStatus = ["MESSAGES", "RECENT", "UIDNEXT", "UIDVALIDITY", "UNSEEN"];
    this.literalPlus = false;
    this.referenceNamespace = false;

    this.users = this.options.users || {
        "testuser":{
            password: "testpass",
            xoauth2:{
                accessToken: "testtoken",
                sessionTimeout: 3600 * 1000
            }
        }
    };

    [].concat(this.options.plugins).forEach((function(plugin){
        switch(typeof plugin){
            case "string":
                require("./plugins/"+plugin.toLowerCase())(this);
                break;
            case "function":
                plugin(this);
                break;
        }
    }).bind(this));

    this.systemFlags = [].concat(this.options.systemFlags || ["\\Answered", "\\Flagged", "\\Draft", "\\Deleted", "\\Seen"]);
    this.storage = this.options.storage || {"INBOX":{}, "":{}};
    this.uidnextCache = {}; // keep nextuid values if mailbox gets deleted
    this.folderCache = {};
    this.indexFolders();
}
util.inherits(IMAPServer, Stream);

IMAPServer.prototype.listen = function(){
    var args = Array.prototype.slice.call(arguments);
    this.server.listen.apply(this.server, args);
};

IMAPServer.prototype.close = function(callback){
    this.server.close(callback);
};

IMAPServer.prototype.createClient = function(socket){
    var connection = new IMAPConnection(this, socket);
    this.connectionHandlers.forEach((function(handler){
        handler(connection);
    }).bind(this));
};

IMAPServer.prototype.registerCapability = function(keyword, handler){
    this.capabilities[keyword] = handler || (function(){
        return true;
    });
};

IMAPServer.prototype.setCommandHandler = function(command, handler){
    command = (command || "").toString().toUpperCase();
    this.commandHandlers[command] = handler;
};

/**
 * Returns a mailbox object from folderCache
 *
 * @param {String} path Pathname for the mailbox
 * @return {Object} mailbox object or undefined
 */
IMAPServer.prototype.getMailbox = function(path){
    if(path.toUpperCase() == "INBOX"){
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
IMAPServer.prototype.notify = function(command, mailbox, ignoreConnection){
    command.notification = true;
    this.emit("notify", {
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
IMAPServer.prototype.getCommandHandler = function(command){
    command = (command || "").toString().toUpperCase();

    var handler;

    // try to autoload if not supported
    if(!this.commandHandlers[command]){
        try{
            handler = require("./commands/" + command.toLowerCase());
            this.setCommandHandler(command, handler);
        }catch(E){
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
IMAPServer.prototype.getStatus = function(mailbox){
    if(typeof mailbox == "string"){
        mailbox = this.getMailbox(mailbox);
    }
    if(!mailbox){
        return false;
    }

    var flags = {},
        seen = 0,
        unseen = 0,
        permanentFlags = [].concat(mailbox.permanentFlags || []);

    mailbox.messages.forEach((function(message){

        if(message.flags.indexOf("\\Seen") < 0){
            unseen++;
        }else{
            seen++;
        }

        message.flags.forEach((function(flag){
            if(!flags[flag]){
                flags[flag] = 1;
            }else{
                flags[flag]++;
            }

            if(permanentFlags.indexOf(flag) < 0){
                permanentFlags.push(flag);
            }
        }).bind(this));

    }).bind(this));

    return{
        flags: flags,
        seen: seen,
        unseen: unseen,
        permanentFlags: permanentFlags
    };
};

/**
 * Validates a date value. Useful for validating APPEND dates
 *
 * @param {String} date Date value to be validated
 * @return {Boolean} Returns true if the date string is in IMAP date-time format
 */
IMAPServer.prototype.validateInternalDate = function(date){
    if(!date || typeof date != "string"){
        return false;
    }
    return !!date.match(/^([ \d]\d)\-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([\-+])(\d{2})(\d{2})$/);
};

/**
 * Converts a date object to a valid date-time string format
 *
 * @param {Object} date Date object to be converted
 * @return {String} Returns a valid date-time formatted string
 */
IMAPServer.prototype.formatInternalDate = function(date){
    var day = date.getDate(),
        month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                 "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getMonth()],
        year = date.getFullYear(),
        hour = date.getHours(),
        minute = date.getMinutes(),
        second = date.getSeconds(),
        tz = date.getTimezoneOffset(),
        tzHours = Math.abs(Math.floor(tz / 60)),
        tzMins = Math.abs(tz) - tzHours * 60;

    return (day < 10 ? "0":"") + day + "-" + month + "-" + year + " " +
        (hour < 10 ? "0" : "") + hour + ":" + (minute < 10 ? "0" : "") +
            minute + ":" + (second < 10 ? "0" : "") + second + " " +
        (tz > 0 ? "-" : "+") + (tzHours < 10 ? "0" : "") + tzHours +
        (tzMins < 10 ? "0" : "") + tzMins;
};

/**
 * Creates a mailbox with specified path
 *
 * @param {String} path Pathname for the mailbox
 * @param {Object} [defaultMailbox] use this object as the mailbox to add instead of empty'
 */
IMAPServer.prototype.createMailbox = function(path, defaultMailbox){
    // Ensure case insensitive INBOX
    if(path.toUpperCase() == "INBOX"){
        throw new Error("INBOX can not be modified");
    }

    // detect namespace for the path
    var namespace = "",
        storage,
        folderPath;

    Object.keys(this.storage).forEach((function(key){
        if(key == "INBOX"){
            // Ignore INBOX
            return;
        }
        var ns = key.length ? key.substr(0, key.length - this.storage[key].separator.length) : key;
        if(key.length && (path == ns || path.substr(0, key.length) == key)){
            if(path == ns){
                throw new Error("Used mailbox name is a namespace value");
            }
            namespace = key;
        }else if(!namespace && !key && this.storage[key].type == "personal"){
            namespace = key;
        }
    }).bind(this));

    if(!this.storage[namespace]){
        throw new Error("Unknown namespace");
    }else{
        folderPath = path;
        storage = this.storage[namespace];

        if(storage.type != "personal"){
            throw new Error("Permission denied");
        }

        if(folderPath.substr(-storage.separator.length) == storage.separator){
            folderPath = folderPath.substr(0, folderPath.length - storage.separator.length);
        }

        if(this.folderCache[folderPath] && this.folderCache[folderPath].flags.indexOf("\\Noselect") < 0){
            throw new Error("Mailbox already exists");
        }

        path = folderPath;
        folderPath = folderPath.substr(namespace.length).split(storage.separator);
    }

    var parent = storage,
        curPath = namespace;

    if(curPath){
        curPath = curPath.substr(0, curPath.length - storage.separator.length);
    }

    folderPath.forEach((function(folderName){
        curPath += (curPath.length ? storage.separator : "") + folderName;

        var folder = this.getMailbox(curPath) || false;

        if(folder && folder.flags && folder.flags.indexOf("\\NoInferiors") >= 0){
            throw new Error("Can not create subfolders for " + folder.path);
        }

        if(curPath == path && defaultMailbox){
            folder = defaultMailbox;
            this.processMailbox(curPath, folder, namespace);
            parent.folders = parent.folders || {};
            parent.folders[folderName] = folder;

            folder.uidnext = Math.max(folder.uidnext, this.uidnextCache[curPath] || 1);
            delete this.uidnextCache[curPath];
            this.folderCache[curPath] = folder;
        }else if(!folder){
            folder = {
                subscribed: false
            };
            this.processMailbox(curPath, folder, namespace);
            parent.folders = parent.folders || {};
            parent.folders[folderName] = folder;

            delete this.uidnextCache[curPath];
            this.folderCache[curPath] = folder;
        }

        if(parent != storage){
            // Remove NoSelect if needed
            this.removeFlag(parent.flags, "\\Noselect");

            // Remove \HasNoChildren and add \\HasChildren from parent
            this.toggleFlags(parent.flags, ["\\HasNoChildren", "\\HasChildren"], 1);
        }else if(folder.namespace == this.referenceNamespace){
            if(this.referenceNamespace.substr(0, this.referenceNamespace.length - this.storage[this.referenceNamespace].separator.length).toUpperCase == "INBOX"){
                this.toggleFlags(this.storage.INBOX.flags, ["\\HasNoChildren", "\\HasChildren"], 1);
            }
        }

        parent = folder;
    }).bind(this));
};

/**
 * Deletes a mailbox with specified path
 *
 * @param {String} path Pathname for the mailbox
 * @param {boolean} keepContents If true do not delete messages
 */
IMAPServer.prototype.deleteMailbox = function(path, keepContents){
    // Ensure case insensitive INBOX
    if(path.toUpperCase() == "INBOX"){
        throw new Error("INBOX can not be modified");
    }

    // detect namespace for the path
    var mailbox,
        storage,
        namespace = "",
        folderPath = path,
        folderName,
        parent,
        parentKey;

    Object.keys(this.storage).forEach((function(key){
        if(key == "INBOX"){
            // Ignore INBOX
            return;
        }
        var ns = key.length ? key.substr(0, key.length - this.storage[key].separator.length) : key;
        if(key.length && (path == ns || path.substr(0, key.length) == key)){
            if(path == ns){
                throw new Error("Used mailbox name is a namespace value");
            }
            namespace = key;
        }else if(!namespace && !key && this.storage[key].type == "personal"){
            namespace = key;
        }
    }).bind(this));

    if(!this.storage[namespace]){
        throw new Error("Unknown namespace");
    }else{
        parent = storage = this.storage[namespace];

        if(storage.type != "personal"){
            throw new Error("Permission denied");
        }

        if(folderPath.substr(-storage.separator.length) == storage.separator){
            folderPath = folderPath.substr(0, folderPath.length - storage.separator.length);
        }

        mailbox = this.folderCache[folderPath];

        if(!mailbox || (
            mailbox.flags.indexOf("\\Noselect") >= 0 &&
                Object.keys(mailbox.folders || {}).length)){
            throw new Error("Mailbox does not exist");
        }

        folderPath = folderPath.split(storage.separator);
        folderName = folderPath.pop();

        parentKey = folderPath.join(storage.separator);
        if(parentKey != "INBOX"){
            parent = this.folderCache[folderPath.join(storage.separator)] || parent;
        }

        if(mailbox.folders && Object.keys(mailbox.folders).length && !keepContents){
            // anyone who has this mailbox selected is going to stay with
            // `reference` object. any new select is going to go to `folder`
            var reference = mailbox,
                folder = {};

            Object.keys(reference).forEach(function(key){
                if(key != "messages"){
                    folder[key] = reference[key];
                }else{
                    folder[key] = [];
                }
            });

            this.ensureFlag(folder.flags, "\\Noselect");
            parent.folders[folderName] = folder;
        }else{
            delete this.folderCache[mailbox.path];
            this.uidnextCache[mailbox.path] = mailbox.uidnext;
            delete parent.folders[folderName];

            if(parent != storage){
                if(parent.flags.indexOf("\\Noselect") >= 0 &&
                    !Object.keys(parent.folders || {}).length
                ){
                    this.deleteMailbox(parent.path);
                }else{
                    this.toggleFlags(parent.flags, ["\\HasNoChildren", "\\HasChildren"], Object.keys(parent.folders || {}).length ? 1 : 0);
                }
            }else if(namespace == this.referenceNamespace){
                if(this.referenceNamespace.substr(0, this.referenceNamespace.length - this.storage[this.referenceNamespace].separator.length).toUpperCase == "INBOX"){
                    this.toggleFlags(this.storage.INBOX.flags, ["\\HasNoChildren", "\\HasChildren"], Object.keys(storage.folders || {}).length ? 1 : 0);
                }
            }
        }
    }
};

/**
 * INBOX has its own namespace
 */
IMAPServer.prototype.indexFolders = function(){
    var folders = {};

    var walkTree = (function(path, separator, branch, namespace){
        var keyObj = namespace == "INBOX" ? {INBOX: true} : branch;

        Object.keys(keyObj).forEach((function(key){

            var curBranch = branch[key],
                curPath = (path ? path + (path.substr(-1) != separator ? separator : "") : "") + key;

            folders[curPath] = curBranch;
            this.processMailbox(curPath, curBranch, namespace);

            // ensure uid, flags and internaldate for every message
            curBranch.messages.forEach((function(message, i){

                // If the input was a raw message, convert it to an object
                if(typeof message == "string"){
                    curBranch.messages[i] = message = {raw: message};
                }

                this.processMessage(message, curBranch);
            }).bind(this));

            if(namespace != "INBOX" && curBranch.folders && Object.keys(curBranch.folders).length){
                walkTree(curPath, separator, curBranch.folders, namespace);
            }

        }).bind(this));
    }).bind(this);

    // Ensure INBOX namespace always exists
    if(!this.storage.INBOX){
        this.storage.INBOX = {};
    }

    Object.keys(this.storage).forEach((function(key){
        if(key == "INBOX"){
            walkTree("", "/", this.storage, "INBOX");
        }else{
            this.storage[key].folders = this.storage[key].folders || {};
            this.storage[key].separator = this.storage[key].separator || key.substr(-1) || "/";
            this.storage[key].type = this.storage[key].type || "personal";

            if(this.storage[key].type == "personal" && this.referenceNamespace === false){
                this.referenceNamespace = key;
            }

            walkTree(key, this.storage[key].separator, this.storage[key].folders, key);
        }
    }).bind(this));

    if(!this.referenceNamespace){
        this.storage[""] = this.storage[""] || {};
        this.storage[""].folders = this.storage[""].folders || {};
        this.storage[""].separator = this.storage[""].separator || "/";
        this.storage[""].type = "personal";
        this.referenceNamespace = "";
    }

    if(!this.storage.INBOX.separator && this.referenceNamespace !== false){
        this.storage.INBOX.separator = this.storage[this.referenceNamespace].separator;
    }

    if(this.referenceNamespace.substr(0, this.referenceNamespace.length - this.storage[this.referenceNamespace].separator.length).toUpperCase == "INBOX"){
        this.toggleFlags(this.storage.INBOX.flags, ["\\HasChildren", "\\HasNoChildren"],
            this.storage[this.referenceNamespace].folders && Object.keys(this.storage[this.referenceNamespace].folders).length ? 0 : 1);
    }

    this.folderCache = folders;
};

IMAPServer.prototype.processMailbox = function(path, mailbox, namespace){
    mailbox.path = path;

    mailbox.namespace = namespace;
    mailbox.uid = mailbox.uid || 1;
    mailbox.uidvalidity = mailbox.uidvalidity || this.uidnextCache[path] || 1;
    mailbox.flags = [].concat(mailbox.flags || []);
    mailbox.allowPermanentFlags = "allowPermanentFlags" in mailbox ? mailbox.allowPermanentFlags : true;
    mailbox.permanentFlags = [].concat(mailbox.permanentFlags || this.systemFlags);

    mailbox.subscribed = "subscribed" in mailbox ? !!mailbox.subscribed : true;

    // ensure message array
    mailbox.messages = [].concat(mailbox.messages || []);

    // ensure highest uidnext
    mailbox.uidnext = Math.max.apply(Math, [mailbox.uidnext || 1].concat(mailbox.messages.map(function(message){
        return (message.uid || 0) + 1;
    })));

    this.toggleFlags(mailbox.flags, ["\\HasChildren", "\\HasNoChildren"],
        mailbox.folders && Object.keys(mailbox.folders).length ? 0 : 1);
};

/**
 * Toggles listed flags. Vlags with `value` index will be turned on,
 * other listed fields are removed from the array
 *
 * @param {Array} flags List of flags
 * @param {Array} checkFlags Flags to toggle
 * @param {Number} value Flag from checkFlags array with value index is toggled
 */
IMAPServer.prototype.toggleFlags = function(flags, checkFlags, value){
    [].concat(checkFlags || []).forEach((function(flag, i){
        if(i == value){
            this.ensureFlag(flags, flag);
        }else{
            this.removeFlag(flags, flag);
        }
    }).bind(this));
};

/**
 * Ensures that a list of flags includes selected flag
 *
 * @param {Array} flags An array of flags to check
 * @param {String} flag If the flag is missing, add it
 */
IMAPServer.prototype.ensureFlag = function(flags, flag){
    if(flags.indexOf(flag) < 0){
        flags.push(flag);
    }
};

/**
 * Removes a flag from a list of flags
 *
 * @param {Array} flags An array of flags to check
 * @param {String} flag If the flag is in the list, remove it
 */
IMAPServer.prototype.removeFlag = function(flags, flag){
    var i;
    if(flags.indexOf(flag) >= 0){
        for(i = flags.length - 1; i >= 0; i--){
            if(flags[i] == flag){
                flags.splice(i, 1);
            }
        }
    }
};

IMAPServer.prototype.processMessage = function(message, mailbox){
    // internaldate should always be a Date object
    message.internaldate = message.internaldate || new Date();
    if(Object.prototype.toString.call(message.internaldate) == "[object Date]"){
        message.internaldate = this.formatInternalDate(message.internaldate);
    }
    message.flags = [].concat(message.flags || []);
    message.uid = message.uid || mailbox.uidnext++;

    // Allow plugins to process messages
    this.messageHandlers.forEach((function(handler){
        handler(this, message, mailbox);
    }).bind(this));
};

/**
 * Appends a message to a mailbox
 *
 * @param {Object|String} mailbox Mailbox to append to
 * @param {Array} flags Flags for the message
 * @param {String|Date} internaldate Receive date-time for the message
 * @param {String} raw Message source
 * @param {Object} [ignoreConnection] To not advertise new message to selected connection
 */
IMAPServer.prototype.appendMessage = function(mailbox, flags, internaldate, raw, ignoreConnection){
    if(typeof mailbox == "string"){
        mailbox = this.getMailbox(mailbox);
    }

    var message = {
        flags: flags,
        internaldate: internaldate,
        raw: raw
    };

    mailbox.messages.push(message);
    this.processMessage(message, mailbox);

    this.notify({
        tag: "*",
        attributes: [
            mailbox.messages.length,
            {type: "ATOM", value: "EXISTS"}
        ]
    }, mailbox, ignoreConnection);
};

IMAPServer.prototype.matchFolders = function(reference, match){
    var includeINBOX = false;

    if(reference === "" && this.referenceNamespace !== false){
        reference = this.referenceNamespace;
        includeINBOX = true;
    }

    if(!this.storage[reference]){
        return [];
    }

    var namespace = this.storage[reference],
        lookup = (reference || "") + match,
        result = [];

    var query = new RegExp("^" + lookup.
                // escape regex symbols
                replace(/([\\^$+?!.():=\[\]|,\-])/g, "\\$1").
                replace(/[*]/g, ".*").
                replace(/[%]/g, "[^" + (namespace.separator.replace(/([\\^$+*?!.():=\[\]|,\-])/g, "\\$1"))+ "]*") +
                "$",
                "");

    if(includeINBOX && ((reference ? reference + namespace.separator : "") + "INBOX").match(query)){
        result.push(this.folderCache.INBOX);
    }

    if(reference === "" && this.referenceNamespace !== false){
        reference = this.referenceNamespace;
    }

    Object.keys(this.folderCache).forEach((function(path){
        if(path.match(query) &&
            (this.folderCache[path].flags.indexOf("\\NonExistent") < 0 || this.folderCache[path].path == match) &&
            this.folderCache[path].namespace == reference){
            result.push(this.folderCache[path]);
        }
    }).bind(this));

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
IMAPServer.prototype.getMessageRange = function(mailbox, range, isUid){
    range = (range || "").toString();
    if(typeof mailbox == "string"){
        mailbox = this.getMailbox(mailbox);
    }

    var result = [],
        rangeParts = range.split(","),
        messages = Array.isArray(mailbox) ? mailbox : mailbox.messages,
        uid,
        totalMessages = messages.length,
        maxUid = 0,

        inRange = function(nr, ranges, total){
            var range, from, to;
            for(var i=0, len = ranges.length; i<len; i++){
                range = ranges[i];
                to = range.split(":");
                from = to.shift();
                if(from == "*"){
                    from = total;
                }
                from = Number(from) || 1;
                to = to.pop() || from;
                to = Number(to=="*" && total || to) || from;

                if(nr >= Math.min(from, to) && nr <= Math.max(from, to)){
                    return true;
                }
            }
            return false;
        };

    messages.forEach(function(message){
        if(message.uid > maxUid){
            maxUid = message.uid;
        }
    });

    for(var i=0, len = messages.length; i<len; i++){
        uid = messages[i].uid || 1;
        if(inRange(isUid ? uid : i+1, rangeParts, isUid ? maxUid : totalMessages)){
            result.push([i+1, messages[i]]);
        }
    }

    return result;
};

function IMAPConnection(server, socket){
    this.server = server;
    this.socket = socket;
    this.options = this.server.options;

    this.state = "Not Authenticated";

    this.secureConnection = !!this.options.secureConnection;
    this._ignoreData = false;

    this._remainder = "";
    this._command = "";
    this._literalRemaining = 0;

    this.inputHandler = false;

    this._commandQueue = [];
    this._processing = false;

    if(this.options.debug){
        this.socket.pipe(process.stdout);
    }

    this.socket.on("data", this.onData.bind(this));
    this.socket.on("close", this.onClose.bind(this));
    this.socket.on("error", this.onError.bind(this));

    this.directNotifications = false;
    this._notificationCallback = this.onNotify.bind(this);
    this.notificationQueue = [];
    this.server.on("notify", this._notificationCallback);

    this.socket.write("* OK Hoodiecrow ready for rumble\r\n");
}

IMAPConnection.prototype.onClose = function(){
    this.socket.removeAllListeners();
    this.socket = null;
    try{
        this.socket.end();
    }catch(E){}
    this.server.removeListener("notify", this._notificationCallback);
};

IMAPConnection.prototype.onError = function(err){
    if(this.options.debug){
        console.log("Socket error event emitted, %s", Date());
        console.log(err.stack);
    }
    try{
        this.socket.end();
    }catch(E){}
};

IMAPConnection.prototype.onData = function(chunk){
    var match, str;

    if(this._ignoreData){
        // If TLS upgrade is initiated do not process current buffer
        this._remainder = "";
        this._command = "";
        return;
    }

    str = (chunk || "").toString("binary");

    if(this._literalRemaining){
        if(this._literalRemaining > str.length){
            this._literalRemaining -= str.length;
            this._command += str;
            return;
        }
        this._command += str.substr(0, this._literalRemaining);
        str = str.substr(this._literalRemaining);
        this._literalRemaining = 0;
    }

    str = this._remainder + str;
    while((match = str.match(/(\{(\d+)(\+)?\})?\r?\n/))){
        if(!match[2]){

            if(this.inputHandler){
                this.inputHandler(this._command + str.substr(0, match.index));
            }else{
                this.scheduleCommand(this._command + str.substr(0, match.index));
            }

            this._remainder = str = str.substr(match.index + match[0].length);
            this._command = "";
            continue;
        }

        if(match[3] != "+"){
            if(this.socket && !this.socket.destroyed){
                this.socket.write("+ Go ahead\r\n");
            }
        }

        this._remainder = "";
        this._command += str.substr(0, match.index + match[0].length);
        this._literalRemaining = Number(match[2]);

        str = str.substr(match.index + match[0].length);

        if(this._literalRemaining > str.length){
            this._command += str;
            this._literalRemaining -= str.length;
            return;
        }else{
            this._command += str.substr(0, this._literalRemaining);
            this._remainder = str = str.substr(this._literalRemaining);
            this._literalRemaining = 0;
        }
    }
};

IMAPConnection.prototype.onNotify = function(notification){
    if(notification.ignoreConnection == this){
        return;
    }
    if(!notification.mailbox ||
        (this.selectedMailbox &&
            this.selectedMailbox == (
                typeof notification.mailbox == "string" &&
                    this.getMailbox(notification.mailbox) || notification.mailbox))){
        this.notificationQueue.push(notification.command);
        if(this.directNotifications){
            this.processNotifications();
        }
    }
};

IMAPConnection.prototype.upgradeConnection = function(callback){
    this._ignoreData = true;
    var pair = starttls(this.socket, this.options.credentials, (function(socket){
        this._ignoreData = false;
        this._remainder = "";

        this.socket = socket;
        this.socket.on("data", this.onData.bind(this));
        this.secureConnection = true;

        if(!socket.authorized && this.options.debug){
            console.log("WARNING: TLS ERROR ("+socket.authorizationError+")");
        }
        callback();
    }).bind(this));
    pair.on("error", function(err){
        console.log(err);
        if(this.socket && !this.socket.destroyed){
            this.socket.end();
        }
    });
};

IMAPConnection.prototype.processNotifications = function(data){
    var notification;
    for(var i=0; i < this.notificationQueue.length; i++){
        notification = this.notificationQueue[i];

        if(data && ["FETCH", "STORE", "SEARCH"].indexOf((data.command || "").toUpperCase()) >= 0){
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
 * @param {Object} data Command object
 */
IMAPConnection.prototype.send = function(data){
    if(!this.socket || this.socket.destroyed){
        return;
    }

    if(!data.notification && data.tag != "*"){
        // arguments[2] should be the original command
        this.processNotifications(arguments[2]);
    }else{
        // override values etc.
    }

    var args = Array.prototype.slice.call(arguments);
    this.server.outputHandlers.forEach((function(handler){
        handler.apply(null, [this].concat(args));
    }).bind(this));

    // No need to display this response to user
    if(data.skipResponse){
        return;
    }

    var compiled = imapHandler.compiler(data);

    if(this.options.debug){
        console.log("SEND: %s", compiled);
    }

    if(this.socket && !this.socket.destroyed){
        this.socket.write(new Buffer(compiled + "\r\n", "binary"));
    }
};

IMAPConnection.prototype.scheduleCommand = function(data){
    var parsed,
        tag = (data.match(/\s*([^\s]+)/) || [])[1] || "*";

    try{
        parsed = imapHandler.parser(data, {literalPlus: this.server.literalPlus});
    }catch(E){
        this.send({
            tag: "*",
            command: "BAD",
            attributes:[
                {type: "SECTION", section: [{type:"ATOM", value:"SYNTAX"}]},
                {type: "TEXT", value: E.message}
            ]
        }, "ERROR MESSAGE", null, data, E);

        this.send({
            tag: tag,
            command: "BAD",
            attributes:[
                {type: "TEXT", value: "Error parsing command"}
            ]
        }, "ERROR RESPONSE", null, data, E);

        return;
    }

    if(this.server.getCommandHandler(parsed.command)){
        this._commandQueue.push({parsed: parsed, data:data});
        this.processQueue();
    }else{
        this.send({
            tag: parsed.tag,
            command: "BAD",
            attributes:[
                {type: "TEXT", value: "Invalid command " + parsed.command + ""}
            ]
        }, "UNKNOWN COMMAND", parsed, data);
    }
};

IMAPConnection.prototype.processQueue = function(force){
    var element;

    if(!force && this._processing){
        return;
    }

    if(!this._commandQueue.length){
        this._processing = false;
        return;
    }

    this._processing = true;

    element = this._commandQueue.shift();
    this.server.getCommandHandler(element.parsed.command)(this, element.parsed, element.data, (function(){
        if(!this._commandQueue.length){
            this._processing = false;
        }else{
            this.processQueue(true);
        }
    }).bind(this));
};

/**
 * Removes messages with \Deleted flag
 *
 * @param {Object|String} mailbox Mailbox to check for
 * @param {Boolean} [ignoreSelf] If set to true, does not send any notices to itself
 * @param {Boolean} [ignoreSelf] If set to true, does not send EXISTS notice to itself
 */
IMAPConnection.prototype.expungeDeleted = function(mailbox, ignoreSelf, ignoreExists){
    var deleted = 0,
        // old copy is required for those sessions that run FETCH before
        // displaying the EXPUNGE notice
        mailboxCopy = [].concat(mailbox.messages);

    for(var i=0; i < mailbox.messages.length; i++){
        if(mailbox.messages[i].flags.indexOf("\\Deleted") >= 0){
            deleted++;
            mailbox.messages[i].ghost = true;
            mailbox.messages.splice(i, 1);
            this.server.notify({
                tag: "*",
                attributes: [
                    i + 1,
                    {type: "ATOM", value: "EXPUNGE"}
                ]
            }, mailbox, ignoreSelf ? this : false);
            i--;
        }
    }

    if(deleted){
        this.server.notify({
            tag: "*",
            attributes: [
                mailbox.messages.length,
                {type: "ATOM", value: "EXISTS"}
            ],
            // distribute the old mailbox data with the notification
            mailboxCopy: mailboxCopy,
        }, mailbox, ignoreSelf || ignoreExists ? this : false);
    }
};
