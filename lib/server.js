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
    this.commandHandlers = {};
    this.capabilities = {};

    this.users = {};

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

    this._commandQueue = [];
    this._processing = false;

    this.socket.pipe(process.stdout);
    this.socket.on("data", this.onData.bind(this));
    this.socket.on("close", this.onClose.bind(this));
    this.socket.on("error", this.onError.bind(this));

    this.socket.write("* OK Toybird ready for rumble\r\n");
}

IMAPConnection.prototype.onClose = function(){
    this.socket.removeAllListeners();
    this.socket = null;
    try{
        this.socket.end();
    }catch(E){}
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
            this.scheduleCommand(this._command + str.substr(0, match.index));
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
    if(!this.socket || this.socket.destroyed){
        return;
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
        tag = (data.match(/\s*([^\s]+)/) || [])[1] || "*",
        command,
        handler;

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
        }, "ERROR MESSAGE", E, data);

        this.send({
            tag: tag,
            command: "BAD",
            attributes:[
                {type: "TEXT", value: "Error parsing command"}
            ]
        }, "ERROR RESPONSE", E, data);

        return;
    }

    command = parsed.command.toUpperCase();

    // try to autoload if not supported
    if(!this.server.commandHandlers[command]){
        try{
            handler = require("./commands/" + command.toLowerCase());
            this.server.setCommandHandler(command, handler);
        }catch(E){}
    }

    if(this.server.commandHandlers[command]){
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
    this.server.commandHandlers[element.parsed.command.toUpperCase()](this, element.parsed, element.data, (function(){
        if(!this._commandQueue.length){
            this._processing = false;
        }else{
            this.processQueue(true);
        }
    }).bind(this));
};
