"use strict";

var net = require("net"),
    IMAPLineParser = require("./lineparser"),
    mimeParser = require("./mimeparser"),
    bodystructure = require("./bodystructure"),
    packageData = require("../package");

var IMAP_STATES = ["Not Authenticated", "Authenticated", "Selected", "Logout"];

module.exports = IMAPMockServer;

function IMAPMockServer(options){
    this.options = options || {};
    this.server = net.createServer(this.createClient.bind(this));

    this.users = {};
    this.capabilities = {};

    this.init();
}

IMAPMockServer.prototype.init = function(){
    [].concat(this.options.enabled || []).forEach((function(capability){
        switch(capability){
            case "ID":
                this.addCapability("ID");
                break;
            case "IDLE":
                this.addCapability("IDLE");
                break;
        }
    }).bind(this));
};

IMAPMockServer.prototype.addCapability = function(key, states){
    if(!states || !states.length){
        states = IMAP_STATES.concat([]);
    }

    states.forEach((function(state){
        if(!this.capabilities[state]){
            this.capabilities[state] = [key];
        }else{
            this.capabilities[state].push(key);
        }
    }).bind(this));
};

IMAPMockServer.prototype.addUser = function(user, pass){
    this.users[user] = pass;
};

IMAPMockServer.prototype.listen = function(){
    var args = Array.prototype.slice.call(arguments);
    this.server.listen.apply(this.server, args);
};

IMAPMockServer.prototype.createClient = function(socket){
    new IMAPMockConnection(this, socket);
};

function IMAPMockConnection(server, socket){
    this.server = server;
    this.socket = socket;

    this.state = "Not Authenticated";

    this.lineparser = new IMAPLineParser();
    this._remainder = "";
    this._literalRemaining = 0;
    this.queue = [];

    this.idling = false;
    this._processing = false;
    this.socket.on("data", this.onData.bind(this));

    this.lineparser.on("line", (function(data){
        this.queue.push(data);
        this.processQueue();
    }).bind(this));

    this.socket.write("* OK Testserver ready for requests\r\n");
}

IMAPMockConnection.prototype.onData = function(chunk){
    var str = this._remainder + (chunk || "").toString("binary"),
        pos = 0,
        len = str.length,
        lineMatch,
        literalMatch,
        line;
 
    this._remainder = "";

    if(this._literalRemaining){
        if(this._literalRemaining >= str.length){
            if(line){
                this.lineparser.writeLiteral(line);
            }
            this._literalRemaining -= str.length;
            return;
        }
        line = str.substr(0, this._literalRemaining);
        this._remainder = str.substr(this._literalRemaining);
        this._literalRemaining = 0;
        if(line){
            this.lineparser.writeLiteral(line);
        }
        return this.onData();
    }

    while(pos < len){
        if((lineMatch = str.substr(pos).match(/\r?\n/))){
            line = str.substr(pos, lineMatch.index);
            if((literalMatch = line.match(/\{(\d+)\}$/))){
                this._literalRemaining = Number(literalMatch[1]) || 0;
                this._remainder = str.substr(pos + line.length + lineMatch[0].length);
                return this.onData();
            }
            this.lineparser.end(line);
            pos += line.length + lineMatch[0].length;
        }else{
            this._remainder = str.substr(pos);
            break;
        }
    }
};

IMAPMockConnection.prototype.processQueue = function(){
    if(this._processing){
        return;
    }
    this._processing = true;

    var processor = (function(){
        if(!this.queue.length){
            this._processing = false;
            return;
        }

        var data = this.queue.shift();

        console.log("SERVER RECEIVED COMMAND: " + JSON.stringify(data));

        this.processCommand(data, processor);
    }).bind(this);

    processor();
};

IMAPMockConnection.prototype.send = function(tag, data){
    this.socket.write(tag + " " + data + "\r\n");
};

IMAPMockConnection.prototype.escapeString = function(str){
    return "\"" + (str || "").toString().replace(/(["\\])/g, "\\$1").replace(/[\r\n]/g, " ") + "\"";
};

IMAPMockConnection.prototype.escapeObject = function(object){
    var walkNode = (function(node){
        var elements = [];

        if(Array.isArray(node)){
            elements = node.map(walkNode);
            return "("+elements.join(" ")+")";
        }
        
        if(Object.prototype.toString.call(node) == "[object Date]"){
            node = node.toUTCString();
        }

        switch(typeof node){
            case "object":
                if(!node){
                    return "NIL";
                }
                return "(" + Object.keys(node).map(function(key){
                    return key + " " + walkNode(node[key]);
                }).join(" ") + ")";
            case "string":
                if(node.charAt(0)=="\\"){
                    // FIXME: assumes all strings starting with \ are flags
                    //        this might not be the case, besides some flags do not start with \
                    return node;
                }else{
                    return this.escapeString(node);    
                }
                break;
            default:
                return node && node.toString() || "NIL";
        }

    }).bind(this);

    return walkNode(object);
};

IMAPMockConnection.prototype.processCommand = function(data, callback){
    var tag = (data.shift() || "").toString().trim(),
        command = (data.shift() || "").toString().trim().toLowerCase();

    if(this.idling){
        if(command == "DONE"){
            this.send(this.idling, "OK IDLE terminated (Success)");
        }else{
            this.send(this.idling, "BAD Could not parse command");
        }
        this.idling = false;
        return callback();
    }

    switch(command){
        case "capability":
            this.send("*", this.buildCapabilityList());
            this.send(tag, "OK");
            return callback();
        case "login":
            return this.handleLOGIN(tag, data, callback);
        case "id":
            return this.handleID(tag, data, callback);
        case "list":
            return this.handleLIST(tag, data, callback);
        case "lsub":
            return this.handleLSUB(tag, data, callback);
        case "select":
            return this.handleSELECT(tag, data, callback);
        case "fetch":
            return this.handleFETCH(tag, data, callback);
        case "noop":
            return this.handleNOOP(tag, data, callback);
        case "idle":
            return this.handleIDLE(tag, data, callback);
        default:
            this.send(tag, "BAD Unknown command: " + command.toUpperCase());
            callback();        
    }
};

IMAPMockConnection.prototype.checkSupport = function(capability){
    var enabledList = [].concat(this.server.options.enabled || []);
    
    switch(capability){
        default:
            return enabledList.indexOf(capability) >= 0;
    }
};

IMAPMockConnection.prototype.handleFETCH = function(tag, data, callback){
    if(["Authenticated", "Selected"].indexOf(this.state) < 0){
        this.send(tag, "BAD Unknown command");
        return callback();
    }

    var range = (data.shift() || "").split(":"),
        params = data.shift() || [],
        from = range.shift() || 1,
        to = range.pop(),
        message;

    if(!to || to == "*"){
        to = (this.selectedMailbox.messages || []).length;
    }

    for(var i = from - 1; i < to; i++){
        message = (this.selectedMailbox.messages || [])[i];

        if(message){
            this.send("*", (i+1)+" FETCH " + this.buildMessageResponse(message, params));
        }
    }
    this.send(tag, "OK Success");

    callback();
};

IMAPMockConnection.prototype.handleSELECT = function(tag, data, callback){
    if(["Authenticated", "Selected"].indexOf(this.state) < 0){
        this.send(tag, "BAD Unknown command");
        return callback();
    }

    var mailboxName = (data.shift() || ""),
        path = mailboxName.split(this.server.options.separator),
        mbox = this.server.options;

    while(path.length && (mbox = mbox.directories && mbox.directories[path.shift()] || false)){}
    
    if(mbox == this.server.options || !mbox || (mbox.flags || []).indexOf("\\Noselect") >= 0){
        this.send(tag, "NO [NONEXISTENT] Unknown Mailbox: " + mailboxName + " (Failure)");
    }else{
        this.selectedMailbox = mbox;

        if(this.server.options.flags && this.server.options.flags.length){
            this.send("*", "FLAGS (" + this.server.options.flags.join(" ") + ")");
            this.send("*", " OK [PERMANENTFLAGS (" + this.server.options.flags.join(" ") + " \\*)  Flags permitted.");
        }
        this.send("*", "OK [UIDVALIDITY " + (mbox.uidvalitity || 1) + "] UIDs valid.");
        this.send("*", (mbox.messages || []).length+" EXISTS");
        this.send("*", "0 RECENT");
        this.send("*", "OK [UIDNEXT " + Math.max.apply(Math, [mbox.uidnext || 1].concat((mbox.messages || []).map(function(message){
            return (message.uid || 0) + 1;
        }))) + "] Predicted next UID.");
        

        this.send(tag, "OK [READ-WRITE] " + mailboxName + " selected. (Success)");
    }
    
    callback();
};

IMAPMockConnection.prototype.handleLSUB = function(tag, data, callback){
    if(["Authenticated", "Selected"].indexOf(this.state) < 0){
        this.send(tag, "BAD Unknown command");
        return callback();
    }

    var result = this.matchDirectories(data[0] || "", data[1] || "");

    (result || []).forEach((function(row){
        this.send("*", 'LSUB ('+ (row[1] || []).join(" ") +') "' + 
            (this.server.options.separator || "/") + 
            '" ' + 
            this.escapeString(row[0]));
    }).bind(this));

    this.send(tag, "OK Success");

    callback();
};

IMAPMockConnection.prototype.handleLIST = function(tag, data, callback){
    if(["Authenticated", "Selected"].indexOf(this.state) < 0){
        this.send(tag, "BAD Unknown command");
        return callback();
    }

    var result = this.matchDirectories(data[0] || "", data[1] || "");

    (result || []).forEach((function(row){
        this.send("*", 'LIST ('+ (row[1] || []).join(" ") +') "' + 
            (this.server.options.separator || "/") + 
            '" ' + 
            this.escapeString(row[0]));
    }).bind(this));

    this.send(tag, "OK Success");

    callback();
};


IMAPMockConnection.prototype.handleID = function(tag, data, callback){
    if(!this.checkSupport("ID")){
        this.send(tag, "BAD Unknown command: ID");
        return callback();
    }

    this.send("*", this.buildIDString());
    this.send(tag, "OK Success");

    callback();
};

IMAPMockConnection.prototype.handleNOOP = function(tag, data, callback){
    this.send(tag, "OK NOOP completed");
    callback();
};

IMAPMockConnection.prototype.handleIDLE = function(tag, data, callback){
    if(!this.checkSupport("IDLE")){
        this.send(tag, "BAD Unknown command: IDLE");
        return callback();
    }
    this.idling = tag;
    this.send("+", "idling");
    callback();
};

IMAPMockConnection.prototype.handleLOGIN = function(tag, data, callback){
    var user = data.shift() || "",
        pass = data.shift() || "";

    // TODO: CHECK STATE

    if(!(user in this.server.users) || this.server.users[user] != pass){
        this.send(tag, "NO Invalid credentials");
    }else{
        this.state = "Authenticated";
        this.send("*", this.buildCapabilityList());
        this.send(tag, "OK " + user + " authenticated (Success)");
    }

    callback();
};

IMAPMockConnection.prototype.buildMessageResponse = function(message, params){
    var response = {};

    if(!message.structured){

        // this construct seems unnecessary

        message.structured = mimeParser(message.body || "");
        message.bodystructure = bodystructure(message.structured);
        
        message.from = message.structured.parsedHeader.from || [];
        message.to = message.structured.parsedHeader.to || [];
        message.cc = message.structured.parsedHeader.cc || [];
        message.bcc = message.structured.parsedHeader.bcc || [];
        message.replyTo = message.structured.parsedHeader["reply-to"] || [];
        message.sender = message.structured.parsedHeader.sender || [];
        
        message.sender = message.structured.parsedHeader["message-id"] || false;
        message.subject = message.structured.parsedHeader.subject || false;
        message.inReplyTo = message.structured.parsedHeader["in-reply-to"] || false;
    }

    if(!message.internaldate){
        message.internaldate = new Date();
    }

    (params || []).forEach((function(param){
        switch(param){
            case "UID":
            case "FLAGS":
                response[param] = message[param.toLowerCase()] || null;
                break;
            case "INTERNALDATE":
                response[param] = message.internaldate;
                break;
            case "BODYSTRUCTURE":
                response[param] = message.bodystructure;
                break;
            case "ENVELOPE":
                // TODO: Envelope generation should be reusable (also needed for RFC822 BODYSTRUCTURE)
                response.ENVELOPE = [
                    message.internaldate || new Date(),
                    message.subject || "",
                    
                    message.from && [].concat(message.from || []).length && ([].concat(message.from).map(function(addr){
                        return [
                            addr.name || null,
                            null,
                            (addr.address || "").split("@").shift() || null,
                            (addr.address || "").split("@").pop() || null
                        ];
                    })) || null,

                    (message.sender || message.from) && [].concat(message.sender || message.from || []).length && ([].concat(message.sender || message.from).map(function(addr){
                        return [
                            addr.name || null,
                            null,
                            (addr.address || "").split("@").shift() || null,
                            (addr.address || "").split("@").pop() || null
                        ];
                    })) || null,

                    (message.replyTo || message.from) && [].concat(message.replyTo || message.from || []).length && ([].concat(message.replyTo || message.from).map(function(addr){
                        return [
                            addr.name || null,
                            null,
                            (addr.address || "").split("@").shift() || null,
                            (addr.address || "").split("@").pop() || null
                        ];
                    })) || null,

                    message.to && [].concat(message.to || []).length && ([].concat(message.to).map(function(addr){
                        return [
                            addr.name || null,
                            null,
                            (addr.address || "").split("@").shift() || null,
                            (addr.address || "").split("@").pop() || null
                        ];
                    })) || null,

                    message.cc && [].concat(message.cc || []).length && ([].concat(message.cc).map(function(addr){
                        return [
                            addr.name || null,
                            null,
                            (addr.address || "").split("@").shift() || null,
                            (addr.address || "").split("@").pop() || null
                        ];
                    })) || null,

                    message.bcc && [].concat(message.bcc || []).length && ([].concat(message.bcc).map(function(addr){
                        return [
                            addr.name || null,
                            null,
                            (addr.address || "").split("@").shift() || null,
                            (addr.address || "").split("@").pop() || null
                        ];
                    })) || null,

                    message.inReplyTo || null,

                    message.messageId || null
                ];
                break;
            default:
                response[param] = null;
        }
        
    }).bind(this));

    return this.escapeObject(response);
};

IMAPMockConnection.prototype.buildCapabilityList = function(){
    return ["CAPABILITY", "IMAP4rev1"].concat(this.server.capabilities[this.state] || []).join(" ");
};

// TODO: ID string should use values provided with initialization as default
IMAPMockConnection.prototype.buildIDString = function(){
    var id = {
        name: packageData.name,
        vendor: packageData.author,
        "support-url": "http://andrisreinman.com",
        version: packageData.version,
        "remote-host": this.socket.remoteAddress
    };

    return "ID (" + Object.keys(id).map((function(key){
        return [this.escapeString(key), this.escapeString(id[key])].join(" ");
    }).bind(this)).join(" ") + ")";
};

IMAPMockConnection.prototype.matchDirectories = function(reference, match){
    var lookup = (reference ? reference + this.server.options.separator : "") + match,
        list = [],
        result = [];

    var walkTree = (function(path, branch){
        Object.keys(branch).forEach((function(key){
            var curBranch = branch[key],
                curPath = (path ? path + this.server.options.separator : "") + key,
                curFlags = [].concat(curBranch.flags || []);
            if(curBranch.directories && Object.keys(curBranch.directories).length){
                curFlags.push("\\HasChildren");
                list.push([curPath, curFlags]);
                walkTree(curPath, curBranch.directories);
            }else{
                curFlags.push("\\HasNoChildren");
                list.push([curPath, curFlags]);
            }
        }).bind(this));
    }).bind(this);

    walkTree(this.server.options.refrence || "", this.server.options.directories || {});

    var query = new RegExp("^" + lookup.
                // escape regex symbols
                replace(/([\\^$+?!.():=\[\]|,\-])/g, "\\$1").
                replace(/[*]/g, ".*").
                replace(/[%]/g, "[^" + (this.server.options.separator.replace(/([\\^$+*?!.():=\[\]|,\-])/g, "\\$1"))+ "]*") +
                "$",
                "");

    list.forEach((function(item){
        if(item[0].match(query)){
            result.push(item);
        }
    }).bind(this));

    return result;
};

