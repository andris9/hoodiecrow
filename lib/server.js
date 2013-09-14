"use strict";

var Stream = require("stream").Stream,
    util = require("util"),
    net = require("net"),
    tls = require("tls"),
    fs = require("fs"),
    imapHandler = require("imap-handler"),
    /*
    mimeParser = require("./mimeparser"),
    bodystructure = require("./bodystructure"),
    envelope = require("./envelope"),
    */
    starttls = require("./starttls");

module.exports = function(options){
    return new IMAPServer(options);
};

function IMAPServer(options){
    Stream.call(this);

    this.options = options || {};
    this.options.credentials = this.options.credentials || {
        key: fs.readFileSync(__dirname+"/../cert/server.key"),
        cert: fs.readFileSync(__dirname+"/../cert/server.crt")
    };

    if(this.options.secureConnection){
        this.server = tls.createServer(this.options.credentials, this.createClient.bind(this));
    }else{
        this.server = net.createServer(this.createClient.bind(this));
    }

    this.connectionHandlers = [];
    this.outputHandlers = [];
    this.messageHandlers = [];
    this.folderHandlers = [];
    this.fetchHandlers = {};
    this.commandHandlers = {};
    this.capabilities = {};
    this.allowedStatus = ["MESSAGES", "RECENT", "UIDNEXT", "UIDVALIDITY", "UNSEEN"];

    this.users = {
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

    this.namespace = this.options.namespace || {"":{folders:{"INBOX":{}}}};
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

IMAPServer.prototype.notify = function(command, mailbox){
    command.notification = true;
    this.emit("notify", {
        command: command,
        mailbox: mailbox
    });
};

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

IMAPServer.prototype.getStatus = function(mailbox){
    if(typeof mailbox == "string"){
        mailbox = this.folderCache[mailbox];
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
        (tz < 0 ? "-" : "+") + (tzHours < 10 ? "0" : "") + tzHours +
        (tzMins < 10 ? "0" : "") + tzMins;
};

IMAPServer.prototype.indexFolders = function(){
    var folders = {};

    var walkTree = (function(path, separator, branch, namespace){
        Object.keys(branch).forEach((function(key){
            var curBranch = branch[key],
                curPath = (path ? path + (path.substr(-1) != separator ? separator : "") : "") + key,
                curFlags = [].concat(curBranch.flags || []);
            folders[curPath] = curBranch;

            curBranch.path = curPath;

            curBranch.namespace = namespace;
            curBranch.uid = curBranch.uid || 1;
            curBranch.uidvalidity = curBranch.uidvalidity || 1;
            curBranch.flags = [].concat(curFlags || []);
            curBranch.allowPermanentFlags = "allowPermanentFlags" in curBranch ? curBranch.allowPermanentFlags : true;
            curBranch.permanentFlags = [].concat(curBranch.permanentFlags ||
                ["\\Answered", "\\Flagged", "\\Draft", "\\Deleted", "\\Seen"]);

            curBranch.subscribed = "subscribed" in curBranch && !!curBranch.subscribed || true;

            // ensure message array
            curBranch.messages = [].concat(curBranch.messages || []);

            // ensure highest uidnext
            curBranch.uidnext = Math.max.apply(Math, [curBranch.uidnext || 1].concat(curBranch.messages.map(function(message){
                return (message.uid || 0) + 1;
            })));

            // ensure uid, flags and internaldate for every message
            curBranch.messages.forEach((function(message, i){

                // If the input was a raw message, convert it to an object
                if(typeof message == "string"){
                    curBranch.messages[i] = message = {raw: message};
                }

                // internaldate should always be a Date object
                message.internaldate = message.internaldate || this.formatInternalDate(new Date());
                message.flags = [].concat(message.flags || []);
                message.uid = message.uid || curBranch.uidnext++;

                // Allow plugins to process messages
                this.messageHandlers.forEach((function(handler){
                    handler(this, message, curBranch, i + 1);
                }).bind(this));

            }).bind(this));

            if(curBranch.folders && Object.keys(curBranch.folders).length){
                curBranch.flags.push("\\HasChildren");
                walkTree(curPath, separator, curBranch.folders, namespace);
            }else{
                curBranch.flags.push("\\HasNoChildren");
            }

            // Allow plugins to process folders
            this.folderHandlers.forEach((function(handler){
                handler(this, curBranch);
            }).bind(this));

        }).bind(this));
    }).bind(this);

    Object.keys(this.namespace).forEach((function(key){
        this.namespace[key].folders = this.namespace[key].folders || [];
        this.namespace[key].separator = this.namespace[key].separator || "/";
        this.namespace[key].type = this.namespace[key].type || "personal";

        walkTree(key, this.namespace[key].separator, this.namespace[key].folders, key);
    }).bind(this));

    this.folderCache = folders;
};

IMAPServer.prototype.matchFolders = function(reference, match){
    if(!this.namespace[reference]){
        return [];
    }

    var namespace = this.namespace[reference],
        lookup = (reference || "") + match,
        result = [];

    var query = new RegExp("^" + lookup.
                // escape regex symbols
                replace(/([\\^$+?!.():=\[\]|,\-])/g, "\\$1").
                replace(/[*]/g, ".*").
                replace(/[%]/g, "[^" + (namespace.separator.replace(/([\\^$+*?!.():=\[\]|,\-])/g, "\\$1"))+ "]*") +
                "$",
                "");

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
        mailbox = this.folderCache[mailbox];
    }

    var result = [],
        rangeParts = range.split(","),
        messages = mailbox.messages,
        uid,
        totalMessages = messages.length,

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

    for(var i=0, len = messages.length; i<len; i++){
        uid = messages[i].uid || 1;
        if(inRange(isUid ? uid : i+1, rangeParts, isUid ? mailbox.uidnext : totalMessages)){
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

    //this.socket.pipe(process.stdout);
    this.socket.on("data", this.onData.bind(this));
    this.socket.on("close", this.onClose.bind(this));
    this.socket.on("error", this.onError.bind(this));

    this.directNotifications = false;
    this._notificationCallback = this.onNotify.bind(this);
    this._notificationQueue = [];
    this.server.on("notify", this._notificationCallback);

    this.socket.write("* OK Toybird ready for rumble\r\n");
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
            str = str.substr(this._literalRemaining);
            this._literalRemaining = 0;
        }
    }
};

IMAPConnection.prototype.onNotify = function(notification){
    if(!notification.mailbox || (this.selectedMailbox && this.selectedMailbox == this.folderCache[notification.mailbox])){
        this._notificationQueue.push(notification.command);
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
    for(var i=0; i < this._notificationQueue.length; i++){
        notification = this._notificationQueue[i];

        if(data && ["FETCH", "STORE", "SEARCH"].indexOf((data.command || "").toUpperCase()) >= 0){
            continue;
        }

        this.send(notification);
        this._notificationQueue.splice(i, 1);
        i--;
        continue;
    }
};

IMAPConnection.prototype.send = function(data){
    if(!this.socket || this.socket.destroyed){
        return;
    }

    if(!data.notification && data.tag != "*"){
        this.processNotifications(data);
    }else{
        // override values etc.
    }

    var args = Array.prototype.slice.call(arguments);
    this.server.outputHandlers.forEach((function(handler){
        handler.apply(null, [this].concat(args));
    }).bind(this));

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
        parsed = imapHandler.parser(data);
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

IMAPConnection.prototype.expungeDeleted = function(mailbox){
    var deleted = 0;
    for(var i=0; i < mailbox.messages.length; i++){
        if(mailbox.messages[i].flags.indexOf("\\Deleted") >= 0){
            deleted++;
            mailbox.messages.splice(i, 1);
            this.server.notify({
                tag: "*",
                attributes: [
                    i + 1,
                    {type: "ATOM", value: "EXPUNGE"}
                ]
            });
            i--;
        }
    }
    if(deleted){
        this.server.notify({
            tag: "*",
            attributes: [
                mailbox.messages.length,
                {type: "ATOM", value: "EXISTS"}
            ]
        }, mailbox);
    }
};
