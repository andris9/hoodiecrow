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

    this.users = {};
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

function IMAPConnection(server, socket){
    this.server = server;
    this.socket = socket;
    this.options = this.server.options;

    this.state = "Not Authenticated";

    this.secureConnection = !!this.options.secureConnection;
    this._ignoreData = false;

    this._remainder = "";

    this.socket.on("data", this.onData.bind(this));
    this.socket.on("close", this.onClose.bind(this));
    this.socket.on("error", this.onError.bind(this));
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
    if(this._ignoreData){
        // If TLS upgrade is initiated do not process current buffer
        this._remainder = "";
        return;
    }

    chunk = (chunk || "").toString("binary");
    // TODO: gather complete command, parse it and run it

};

IMAPConnection.prototype.upgradeConnection = function(callback){
    this._ignoreData = true;
    starttls(this.socket, this.options.credentials, (function(socket){
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

    this.socket.write(new Buffer(compiled + "\r\n", "binary"));
};