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

    this.options.permanentFlags = this.options.permanentFlags || 
            ["\\Answered", "\\Flagged", "\\Draft", "\\Deleted", "\\Seen"];

    this.options.separator = this.options.separator || "/";

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

    this.indexDirectories();
};

IMAPMockServer.prototype.indexDirectories = function(){
    var directories = {};

    var walkTree = (function(path, branch){
        Object.keys(branch).forEach((function(key){
            var curBranch = branch[key],
                curPath = (path ? path + this.options.separator : "") + key,
                curFlags = [].concat(curBranch.flags || []);
            directories[curPath] = curBranch;

            curBranch.path = curPath;
            curBranch.uid = curBranch.uid || 1;
            curBranch.uidvalitity = curBranch.uidvalitity || 1;
            curBranch.flags = curFlags;
            
            // ensure message array
            curBranch.messages = [].concat(curBranch.messages || []);

            // ensure highest uidnext
            curBranch.uidnext = Math.max.apply(Math, [curBranch.uidnext || 1].concat(curBranch.messages.map(function(message){
                return (message.uid || 0) + 1;
            })));

            // ensure uid and flags for every message
            curBranch.messages.forEach(function(message){
                message.flags = [].concat(message.flags || []);
                message.uid = message.uid || curBranch.uidnext++;
            });

            if(curBranch.directories && Object.keys(curBranch.directories).length){
                curFlags.push("\\HasChildren");
                walkTree(curPath, curBranch.directories);
            }else{
                curFlags.push("\\HasNoChildren");
            }

        }).bind(this));
    }).bind(this);

    walkTree(this.options.refrence || "", this.options.directories || {});

    this.directoryCache = directories;
    this.uidnextCache = {};
};

IMAPMockServer.prototype.checkMailboxName = function(mailboxName){
    return (mailboxName || "").toString().trim().replace(/^inbox(?=\W|$)/i, "INBOX");
};

IMAPMockServer.prototype.addCapability = function(key, condition){
    this.capabilities[key] = condition || true;
};

IMAPMockServer.prototype.addUser = function(user, pass){
    this.users[user] = pass;
};

IMAPMockServer.prototype.updateFlags = function(message, modifier, flags){
    flags = [].concat(flags || [])

    switch((modifier ||"").toUpperCase()){
        case "FLAGS":
        case "FLAGS.SILENT":
            message.flags = flags;
            break;

        case "+FLAGS":
        case "+FLAGS.SILENT":
            flags.forEach(function(flag){
                if(message.flags.indexOf(flag) < 0){
                    message.flags.push(flag);
                }
            });
            break;

        case "-FLAGS":
        case "-FLAGS.SILENT":
            flags.forEach(function(flag){
                for(var i = message.flags.length - 1; i >= 0; i--){
                    if(message.flags[i] == flag){
                        message.flags.splice(i,1);
                        break;
                    }
                }
            });
            break;
    }

}

IMAPMockServer.prototype.addMessage = function(mailboxName, message, client){
    
    message = message || {};

    var mbox = this.directoryCache[this.checkMailboxName(mailboxName)] || false;
    if(!mbox || mbox.flags.indexOf("\\Noselect") >= 0){
        return false;
    }

    message.uid = message.uid || mbox.uidnext;
    mbox.uidnext = Math.max(message.uid + 1, mbox.uidnext + 1);

    message.internaldate = message.internaldate || new Date();
    message.flags = message.flags || [];
    message.body = message.body || "";

    mbox.messages.push(message);

    this.emit("notice", {
        type: "exists",
        mailbox: mailboxName,
        client: client
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

    this.directoryCache = this.server.directoryCache;

    this.secureConnection = !!this.server.options.secureConnection;
    this._ignoreData = false;
    this._remainder = "";
    this._literalRemaining = 0;
    this.queue = [];

    this.notices = [];

    this.idling = false;
    this._processing = false;
    this.socket.on("data", this.onData.bind(this));

    this.socket.pipe(process.stdout);

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

    this.lineparser.on("log", (function(data){
        console.log("CLIENT: %s", data);
    }).bind(this));

    this.lineparser.on("line", (function(data){
        this.queue.push(data);
        this.processQueue();
    }).bind(this));

    this.server.on("notice", this.onNotice.bind(this));

    this.socket.write("* OK Testserver ready for requests\r\n");

    if(this.server.options.preauth){
        this.state = "Authenticated";
        this.send("*", "PREAUTH IMAP4rev1 server logged in as " + this.server.options.preauth);
        this.send("*", this.buildCapabilityList());
    }
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
        messages = mbox.messages,
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
            data.messages.forEach((function(nr){
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

        console.log("PARSED: " + JSON.stringify(data));

        this.processCommand(data, processor);
    }).bind(this);

    processor();
};

IMAPMockConnection.prototype.send = function(tag, data){
    if(!this.socket || this.socket.destroyed){
        return;
    }
    console.log("SEND: %s", tag + " " + data)
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

    if(["*"].indexOf(tag) >= 0){
        this.send(tag, "BAD Invalid tag");
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
    
    list.forEach(function(param){
        var paramName = (param && param.value || param).toString().toUpperCase();
        // if RFC822 or BODY[.] is requested, mark the message as read
        if(paramName == "RFC822" || param.value == "BODY"){
            if(message.flags.indexOf("\\Seen") < 0){
                message.flags = message.flags.concat("\\Seen");
                if(list.map(function(param){return (param || "").toString().toUpperCase().trim()}).indexOf("FLAGS") < 0){
                    list.push("FLAGS");
                }
            }
        }
    });

    list.forEach((function(param){
        var bodystruct, 
            paramName = (param && param.value || param).toString().toUpperCase();

        switch(paramName){
            case "UID":
            case "FLAGS":
                response[paramName] = message[param.toLowerCase()] || null;
                if(response[paramName]){
                    response[paramName]._FLAGS = true;
                }
                break;
            case "INTERNALDATE":
                response[paramName] = message.internaldate;
                break;
            case "RFC822.SIZE":
                response[paramName] = (message.body || "").length;
                break;
            case "RFC822":
                response[paramName] = {_LITERAL: message.body || ""};
                break;
            case "RFC822.HEADER":
                response["RFC822.HEADER"] = {_LITERAL: (message.structured.header || []).join("\r\n") + "\r\n\r\n"};
                break;
            case "BODY.PEEK":
            case "BODY":
                if(!param.value){
                    if(paramName == "BODY.PEEK"){
                        // TODO: this is an error condition, BODY.PEEK requires additional params
                    }
                    response["BODY"] = bodystructure(message.structured, {body: true, upperCaseKeys: true});
                }else{

                    if(!param.params.length){
                        value = message.body || "";
                        if(param.partial && param.partial.length){
                            // use form "BODY[]<start.count>" or "BODY[]<start>" where 'count' is not
                            // included if it is missing or start+count is larger than maximum length
                            value = String.prototype.substr.apply(value, param.partial) || "";
                            response["BODY[]<" + 
                                (param.partial.length > 1 && 
                                  (Number(param.partial[0]) || 0) + 
                                  (Number(param.partial[0]) || 0) > 
                                    (message.body || "").length ? 
                                        [param.partial[0]] : 
                                        param.partial).join(".")+ ">"] = {_LITERAL: value};
                        }else{
                            response["BODY[]"] = {_LITERAL: value};
                        }    
                    }else{
                        bodystruct = bodystructure(message.structured, {body: true, upperCaseKeys: true})
                        switch(param.params[0]){
                            case "HEADER":
                                response["BODY[HEADER]"] = {_LITERAL: (message.structured.header || []).join("\r\n") + "\r\n\r\n"};
                                break;
                            case "HEADER.FIELDS":
                                param.responseName = "BODY[HEADER.FIELDS ("+[].concat(param.params[1] || []).join(" ")+")]";
                                value = [];
                                (message.structured.header || []).forEach(function(line){
                                    var key = (line.split(":").shift() || "").trim().toLowerCase();
                                    [].concat(param.params[1]).forEach(function(p){
                                        p = (p || "").toLowerCase().trim();
                                        if(p == key){
                                            value.push(line);
                                        }
                                    });
                                });
                                response[param.responseName] = {_LITERAL: (value || []).join("\r\n") + "\r\n\r\n"};
                                break;
                            case "HEADER.FIELDS.NOT":
                                param.responseName = "BODY[HEADER.FIELDS.NOT ("+[].concat(param.params[1] || []).join(" ")+")]";
                                value = [];
                                (message.structured.header || []).forEach(function(line){
                                    var key = (line.split(":").shift() || "").trim().toLowerCase();
                                    if([].concat(param.params[1] || []).map(function(p){
                                        return (p || "").toLowerCase().trim();
                                    }).indexOf(key) < 0){
                                        value.push(line);
                                    }
                                });
                                response[param.responseName] = {_LITERAL: (value || []).join("\r\n") + "\r\n\r\n"};
                                break;
                        }
                    }
                }
                break;
            case "BODYSTRUCTURE":
                response[paramName] = bodystructure(message.structured, {upperCaseKeys: true, skipContentLocation: true});
                break;
            case "ENVELOPE":
                response.ENVELOPE = envelope(message);
                break;
            default:
                if(typeof param != "object"){
                    response[paramName] = null;    
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

    var query = new RegExp("^" + lookup.
                // escape regex symbols
                replace(/([\\^$+?!.():=\[\]|,\-])/g, "\\$1").
                replace(/[*]/g, ".*").
                replace(/[%]/g, "[^" + (this.server.options.separator.replace(/([\\^$+*?!.():=\[\]|,\-])/g, "\\$1"))+ "]*") +
                "$",
                "");

    Object.keys(this.directoryCache).forEach((function(path){
        if(path.match(query) && (this.directoryCache[path].flags.indexOf("\\NonExistent") < 0 || this.directoryCache[path].path == match)){
            result.push(this.directoryCache[path]);
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

    this.getMessageRange(data.shift()).forEach((function(item){
        this.server.updateFlags(item[1], data[0], data[1]);
        if((data[0] ||"").match(/^[\-+]?FLAGS$/i)){
            this.send("*", item[0] + " FETCH (FLAGS ("+ item[1].flags.join(" ") +"))");
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
        mbox = this.directoryCache[this.server.checkMailboxName(mailboxName)] || false;
    
    if(!mbox || mbox.flags.indexOf("\\Noselect") >= 0){
        this.send(tag, "NO [NONEXISTENT] Unknown Mailbox: " + mailboxName + " (Failure)");
        return callback();
    }

    this.selectedMailbox = mbox;
    this.mailboxReadOnly = false;
    this.state = "Selected";
    this.notices = [];

    this.usedFlags
    this.selectedMailbox.messages

    this.send("*", "FLAGS (" + this.server.options.permanentFlags.join(" ") + ")");
    this.send("*", "OK [PERMANENTFLAGS (" + this.server.options.permanentFlags.join(" ") + " \\*)  Flags permitted.");
    this.send("*", "OK [UIDVALIDITY " + mbox.uidvalitity + "] UIDs valid.");
    this.send("*", mbox.messages.length+" EXISTS");
    this.send("*", "0 RECENT");
    this.send("*", "OK [UIDNEXT " + mbox.uidnext + "] Predicted next UID.");

    this.send(tag, "OK [READ-WRITE] " + mailboxName + " selected. (Success)");
    
    callback();
});

IMAPMockServer.addCommandHandler("EXAMINE", function(tag, data, callback){
    if(["Authenticated", "Selected"].indexOf(this.state) < 0){
        this.send(tag, "BAD Unknown command");
        return callback();
    }

    var mailboxName = (data.shift() || ""),
        mbox = this.directoryCache[this.server.checkMailboxName(mailboxName)] || false;
    
    if(!mbox || mbox.flags.indexOf("\\Noselect") >= 0){
        this.send(tag, "NO [NONEXISTENT] Unknown Mailbox: " + mailboxName + " (Failure)");
        return callback();
    }

    this.selectedMailbox = mbox;
    this.mailboxReadOnly = true;
    this.state = "Selected";
    this.notices = [];

    this.send("*", "FLAGS (" + this.server.options.permanentFlags.join(" ") + ")");
    this.send("*", " OK [PERMANENTFLAGS (" + this.server.options.permanentFlags.join(" ") + " \\*)  Flags permitted.");
    this.send("*", "OK [UIDVALIDITY " + mbox.uidvalitity + "] UIDs valid.");
    this.send("*", mbox.messages.length+" EXISTS");
    this.send("*", "0 RECENT");
    this.send("*", "OK [UIDNEXT " + mbox.uidnext + "] Predicted next UID.");

    this.send(tag, "OK [READ-ONLY] EXAMINE completed. (Success)");
    
    callback();
});

IMAPMockServer.addCommandHandler("CLOSE", function(tag, data, callback){
    if(this.state != "Selected"){
        this.send(tag, "BAD Unknown command");
        return callback();
    }

    var expunged = [],
        messages = this.selectedMailbox.messages;
    
    for(var i = messages.length - 1; i>=0; i--){
        if(messages[i].flags.indexOf("\\Deleted") >= 0){
            expunged.unshift(i + 1);
            this.selectedMailbox.messages.splice(i, 1);
        }
    }

    this.server.emit("notice", {
        type: "expunge",
        mailbox: this.selectedMailbox.path,
        messages: expunged,
        client: this
    });
    
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
        mbox = mbox = this.directoryCache[this.server.checkMailboxName(mailboxName)] || false,
        request = [].concat(data.shift() || []),
        flags = {},
        unseen = 0,
        response = [];
    
    if(!mbox || mbox.flags.indexOf("\\Noselect") >= 0){
        this.send(tag, "NO [NONEXISTENT] Unknown Mailbox: " + mailboxName + " (Failure)");
        return callback();
    }

    mbox.messages.forEach(function(message){
        message.flags.forEach(function(flag){
            if(!flags[flag]){
                flags[flag] = 1;
            }else{
                flags[flag]++;
            }
        });
        if(message.flags.indexOf("\\Seen") < 0){
            unseen++;
        }
    });

    request.forEach((function(req){
        req = (req || "").toString().toUpperCase();
        response.push(req);
        switch(req){
            case "MESSAGES":
                response.push(mbox.messages.length);
                break;
            case "RECENT":
                response.push(flags["\\Recent"] || 0);
                break;
            case "UIDNEXT":
                response.push(mbox.uidnext);
                break;
            case "UIDVALIDITY":
                response.push(mbox.uidvalitity);
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

    callback();
});

IMAPMockServer.addCommandHandler("LSUB", function(tag, data, callback){
    if(["Authenticated", "Selected"].indexOf(this.state) < 0){
        this.send(tag, "BAD Unknown command");
        return callback();
    }

    var reference = data[0] || "",
        mailboxName = data[1] || "",
        result = this.matchDirectories(reference, mailboxName);

    result.forEach((function(mbox){
        if(!mbox.unsubscribed){
            this.send("*", 'LSUB ('+ mbox.flags.join(" ") +') "' + 
                (this.server.options.separator || "/") + 
                '" ' + 
                this.escapeString(mbox.path));    
        }
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

    var reference = data[0] || "",
        mailboxName = data[1] || "",
        result = this.matchDirectories(reference, mailboxName);

    result.forEach((function(mbox){
        this.send("*", 'LIST ('+ mbox.flags.join(" ") +') "' + 
            (this.server.options.separator || "/") + 
            '" ' + 
            this.escapeString(mbox.path));
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

IMAPMockServer.addCommandHandler("CHECK", function(tag, data, callback){
    this.processNotices();
    this.send(tag, "OK CHECK completed");
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
        messages = this.selectedMailbox.messages;
    
    for(var i = messages.length - 1; i>=0; i--){
        if(messages[i].flags.indexOf("\\Deleted") >= 0){
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

    var mailboxName = (data.shift() || ""),
        mbox = this.directoryCache[this.server.checkMailboxName(mailboxName)] || false,
        body = new Buffer(data.pop() || "", "binary"),
        flags = data.shift() || [],
        date = data.shift() || new Date(),
        message = {
            flags: flags,
            internaldate: date,
            body: body
        };

    if(!mbox || mbox.flags.indexOf("\\NonExistent") >= 0){
        this.send(tag, "NO [TRYCREATE] Unknown Mailbox: " + mailboxName + " (Failure)");
        return callback();
    }

    this.server.addMessage(mailboxName, message, this);

    if(this.selectedMailbox && mailboxName == this.selectedMailbox.path){
        this.send("*", this.selectedMailbox.messages.length +" EXISTS");
    }

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
        
        case "STORE":
            var range = data.shift(),
                mbox = this.selectedMailbox;

            this.getMessageRange(range, true).forEach((function(item){
                this.server.updateFlags(item[1], data[0], data[1]);
                if((data[0] ||"").match(/^[\-+]?FLAGS$/i)){
                    this.send("*", item[0] + " FETCH " + this.buildMessageResponse(item[1], ["FLAGS"], true));
                }
            }).bind(this));

            this.processNotices();
            this.send(tag, "OK UID STORE completed");
            break;
        case "COPY":
            var range = data.shift(),
                mailboxName = (data.shift() || ""),
                mbox = this.directoryCache[this.server.checkMailboxName(mailboxName)] || false,
                params = data.shift() || [];

            if(!mbox || mbox.flags.indexOf("\\NonExistent") >= 0){
                this.send(tag, "NO [TRYCREATE] Unknown Mailbox: " + mailboxName + " (Failure)");
                return callback();
            }

            if(this.selectedMailbox && mbox == this.selectedMailbox){
                this.send(tag, "NO Select different destination");
                return callback();
            }

            this.getMessageRange(range, true).forEach((function(item){
                var message = {
                    flags: [].concat(item[1].flags || []), // make a copy, these values might get modified later
                    internaldate: item[1].date,
                    body: item[1].body,
                }
                // TODO: add \Recent flag to copied messages
                this.server.addMessage(mailboxName, message, this);
            }).bind(this));

            this.send(tag, "OK UID STORE completed");
            break;
        case "SEARCH":
            // TODO: just a placeholder
            this.send(tag, "OK UID SEARCH completed");
            break;
        default:
            this.send(tag, "BAD Unknown command");
    }

    callback();
});

IMAPMockServer.addCommandHandler("SUBSCRIBE", function(tag, data, callback){
    if(["Authenticated", "Selected"].indexOf(this.state) < 0){
        this.send(tag, "BAD Unknown command");
        return callback();
    }

    var mailboxName = (data.shift() || ""),
        mbox = this.directoryCache[this.server.checkMailboxName(mailboxName)] || false;
    
    if(!mbox || mbox.flags.indexOf("\\NonExistent") >= 0){
        this.send(tag, "NO [NONEXISTENT] Unknown Mailbox: " + mailboxName + " (Failure)");
        return callback();
    }

    mbox.unsubscribed = false;
    
    this.send(tag, "OK SUBSCRIBE completed");
    callback();
});

IMAPMockServer.addCommandHandler("UNSUBSCRIBE", function(tag, data, callback){
    if(["Authenticated", "Selected"].indexOf(this.state) < 0){
        this.send(tag, "BAD Unknown command");
        return callback();
    }

    var mailboxName = (data.shift() || ""),
        mbox = this.directoryCache[this.server.checkMailboxName(mailboxName)] || false;
    
    if(!mbox){
        this.send(tag, "NO [NONEXISTENT] Unknown Mailbox: " + mailboxName + " (Failure)");
        return callback();
    }

    mbox.unsubscribed = true;
    
    this.send(tag, "OK UNSUBSCRIBE completed");
    callback();
});

IMAPMockServer.addCommandHandler("COPY", function(tag, data, callback){
    if(["Authenticated", "Selected"].indexOf(this.state) < 0){
        this.send(tag, "BAD Unknown command");
        return callback();
    }

    var range = data.shift(),
        mailboxName = (data.shift() || ""),
        mbox = this.directoryCache[this.server.checkMailboxName(mailboxName)] || false,
        params = data.shift() || [];

    if(!mbox || mbox.flags.indexOf("\\NonExistent") >= 0){
        this.send(tag, "NO [TRYCREATE] Unknown Mailbox: " + mailboxName + " (Failure)");
        return callback();
    }

    if(this.selectedMailbox && mbox == this.selectedMailbox){
        this.send(tag, "NO Select different destination");
        return callback();
    }

    this.getMessageRange(range).forEach((function(item){
        var message = {
            flags: [].concat(item[1].flags || []), // make a copy, these values might get modified later
            internaldate: item[1].date,
            body: item[1].body,
        }
        // TODO: add \Recent flag to copied messages
        this.server.addMessage(mailboxName, message, this);
    }).bind(this));

    this.send(tag, "OK COPY completed (Success)");
    callback();
});

IMAPMockServer.addCommandHandler("CREATE", function(tag, data, callback){
    if(["Authenticated", "Selected"].indexOf(this.state) < 0){
        this.send(tag, "BAD Unknown command");
        return callback();
    }

    var mailboxName = (data.shift() || ""),
        mbox = this.directoryCache[this.server.checkMailboxName(mailboxName)] || false,
        path = this.server.checkMailboxName(mailboxName).split(this.server.options.separator),
        name,
        mailbox,
        curBranch = this.server.directories;

    // remove trailing / if needed
    if(path.length && !path[path.length-1]){
        path.pop();
    }

    if(!path){
        this.send(tag, "BAD Can not create Mailbox: " + mailboxName + " (Failure)");
        return callback();
    }

    if(mbox){
        if(mbox.flags.indexOf("\\NonExistent") < 0){
            this.send(tag, "NO Mailbox: " + mailboxName + " already exists (Failure)");
        }else{
            mbox.flags = mbox.directories  && mbox.directories.length ? ["\\HasChildren"] : ["\\HasNoChildren"];
            mbox.messages = [];
        }
        this.send(tag, "OK CREATE completed (Success)");
        return callback();
    }

    for(var i=0, len = path.length; i<len; i++){
        name = path.slice(0, i + 1).join(this.server.options.separator);
        mbox = this.directoryCache[this.server.checkMailboxName(name)] || false;
        
        if(!mbox){

            curBranch = {
                path: name,
                flags: i < len - 1 ? ["\\NonExistent", "\\Noselect", "\\HasChildren"] : ["\\HasNoChildren"],
                uidvalitity: 1,
                unsubscribed: true,
                uidnext: this.server.uidnextCache[name] || 1,
                messages: []
            }

            this.server.directoryCache[name] = curBranch;
        }else{
            curBranch = mbox;
            if(i < len - 1){
                if(!curBranch.directories){
                    curBranch.directories = {};
                }
                for(var j = curBranch.flags.length - 1; j >= 0; j--){
                    if(curBranch.flags[j] == "\\HasNoChildren"){
                        curBranch.flags.splice(j, 1);
                        break;
                    }
                }
                if(curBranch.flags.indexOf("\\HasChildren") < 0){
                    curBranch.flags.push("\\HasChildren");
                }
            }else{
                if(curBranch.flags.indexOf("\\HasNoChildren") < 0){
                    curBranch.flags.push("\\HasNoChildren");
                }
            }
        }
    }

    this.send(tag, "OK CREATE completed (Success)");
    callback();
});

IMAPMockServer.addCommandHandler("DELETE", function(tag, data, callback){
    if(["Authenticated", "Selected"].indexOf(this.state) < 0){
        this.send(tag, "BAD Unknown command");
        return callback();
    }

    var mailboxName = (data.shift() || ""),
        mbox = this.directoryCache[this.server.checkMailboxName(mailboxName)] || false,
        name,
        path = this.server.checkMailboxName(mailboxName).split(this.server.options.separator),
        curBranch,
        expunged,
        lastBranch;

    if(!mbox || (mbox.flags.indexOf("\\Noselect") >= 0 && mbox.directories && mbox.directories.length)){
        this.send(tag, "NO Unknown Mailbox: " + mailboxName + " (Failure)");
        return callback();
    }

    if(mbox.messages.length){
        this.server.emit("notice", {
            type: "expunge",
            mailbox: this.selectedMailbox.path,
            messages: mbox.messages.map(function(message, i){
                return i+1;
            })
        });
        mbox.messages = [];
    }

    if(mbox.directories && mbox.directories.length){
        if(mbox.flags.indexOf("\\Noselect") < 0){
            mbox.flags.push("\\Noselect");    
        }
        if(mbox.flags.indexOf("\\NonExistent") < 0){
            mbox.flags.push("\\NonExistent");
        }
    }else{
        
        lastBranch = mbox;
        delete this.directoryCache[lastBranch.path];

        while(path.pop() && path.length){
            name = path.join(this.server.options.separator);
            
            if(!(curBranch = this.directoryCache[this.server.checkMailboxName(name)])){
                continue;
            }
            if(curBranch.directories){
                for(var i = curBranch.directories.length - 1; i>=0; i--){
                    if(curBranch.directories[i] == lastBranch){
                        curBranch.directories.splice(i, 1);
                        break;
                    }
                }

                if(!curBranch.directories.length && curBranch.flags.indexOf("\\NonExistent") >= 0){
                    lastBranch = curBranch;
                    delete this.directoryCache[lastBranch.path];
                }else{
                    break;
                }
            }else if(curBranch.flags.indexOf("\\NonExistent") >= 0){
                lastBranch = curBranch;
                delete this.directoryCache[lastBranch.path];
            }else{
                break;
            }
        }
    }

    this.processNotices();
    this.send(tag, "OK DELETE Completed");
    callback();
});