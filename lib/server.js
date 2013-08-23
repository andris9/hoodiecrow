"use strict";

var Stream = require("stream").Stream,
    util = require("util"),
    net = require("net"),
    tls = require("tls"),
    fs = require("fs"),
    IMAPLineParser = require("./lineparser"),
    mimeParser = require("./mimeparser"),
    bodystructure = require("./bodystructure"),
    envelope = require("./envelope"),
    packageData = require("../package"),
    starttls = require("./starttls");

var IMAP_STATES = ["Not Authenticated", "Authenticated", "Selected", "Logout"];

module.exports = function(options){
    return new IMAPMockServer(options);
}

function IMAPMockServer(options){
    Stream.call(this);

    this.options = options || {};

    this.defaultCredentials = {
        key: fs.readFileSync(__dirname+"/../cert/server.key"),
        cert: fs.readFileSync(__dirname+"/../cert/server.crt")
    };

    if(this.options.secureConnection){
        this.server = tls.createServer(this.options.credentials || this.defaultCredentials, this.createClient.bind(this));
    }else{
        this.server = net.createServer(this.createClient.bind(this));
    }

    this.users = {};
    this.capabilities = {};

    this.init();
}
util.inherits(IMAPMockServer, Stream);

IMAPMockServer.commandHandlers = {};

IMAPMockServer.prototype.init = function(){
    [].concat(this.options.enabled || []).forEach((function(capability){
        switch(capability){
            case "LOGINDISABLED":
                this.addCapability(capability, function(){
                    return this.state == "Not Authenticated" && !this.secureConnection;
                });
                break;
            case "STARTTLS":
                this.addCapability(capability, function(){
                    return !this.secureConnection;
                });
                break;
            default:
                this.addCapability(capability);
        }
    }).bind(this));
};

IMAPMockServer.prototype.addCapability = function(key, condition){
    this.capabilities[key] = condition || true;
};

IMAPMockServer.prototype.addUser = function(user, pass){
    this.users[user] = pass;
};

IMAPMockServer.prototype.addMessage = function(mailboxName, message){
    
    message = message || {};

    var path = mailboxName.split(this.options.separator),
        mbox = this.options;

    while(path.length && (mbox = mbox.directories && mbox.directories[path.shift()] || false)){}
    
    if(mbox == this.options || !mbox || (mbox.flags || []).indexOf("\\Noselect") >= 0){
        return false;
    }

    mbox.uidnext = Math.max.apply(Math, [mbox.uidnext || 1].concat((mbox.messages || []).map(function(message){
        return (message.uid || 0) + 1;
    })));

    message.uid = message.uid || mbox.uidnext;
    mbox.uidnext = Math.max(message.uid + 1, mbox.uidnext + 1);

    message.internaldate = message.internaldate || new Date();
    message.flags = message.flags || [];
    message.body = message.body || "";

    if(!Array.isArray(mbox.messages)){
        mbox.messages = [].concat(mbox.messages || []);
    }

    mbox.messages.push(message);

    this.emit("notice", {
        type: "exists",
        mailbox: mailboxName
    });

    return true;
};

IMAPMockServer.prototype.listen = function(){
    var args = Array.prototype.slice.call(arguments);
    this.server.listen.apply(this.server, args);
};

IMAPMockServer.addCommandHandler = function(command, handler){
    command = (command || "").trim().toLowerCase();
    IMAPMockServer.commandHandlers[command] = handler;
};

IMAPMockServer.prototype.createClient = function(socket){
    new IMAPMockConnection(this, socket);
};

function IMAPMockConnection(server, socket){
    this.server = server;
    this.socket = socket;

    this.state = "Not Authenticated";

    this.lineparser = new IMAPLineParser();

    this.secureConnection = !!this.server.options.secureConnection;
    this._ignoreData = false;
    this._remainder = "";
    this._literalRemaining = 0;
    this.queue = [];

    this.notices = [];

    this.idling = false;
    this._processing = false;
    this.socket.on("data", this.onData.bind(this));

    this.socket.on("close", (function(){
        this.socket.removeAllListeners();
        this.socket = null;
    }).bind(this));

    this.socket.on("error", (function(err){
        console.log(err)
        try{
            this.socket.close();
        }catch(E){}
    }).bind(this));

    this.selectedMailbox = false;
    this.mailboxReadOnly = false;

    this.lineparser.on("line", (function(data){
        this.queue.push(data);
        this.processQueue();
    }).bind(this));

    this.server.on("notice", this.onNotice.bind(this));

    this.socket.write("* OK Testserver ready for requests\r\n");
}

IMAPMockConnection.prototype.onData = function(chunk){
    
    if(this._ignoreData){
        // If TLS upgrade is initiated do not process current buffer
        this._remainder = "";
        return;
    }

    var str = this._remainder + (chunk || "").toString("binary"),
        pos = 0,
        len = str.length,
        lineMatch,
        literalMatch,
        line;
 
    this._remainder = "";

    if(this._literalRemaining){
        if(this._literalRemaining >= str.length){
            this.lineparser.writeLiteral(str);
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
                
                this.lineparser.write(line);
                this.lineparser.writeLiteral("");

                this._literalRemaining = Number(literalMatch[1]) || 0;
                this._remainder = str.substr(pos + line.length + lineMatch[0].length);

                this.send("+", "Ready for literal data");

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

IMAPMockConnection.prototype.getMessageRange = function(range, isUid){
    range = (range || "").toString();
    var result = [],
        rangeParts = range.split(","),
        mbox = this.selectedMailbox,
        messages = [].concat(mbox.messages || []),
        uid,
        totalMessages = messages.length,
        inRange = function(nr, ranges, total){
            var range, from, to;
            for(var i=0, len = ranges.length; i<len; i++){
                range = ranges[i];
                to = range.split(":");
                from = Number(to.shift()) || 1;
                to = to.pop() || from;
                to = Number(to=="*" && total || to) || from;
                
                if(nr >= from && nr <= to){
                    return true;
                }
            }
            return false;
        };
    
    mbox.uidnext = Math.max.apply(Math, [mbox.uidnext || 1].concat(messages.map(function(message){
        return (message.uid || 0) + 1;
    })));

    for(var i=0, len = messages.length; i<len; i++){
        uid = messages[i].uid || 1;
        if(inRange(isUid ? uid : i+1, rangeParts, isUid ? mbox.uidnext : totalMessages)){
            result.push([i+1, messages[i]]);
        }
    }

    return result;
}

IMAPMockConnection.prototype.onNotice = function(data){
    if(data.client == this || !this.selectedMailbox || data.mailbox != this.selectedMailbox.path){
        return; // skip own notices
    }
    if(this.idling){
        this.showNotice(data);
    }else{
        this.notices.push(data);
    }
}

IMAPMockConnection.prototype.showNotice = function(data){
    switch(data.type){
        
        case "expunge":
            [].concat(data.messages || []).forEach((function(nr){
                this.send("*", nr+" EXPUNGE");
            }).bind(this));

            if(this.selectedMailbox && this.selectedMailbox.messages){
                this.send("*", this.selectedMailbox.messages.length + " EXISTS");
            }
            break;
        
        case "exists":
            if(this.selectedMailbox && this.selectedMailbox.messages){
                this.send("*", this.selectedMailbox.messages.length + " EXISTS");
            }
            break;
    }
}

IMAPMockConnection.prototype.processNotices = function(){
    var notice;

    if(!this.selectedMailbox){
        return false;
    }

    while(notice = this.notices.shift()){
        this.showNotice(notice);
    }
}

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
    if(!this.socket || this.socket.destroyed){
        return;
    }
    this.socket.write(new Buffer(tag + " " + data + "\r\n", "binary"));
};

IMAPMockConnection.prototype.escapeString = function(str){
    return "\"" + (str || "").toString().replace(/(["\\])/g, "\\$1").replace(/[\r\n]/g, " ") + "\"";
};

IMAPMockConnection.prototype.escapeObject = function(object){
    var walkNode = (function(node){
        var elements = [], str;

        if(Array.isArray(node)){
            if(node._FLAGS){
                return "("+node.join(" ")+")";
            }else{
                elements = node.map(walkNode);
                return "("+elements.join(" ")+")";
            }
        }
        
        if(Object.prototype.toString.call(node) == "[object Date]"){
            node = node.toUTCString();
        }

        switch(typeof node){
            case "object":
                if(!node){
                    return "NIL";
                }
                
                if("_LITERAL" in node){
                    str = node._LITERAL.toString("binary");
                    return "{"+str.length+"}\r\n"+str;
                }

                return "(" + Object.keys(node).map(function(key){
                    return key + " " + walkNode(node[key]);
                }).join(" ") + ")";
            case "string":
                return this.escapeString(node);
                break;
            case "number":
                return node && node.toString();
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
        if(tag.toLowerCase() == "done"){
            this.send(this.idling, "OK IDLE terminated (Success)");
        }else{
            this.send(this.idling, "BAD Could not parse command");
        }
        this.idling = false;
        return callback();
    }

    if(typeof IMAPMockServer.commandHandlers[command] == "function"){
        IMAPMockServer.commandHandlers[command].call(this, tag, data, callback);
    }else{
        this.send(tag, "BAD Unknown command: " + command.toUpperCase());
        callback();
    }
};

IMAPMockConnection.prototype.checkSupport = function(capability){
    if(this.server.capabilities[capability] === true){
        return true;
    }
    if(typeof this.server.capabilities[capability] == "function" && 
      this.server.capabilities[capability].call(this)){
        return true;
    }
    return false;
};

IMAPMockConnection.prototype.buildMessageResponse = function(message, params, isUid){
    var response = {}, value;

    if(!message.structured){
        message.structured = mimeParser(message.body || "");
    }

    if(!message.internaldate){
        message.internaldate = new Date();
    }

    var list = (params || []);

    if(!Array.isArray(list)){
        switch((list && list.value || list || "").toUpperCase()){
            case "ALL":
                list = ["FLAGS", "INTERNALDATE", "RFC822.SIZE", "ENVELOPE"];
                break;
            case "FAST":
                list = ["FLAGS", "INTERNALDATE", "RFC822.SIZE"];
                break;
            case "FULL":
                list = ["FLAGS", "INTERNALDATE", "RFC822.SIZE", "ENVELOPE", "BODY"];
                break;
            default:
                list = [list];
        }
    }

    if(isUid){
        if(list.map(function(param){return (param || "").toString().toUpperCase().trim()}).indexOf("UID") < 0){
            list.push("UID");
        }
    }
    
    list.forEach((function(param){
        switch(param && param.value || param){
            case "UID":
            case "FLAGS":
                response[param] = message[param.toLowerCase()] || null;
                if(response[param]){
                    response[param]._FLAGS = true;
                }
                break;
            case "INTERNALDATE":
                response[param] = message.internaldate;
                break;
            case "RFC822.SIZE":
                response[param] = (message.body || "").length;
                break;
            case "RFC822":
                if(!param.value){
                    param = {
                        value: "RFC822",
                        responseName: "RFC822"
                    };
                }else{
                    param.responseName = param.value;
                }
                // fallback to body handler
            case "BODY":
                if(!param.value){
                    response[param] = bodystructure(message.structured, {body: true, upperCaseKeys: true});
                }else{
                    param.responseName = param.responseName || "BODY[]";
                    if(!param.params.length){
                        value = message.body || "";
                        if(param.partial && param.partial.length){
                            value = String.prototype.substr.apply(value, param.partial) || "";
                            response[param.responseName + "<" + param.partial.join(".")+ ">"] = {_LITERAL: value};
                        }else{
                            response[param.responseName] = {_LITERAL: value};
                        }    
                    }else{

                    }
                }
                break;
            case "BODYSTRUCTURE":
                response[param] = bodystructure(message.structured, {upperCaseKeys: true, skipContentLocation: true});
                break;
            case "ENVELOPE":
                response.ENVELOPE = envelope(message);
                break;
            default:
                if(typeof param != "object"){
                    response[param] = null;    
                }
        }
        
    }).bind(this));

    return this.escapeObject(response);
};

IMAPMockConnection.prototype.getUIDMessage = function(uid){
    for(var i=0, len = (this.selectedMailbox.messages || []).length; i<len; i++){
        if(this.selectedMailbox.messages[i] == uid){
            return this.selectedMailbox.messages[i];
        }
    }
    return false;
};

IMAPMockConnection.prototype.buildCapabilityList = function(){
    var list = [];
    Object.keys(this.server.capabilities).forEach((function(capability){
        if(this.checkSupport(capability)){
            list.push(capability);
        }
    }).bind(this));
    return ["CAPABILITY", "IMAP4rev1"].concat(list).join(" ");
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

// Command handlers

IMAPMockServer.addCommandHandler("CAPABILITY", function(tag, data, callback){
    this.send("*", this.buildCapabilityList());
    this.processNotices();
    this.send(tag, "OK");
    return callback();
});

IMAPMockServer.addCommandHandler("FETCH", function(tag, data, callback){
    if(this.state != "Selected"){
        this.send(tag, "BAD Unknown command");
        return callback();
    }

    var range = data.shift(),
        params = data.shift() || [];

    this.getMessageRange(range).forEach((function(item){
        this.send("*", item[0] + " FETCH " + this.buildMessageResponse(item[1], params));
    }).bind(this));

    this.send(tag, "OK Success");

    callback();
});

IMAPMockServer.addCommandHandler("STORE", function(tag, data, callback){
    if(this.state != "Selected" || this.mailboxReadOnly){
        this.send(tag, "BAD Unknown command");
        return callback();
    }

    var message;

    this.getMessageRange(data.shift()).forEach((function(item){
        var i = item[0],
            message = item[1];
                
        switch((data[0] ||"").toUpperCase()){
            case "FLAGS":
            case "FLAGS.SILENT":
                message.flags = [].concat(data[1] || []);
                break;

            case "+FLAGS":
            case "+FLAGS.SILENT":
                message.flags = [].concat(message.flags || []);
                [].concat(data[1] || []).forEach(function(flag){
                    if(message.flags.indexOf(flag) < 0){
                        message.flags.push(flag);
                    }
                });
                break;
            case "-FLAGS":
            case "-FLAGS.SILENT":
                message.flags = [].concat(message.flags || []);
                [].concat(data[1] || []).forEach(function(flag){
                    for(var i = message.flags.length - 1; i >= 0; i--){
                        if(message.flags[i] == flag){
                            message.flags.splice(i,1);
                            break;
                        }
                    }
                });
                break;
        }

        if((data[0] ||"").match(/^[\-+]?FLAGS$/i)){
            this.send("*", i + " FETCH (FLAGS ("+ message.flags.join(" ") +"))");
        }
    }).bind(this));

    this.send(tag, "OK STORE completed");

    callback();
});

IMAPMockServer.addCommandHandler("SELECT", function(tag, data, callback){
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
        this.selectedMailbox.path = mailboxName;

        this.mailboxReadOnly = false;

        if(this.server.options.flags && this.server.options.flags.length){
            this.send("*", "FLAGS (" + this.server.options.flags.join(" ") + ")");
            this.send("*", " OK [PERMANENTFLAGS (" + this.server.options.flags.join(" ") + " \\*)  Flags permitted.");
        }
        this.send("*", "OK [UIDVALIDITY " + (mbox.uidvalitity || 1) + "] UIDs valid.");
        this.send("*", (mbox.messages || []).length+" EXISTS");
        this.send("*", "0 RECENT");
        
        mbox.uidnext = Math.max.apply(Math, [mbox.uidnext || 1].concat((mbox.messages || []).map(function(message){
            return (message.uid || 0) + 1;
        })));

        this.send("*", "OK [UIDNEXT " + mbox.uidnext + "] Predicted next UID.");
        
        this.state = "Selected";

        this.notices = [];
        this.send(tag, "OK [READ-WRITE] " + mailboxName + " selected. (Success)");
    }
    
    callback();
});

IMAPMockServer.addCommandHandler("EXAMINE", function(tag, data, callback){
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
        this.selectedMailbox.path = mailboxName;

        this.mailboxReadOnly = true;

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
        
        this.state = "Selected";

        this.notices = [];
        this.send(tag, "OK [READ-ONLY] EXAMINE completed. (Success)");
    }
    
    callback();
});

IMAPMockServer.addCommandHandler("CLOSE", function(tag, data, callback){
    if(this.state != "Selected"){
        this.send(tag, "BAD Unknown command");
        return callback();
    }
    
    this.state = "Authenticated";
    this.selectedMailbox = false;
    this.notices = [];

    this.send(tag, "OK CLOSE completed");

    callback();
});

IMAPMockServer.addCommandHandler("STATUS", function(tag, data, callback){
    if(["Authenticated", "Selected"].indexOf(this.state) < 0){
        this.send(tag, "BAD Unknown command");
        return callback();
    }

    var mailboxName = (data.shift() || ""),
        request = [].concat(data.shift() || []),
        path = mailboxName.split(this.server.options.separator),
        mbox = this.server.options,
        flags = {},
        unseen = 0,
        response = [];

    while(path.length && (mbox = mbox.directories && mbox.directories[path.shift()] || false)){}
    
    if(mbox == this.server.options || !mbox || (mbox.flags || []).indexOf("\\Noselect") >= 0){
        this.send(tag, "NO [NONEXISTENT] Unknown Mailbox: " + mailboxName + " (Failure)");
    }else{

        [].concat(mbox.messages || []).forEach(function(message){
            var messageFlags = [].concat(message.flags || []);
            messageFlags.forEach(function(flag){
                if(!flags[flag]){
                    flags[flag] = 1;
                }else{
                    flags[flag]++;
                }
            });
            if(messageFlags.indexOf("\\Seen") < 0){
                unseen++;
            }
        });

        request.forEach((function(req){
            req = (req || "").toString().toUpperCase();
            response.push(req);
            switch(req){
                case "MESSAGES":
                    response.push([].concat(mbox.messages || []).length);
                    break;
                case "RECENT":
                    response.push(flags["\\Recent"] || 0);
                    break;
                case "UIDNEXT":
                    response.push(mbox.uidnext || 1);
                    break;
                case "UIDVALIDITY":
                    response.push(mbox.uidvalitity || 1);
                    break;
                case "UNSEEN":
                    response.push(unseen);
                    break;
                default:
                    response.push(null);
            }
        }).bind(this));

        this.send("*", "STATUS (" + response.join(" ") + ")");
        this.send(tag, "OK STATUS completed. (Success)");
    }
    
    callback();
});

IMAPMockServer.addCommandHandler("LSUB", function(tag, data, callback){
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

    this.processNotices();
    this.send(tag, "OK Success");

    callback();
});

IMAPMockServer.addCommandHandler("LIST", function(tag, data, callback){
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

    this.processNotices();
    this.send(tag, "OK Success");

    callback();
});

IMAPMockServer.addCommandHandler("ID", function(tag, data, callback){
    if(!this.checkSupport("ID")){
        this.send(tag, "BAD Unknown command: ID");
        return callback();
    }

    this.send("*", this.buildIDString());
    this.processNotices();
    this.send(tag, "OK Success");

    callback();
});

IMAPMockServer.addCommandHandler("NOOP", function(tag, data, callback){
    this.processNotices();
    this.send(tag, "OK NOOP completed");
    callback();
});

IMAPMockServer.addCommandHandler("STARTTLS", function(tag, data, callback){
    if(!this.checkSupport("STARTTLS")){
        this.send(tag, "BAD Unknown command: STARTTLS");
        return callback();
    }

    if(this.secureConnection){
        this.send(tag, "BAD Connection already secure");
        return callback();
    }

    var credentials = this.server.options.credentials || this.server.defaultCredentials;

    this._ignoreData = true;
    this.send(tag, "OK Server ready to start TLS negotiation");
    var secureConnector = starttls(this.socket, credentials, (function(socket){
        this._ignoreData = false;
        this._remainder = "";
        
        this.socket = socket;
        this.socket.on("data", this.onData.bind(this));

        this.secureConnection = true;

        if(!socket.authorized){
            console.log("WARNING: TLS ERROR ("+socket.authorizationError+")");
        }

        this.processNotices();
        callback();
    }).bind(this));

    secureConnector.on("error", function(err){
        console.log(err)
        try{
            this.socket.close();
        }catch(E){}
        try{
            secureConnector.close();
        }catch(E){}
    });
});

IMAPMockServer.addCommandHandler("LOGOUT", function(tag){
    this.state = "Logout";
    this.notices = [];
    setTimeout((function(){
        if(this.socket && !this.socket.destroyed){
            this.send("*", "BYE IMAP4rev1 Server logging out");
            this.send(tag, "OK LOGOUT completed");
            this.socket.end();
        }
    }), 1000);
    
});

IMAPMockServer.addCommandHandler("IDLE", function(tag, data, callback){
    if(!this.checkSupport("IDLE")){
        this.send(tag, "BAD Unknown command: IDLE");
        return callback();
    }
    this.idling = tag;
    this.send("+", "idling");
    this.processNotices();
    callback();
});

IMAPMockServer.addCommandHandler("LOGIN", function(tag, data, callback){
    if(this.checkSupport("LOGINDISABLED")){
        this.send(tag, "NO Upgrade to secure connection first");
        return callback();
    }

    if(this.state != "Not Authenticated"){
        this.send(tag, "BAD Already logged in");
        return callback();
    }

    var user = data.shift() || "",
        pass = data.shift() || "";

    if(!(user in this.server.users) || this.server.users[user] != pass){
        this.send(tag, "NO Invalid credentials");
    }else{
        this.state = "Authenticated";
        this.send("*", this.buildCapabilityList());
        this.send(tag, "OK " + user + " authenticated (Success)");
    }

    callback();
});

IMAPMockServer.addCommandHandler("EXPUNGE", function(tag, data, callback){
    if(this.state != "Selected" || this.mailboxReadOnly){
        this.send(tag, "BAD Unknown command");
        return callback();
    }

    var expunged = [],
        messages = [].concat(this.selectedMailbox.messages || []);
    
    for(var i = messages.length - 1; i>=0; i--){
        if([].concat(messages[i].flags || []).indexOf("\\Deleted") >= 0){
            expunged.unshift(i + 1);
            this.selectedMailbox.messages.splice(i, 1);
        }
    }

    expunged.forEach((function(nr){
        this.send("*", nr+" EXPUNGE")
    }).bind(this));

    this.server.emit("notice", {
        type: "expunge",
        mailbox: this.selectedMailbox.path,
        messages: expunged,
        client: this
    });
    
    this.processNotices();
    this.send(tag, "OK Expunge completed (Success)");

    callback();
});

IMAPMockServer.addCommandHandler("APPEND", function(tag, data, callback){
    if(["Authenticated", "Selected"].indexOf(this.state) < 0){
        this.send(tag, "BAD Unknown command");
        return callback();
    }

    var mailboxName = data.shift() || "",
        body = new Buffer(data.pop() || "", "binary"),
        flags = data.shift() || [],
        date = data.shift() || new Date(),
        path = mailboxName.split(this.server.options.separator),
        mbox = this.server.options,
        message = {};

    while(path.length && (mbox = mbox.directories && mbox.directories[path.shift()] || false)){}

    if(mbox == this.server.options || !mbox || (mbox.flags || []).indexOf("\\Noselect") >= 0){
        this.processNotices();
        this.send(tag, "NO [NONEXISTENT] Unknown Mailbox: " + mailboxName + " (Failure)");
        return;
    }

    // ensure propert uidnext value
    mbox.uidnext = Math.max.apply(Math, [mbox.uidnext || 1].concat((mbox.messages || []).map(function(message){
        return (message.uid || 0) + 1;
    })));

    message.uid = mbox.uidnext++;
    message.flags = flags;
    message.internaldate = date;
    message.body = body;

    if(!Array.isArray(mbox.messages)){
        mbox.messages = [].concat(mbox.messages || []);
    }

    mbox.messages.push(message);

    if(this.selectedMailbox && mailboxName == this.selectedMailbox.path){
        this.send("*", this.selectedMailbox.messages.length +" EXISTS");
    }

    this.server.emit("notice", {
        type: "exists",
        mailbox: mbox.path,
        client: this
    });

    this.send(tag, "OK APPEND completed (Success)");
    callback();
});

IMAPMockServer.addCommandHandler("UID", function(tag, data, callback){
    if(this.state != "Selected"){
        this.send(tag, "BAD Unknown command");
        return callback();
    }

    var command = ((data || []).shift() || "").toString().toUpperCase();

    switch(command){
        case "FETCH":
            var range = data.shift(),
                params = data.shift() || [],
                mbox = this.selectedMailbox;

            this.getMessageRange(range, true).forEach((function(item){
                this.send("*", item[0] + " FETCH " + this.buildMessageResponse(item[1], params, true));
            }).bind(this));

            this.processNotices();
            this.send(tag, "OK UID FETCH completed");
            break;
        default:
            this.send(tag, "BAD Unknown command");
    }

    callback();
});