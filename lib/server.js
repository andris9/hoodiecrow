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

    this.outputHandlers = [];
    this.messageHandlers = [];
    this.folderHandlers = [];
    this.commandHandlers = {};
    this.capabilities = {};

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
    this.folderCache = false;
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
    new IMAPConnection(this, socket);
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
        }catch(E){}
    }

    return this.commandHandlers[command] || false;
};

IMAPServer.prototype.formatInternalDate = function(date){
    // FIXME: proper date format must be used
    return date.toUTCString();
};

IMAPServer.prototype.indexFolders = function(){
    var folders = {};

    var walkTree = (function(path, separator, branch){
        Object.keys(branch).forEach((function(key){
            var curBranch = branch[key],
                curPath = (path ? path + separator : "") + key,
                curFlags = [].concat(curBranch.flags || []);
            folders[curPath] = curBranch;

            curBranch.path = curPath;

            curBranch.uid = curBranch.uid || 1;
            curBranch.uidvalitity = curBranch.uidvalitity || 1;
            curBranch.flags = [].concat(curFlags || []);
            curBranch.allowPermanentFlags = "allowPermanentFlags" in curBranch ? curBranch.allowPermanentFlags : true;
            curBranch.permanentFlags = [].concat(curBranch.permanentFlags || 
                ["\\Answered", "\\Flagged", "\\Draft", "\\Deleted", "\\Seen"]);

            // ensure message array
            curBranch.messages = [].concat(curBranch.messages || []);

            // ensure highest uidnext
            curBranch.uidnext = Math.max.apply(Math, [curBranch.uidnext || 1].concat(curBranch.messages.map(function(message){
                return (message.uid || 0) + 1;
            })));

            // ensure uid, flags and internaldate for every message
            curBranch.messages.forEach((function(message, i){
                // internaldate should always be a Date object
                message.internaldate = message.internaldate || this.formatInternalDate(new Date());
                message.flags = [].concat(message.flags || []);
                message.uid = message.uid || curBranch.uidnext++;

                // Allow plugins to process messages
                this.messageHandlers.forEach((function(handler){
                    handler(message, curBranch, i + 1);
                }).bind(this));

            }).bind(this));

            if(curBranch.folders && Object.keys(curBranch.folders).length){
                curFlags.push("\\HasChildren");
                walkTree(curPath, separator, curBranch.folders);
            }else{
                curFlags.push("\\HasNoChildren");
            }

            // Allow plugins to process folders
            this.folderHandlers.forEach((function(handler){
                handler(curBranch);
            }).bind(this));

        }).bind(this));
    }).bind(this);

    Object.keys(this.namespace).forEach((function(key){
        this.namespace[key].folders = this.namespace[key].folders || [];
        this.namespace[key].separator = this.namespace[key].separator || "/";
        this.namespace[key].type = this.namespace[key].type || "personal";

        walkTree(key, this.namespace[key].separator, this.namespace[key].folders);
    }).bind(this));

    this.folderCache = folders;
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

    this.socket.pipe(process.stdout);
    this.socket.on("data", this.onData.bind(this));
    this.socket.on("close", this.onClose.bind(this));
    this.socket.on("error", this.onError.bind(this));

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

IMAPConnection.prototype.send = function(data){
    var notification;

    if(!this.socket || this.socket.destroyed){
        return;
    }

    if(!data.notification && data.tag != "*"){
        for(var i=0; i < this._notificationQueue.length; i++){
            notification = this._notificationQueue[i];

            if(["FETCH", "STORE", "SEARCH"].indexOf((data.command || "").toUpperCase()) >= 0){
                continue;
            }

            this.send(notification);
            this._notificationQueue.splice(i, 1);
            i--;
            continue;
        }
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
