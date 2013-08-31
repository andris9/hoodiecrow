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

// IMAP STATES: "Not Authenticated", "Authenticated", "Selected", "Logout"

module.exports = function(options){
    return new IMAPMockServer(options);
};

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

IMAPMockServer.prototype.close = function(callback){
    this.server.close(callback);
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
            curBranch.flags = [].concat(curFlags || []);
            
            // ensure message array
            curBranch.messages = [].concat(curBranch.messages || []);

            // ensure highest uidnext
            curBranch.uidnext = Math.max.apply(Math, [curBranch.uidnext || 1].concat(curBranch.messages.map(function(message){
                return (message.uid || 0) + 1;
            })));

            // ensure uid and flags for every message
            curBranch.messages.forEach(function(message){
                message.internaldate = message.internaldate ? 
                    (Object.prototype.toString.call(message.internaldate) == "[object Date]" ? 
                        message.internaldate : new Date(message.internaldate)) : 
                    new Date();
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

IMAPMockServer.prototype.createMailbox = function(mailboxName, oldMbox){
    var mbox = this.directoryCache[this.checkMailboxName(mailboxName)] || false,
        path = this.checkMailboxName(mailboxName).split(this.options.separator),
        name,
        curBranch = this.directories,
        i, j, len;

    oldMbox = oldMbox || {};

    // remove trailing / if needed
    if(path.length && !path[path.length-1]){
        path.pop();
    }

    if(!path){
        throw new Error("BAD Can not create Mailbox: " + mailboxName + " (Failure)");
    }

    if(mbox){
        if(mbox.flags.indexOf("\\NonExistent") < 0){
            throw new Error("NO Mailbox: " + mailboxName + " already exists (Failure)");
        }else{
            Object.keys(oldMbox).forEach(function(key){
                if(key != "path"){
                    mbox[key] = oldMbox[key];
                }
            });

            for(j = mbox.flags.length - 1; j >= 0; j--){
                if(
                  mbox.flags[j] == "\\Noselect" ||
                  mbox.flags[j] == "\\NonExistent" ||
                  (!mbox.directories || !mbox.directories.length && mbox.flags[j] == "\\HasChildren")){
                    curBranch.flags.splice(j, 1);
                    break;
                }
            }
            
            if((!mbox.directories || !mbox.directories.length) && curBranch.flags.indexOf("\\HasNoChildren") < 0){
                curBranch.flags.push("\\HasNoChildren");
            }

            if(mbox.directories && mbox.directories.length && curBranch.flags.indexOf("\\HasChildren") < 0){
                curBranch.flags.push("\\HasChildren");
            }
        }

        return mbox;
    }

    for(i=0, len = path.length; i<len; i++){
        name = path.slice(0, i + 1).join(this.options.separator);
        mbox = this.directoryCache[this.checkMailboxName(name)] || false;
        
        if(!mbox){

            if(i<len - 1){
                curBranch = {
                    path: name,
                    flags: ["\\NonExistent", "\\Noselect", "\\HasChildren"],
                    uidvalitity: 1,
                    unsubscribed: true,
                    uidnext: this.uidnextCache[name] || 1,
                    messages: []
                };
            }else{
                curBranch = {
                    path: name,
                    flags: [].concat(oldMbox.flags || ["\\HasNoChildren"]),
                    uidvalitity: oldMbox.uidvalitity || 1,
                    unsubscribed: true,
                    uidnext: oldMbox.uidvalidity || this.uidnextCache[name] || 1,
                    messages: oldMbox.messages || []
                };
                for(j = curBranch.flags.length - 1; j >= 0; j--){
                    if(curBranch.flags[j] == "\\HasChildren"){
                        curBranch.flags.splice(j, 1);
                        break;
                    }
                }
                if(curBranch.flags.indexOf("\\HasNoChildren") < 0){
                    curBranch.flags.push("\\HasNoChildren");
                }
            }
            
            this.directoryCache[name] = curBranch;
        }else{
            curBranch = mbox;
            if(i < len - 1){
                if(!curBranch.directories){
                    curBranch.directories = {};
                }
                for(j = curBranch.flags.length - 1; j >= 0; j--){
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

    return curBranch;
};

IMAPMockServer.prototype.deleteMailbox = function(mailboxName){
    var mbox = this.directoryCache[this.checkMailboxName(mailboxName)] || false,
        name,
        path = this.checkMailboxName(mailboxName).split(this.options.separator),
        curBranch,
        lastBranch;

    if(!mbox || (mbox.flags.indexOf("\\Noselect") >= 0 && mbox.directories && mbox.directories.length)){
        throw new Error("NO Unknown Mailbox: " + mailboxName + " (Failure)");
    }

    if(mbox.messages.length){
        this.emit("notice", {
            type: "expunge",
            mailbox: this.selectedMailbox.path,
            messages: mbox.messages.map(function(){
                // delete all messages, so the index is always 1 (the first message in the remaining list)
                return 1;
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
            name = path.join(this.options.separator);
            
            if(!(curBranch = this.directoryCache[this.checkMailboxName(name)])){
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
};

IMAPMockServer.prototype.updateFlags = function(message, modifier, flags){
    flags = [].concat(flags || []);

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

};

IMAPMockServer.prototype.addMessage = function(mailboxName, message, client){
    
    message = message || {};

    var mbox = this.directoryCache[this.checkMailboxName(mailboxName)] || false;
    if(!mbox || mbox.flags.indexOf("\\Noselect") >= 0){
        return false;
    }

    message.uid = message.uid || mbox.uidnext;
    mbox.uidnext = Math.max(message.uid + 1, mbox.uidnext + 1);

    message.internaldate = message.internaldate ? 
        (Object.prototype.toString.call(message.internaldate) == "[object Date]" ? 
            message.internaldate : new Date(message.internaldate)) : 
        new Date();
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
    this.options = this.server.options;

    this.state = "Not Authenticated";

    this.lineparser = new IMAPLineParser();

    this.directoryCache = this.server.directoryCache;

    this.secureConnection = !!this.options.secureConnection;
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
        console.log(err);
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

    if(this.options.preauth){
        this.state = "Authenticated";
        this.send("*", "PREAUTH IMAP4rev1 server logged in as " + this.options.preauth);
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
                to = Number(to=="*" && total || to) || from;
                
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
};

IMAPMockConnection.prototype.onNotice = function(data){
    if(data.client == this || !this.selectedMailbox || data.mailbox != this.selectedMailbox.path){
        return; // skip own notices
    }
    if(this.idling){
        this.showNotice(data);
    }else{
        this.notices.push(data);
    }
};

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
};

IMAPMockConnection.prototype.processNotices = function(){
    var notice;

    if(!this.selectedMailbox){
        return false;
    }

    while((notice = this.notices.shift())){
        this.showNotice(notice);
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

        console.log("PARSED: " + JSON.stringify(data));

        this.processCommand(data, processor);
    }).bind(this);

    processor();
};

IMAPMockConnection.prototype.send = function(tag, data){
    if(!this.socket || this.socket.destroyed){
        return;
    }
    console.log("SEND: %s", tag + " " + data);
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
        IMAPMockServer.commandHandlers[command](this, tag, data, callback);
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

IMAPMockConnection.prototype.buildSearchResponse = function(params, nrCache){
    var totalResults = [],

        query,
        charset,

        composeQuery = function(params){
            params = [].concat(params || []);
            
            var queryParams = {
                    "BCC": ["VALUE"],       "BEFORE": ["VALUE"],            "BODY": ["VALUE"],
                    "CC": ["VALUE"],        "FROM": ["VALUE"],              "HEADER": ["VALUE", "VALUE"],
                    "KEYWORD": ["VALUE"],   "LARGER": ["VALUE"],            "NOT": ["COMMAND"],
                    "ON": ["VALUE"],        "OR": ["COMMAND", "COMMAND"],   "SENTBEFORE": ["VALUE"],
                    "SENTON": ["VALUE"],    "SENTSINCE": ["VALUE"],         "SINCE": ["VALUE"],
                    "SMALLER": ["VALUE"],   "SUBJECT": ["VALUE"],           "TEXT": ["VALUE"],
                    "TO": ["VALUE"],        "UID": ["VALUE"],               "UNKEYWORD": ["VALUE"]
                },
                pos = 0,
                param,
                returnParams = [];

            var getParam = function(level){
                level = level || 0;
                if(pos >= params.length){
                    return undefined;
                }

                var param = params[pos++],
                    paramTypes = queryParams[param.toUpperCase()] || [],
                    paramCount = paramTypes.length,
                    curParams = [param.toUpperCase()];

                if(paramCount){
                    for(var i=0, len = paramCount; i<len; i++){
                        switch(paramTypes[i]){
                            case "VALUE":
                                curParams.push(params[pos++]);
                                break;
                            case "COMMAND":
                                curParams.push(getParam(level+1));
                                break;
                        }
                    }
                }
                return curParams;
            };

            while(typeof (param = getParam()) != "undefined"){
                returnParams.push(param);
            }

            return returnParams;
        },

        searchFlags = (function(flag, flagExists){
            var results = [];
            this.selectedMailbox.messages.forEach(function(message, i){
                if(
                  (flagExists && message.flags.indexOf(flag) >=0) || 
                  (!flagExists && message.flags.indexOf(flag) < 0)){
                    nrCache[message.uid] = i + 1;
                    results.push(message);
                }
            });
            return results;
        }).bind(this),

        searchHeaders = (function(key, value, includeEmpty){
            var results = [];
            key = (key || "").toString().toLowerCase();
            value = (value || "").toString();
            if(!value && !includeEmpty){
                return [];
            }
            this.selectedMailbox.messages.forEach(function(message, i){
                if(!message.structured){
                    message.structured = mimeParser(message.body || "");
                }
                var headers = (message.structured.header || []),
                    parts,
                    lineKey, lineValue;

                for(var j=0, len = headers.length; j<len; j++){
                    parts = headers[j].split(":");
                    lineKey = (parts.shift() || "").trim().toLowerCase();
                    lineValue = (parts.join(":") || "");
                    if(lineKey == key && (!value || lineValue.toLowerCase().indexOf(value.toLowerCase())>=0)){
                        nrCache[message.uid] = i + 1;
                        results.push(message);
                        return;
                    }
                }
            });
            return results;
        }).bind(this),
        
        queryHandlers = {
            "_SEQ": function(sequence){ 
                return this.getMessageRange(sequence).map(function(item){
                    nrCache[item[1].uid] = item[0];
                    return item[1];
                });
            },
            "ALL": function(){
                return this.selectedMailbox.messages.map(function(message, i){
                    nrCache[message.uid] = i + 1;
                    return message;
                });
            },
            "ANSWERED": function(){
                return searchFlags("\\Answered", true);
            },
            "BCC": function(value){
                return searchHeaders("BCC", value);
            },
            "BEFORE": function(date){
                var results = [];
                this.selectedMailbox.messages.forEach(function(message, i){
                    if(message.internaldate.toISOString().substr(0, 10) < new Date(date).toISOString().substr(0, 10)){
                        nrCache[message.uid] = i + 1;
                        results.push(message);
                    }
                });
                return results;
            },
            "BODY": function(value){
                var results = [];
                value = (value || "").toString();
                if(!value){
                    return [];
                }

                this.selectedMailbox.messages.forEach(function(message, i){
                    if(!message.structured){
                        message.structured = mimeParser(message.body || "");
                    }
                    if((message.structured.text || "").toLowerCase().indexOf(value.toLowerCase()) >= 0){
                        nrCache[message.uid] = i + 1;
                        results.push(message);
                    }
                });
                return results;
            },
            "CC": function(value){
                return searchHeaders("CC", value);
            },
            "DELETED": function(){
                return searchFlags("\\Deleted", true);
            },
            "DRAFT": function(){
                return searchFlags("\\Draft", true);
            },
            "FLAGGED": function(){
                return searchFlags("\\Flagged", true);
            },
            "FROM": function(value){
                return searchHeaders("FROM", value);
            },
            "HEADER": function(key, value){
                return searchHeaders(key, value, true);
            },
            "KEYWORD": function(flag){
                return searchFlags(flag, true);
            },
            "LARGER": function(size){
                var results = [];
                this.selectedMailbox.messages.forEach(function(message, i){
                    if((message.body || "").length >= size){
                        nrCache[message.uid] = i + 1;
                        results.push(message);
                    }
                });
                return results;
            },
            "NEW": function(){
                var results = [];
                this.selectedMailbox.messages.forEach(function(message, i){
                    if(message.flags.indexOf("\\Recent") >= 0 && message.flags.indexOf("\\Seen") < 0){
                        nrCache[message.uid] = i + 1;
                        results.push(message);
                    }
                });
                return results;
            },
            "NOT": function(q){
                if(!queryHandlers[q[0]] && q[0].match(/^[\d\,\:\*]+$/)){
                    q.unshift("_SEQ");
                }else if(!queryHandlers[q[0]]){
                    throw new Error("NO Invalid query element: " + q[0] + " (Failure)");
                }

                var notResults = queryHandlers[q.shift()].apply(this, q),
                    results = [];

                this.selectedMailbox.messages.forEach(function(message){
                    if(notResults.indexOf(message) < 0){
                        results.push(message);
                    }
                });
                return results;
            },
            "OLD": function(){
                return searchFlags("\\Recent", false);
            },
            "ON": function(date){
                var results = [];
                this.selectedMailbox.messages.forEach(function(message, i){
                    if(message.internaldate.toISOString().substr(0, 10) == new Date(date).toISOString().substr(0, 10)){
                        nrCache[message.uid] = i + 1;
                        results.push(message);
                    }
                });
                return results;
            },
            "OR": function(left, right){
                var jointResult = [],
                    leftResults, rightResults;

                if(!queryHandlers[left[0]] && left[0].match(/^[\d\,\:\*]+$/)){
                    left.unshift("_SEQ");
                }else if(!queryHandlers[left[0]]){
                    throw new Error("NO Invalid query element: " + left[0] + " (Failure)");
                }

                if(!queryHandlers[right[0]] && right[0].match(/^[\d\,\:\*]+$/)){
                    right.unshift("_SEQ");
                }else if(!queryHandlers[right[0]]){
                    throw new Error("NO Invalid query element: " + right[0] + " (Failure)");
                }

                leftResults = queryHandlers[left.shift()].apply(this, left);
                rightResults = queryHandlers[right.shift()].apply(this, right);

                jointResult = jointResult.concat(leftResults);
                rightResults.forEach(function(message){
                    if(jointResult.indexOf(message) < 0){
                        jointResult.push(message);
                    }
                });

                return jointResult;
            },
            "RECENT": function(){
                return searchFlags("\\Recent", true);
            },
            "SEEN": function(){
                return searchFlags("\\Seen", true);
            },
            "SENTBEFORE": function(date){
                var results = [];
                this.selectedMailbox.messages.forEach(function(message, i){
                    if(!message.structured){
                        message.structured = mimeParser(message.body || "");
                    }
                    var messageDate = message.structured.parsedHeader.date || message.internaldate;
                    if(Object.prototype.toString.call(messageDate) != "[object Date]"){
                        messageDate = new Date(messageDate);
                    }
                    if(messageDate.toISOString().substr(0, 10) < new Date(date).toISOString().substr(0, 10)){
                        nrCache[message.uid] = i + 1;
                        results.push(message);
                    }
                });
                return results;
            },
            "SENTON": function(date){
                var results = [];
                this.selectedMailbox.messages.forEach(function(message, i){
                    if(!message.structured){
                        message.structured = mimeParser(message.body || "");
                    }
                    var messageDate = message.structured.parsedHeader.date || message.internaldate;
                    if(Object.prototype.toString.call(messageDate) != "[object Date]"){
                        messageDate = new Date(messageDate);
                    }
                    if(messageDate.toISOString().substr(0, 10) == new Date(date).toISOString().substr(0, 10)){
                        nrCache[message.uid] = i + 1;
                        results.push(message);
                    }
                });
                return results;
            },
            "SENTSINCE": function(date){
                var results = [];
                this.selectedMailbox.messages.forEach(function(message, i){
                    if(!message.structured){
                        message.structured = mimeParser(message.body || "");
                    }
                    var messageDate = message.structured.parsedHeader.date || message.internaldate;
                    if(Object.prototype.toString.call(messageDate) != "[object Date]"){
                        messageDate = new Date(messageDate);
                    }
                    if(messageDate.toISOString().substr(0, 10) >= new Date(date).toISOString().substr(0, 10)){
                        nrCache[message.uid] = i + 1;
                        results.push(message);
                    }
                });
                return results;
            },
            "SINCE": function(date){
                var results = [];
                this.selectedMailbox.messages.forEach(function(message, i){
                    if(message.internaldate.toISOString().substr(0, 10) >= new Date(date).toISOString().substr(0, 10)){
                        nrCache[message.uid] = i + 1;
                        results.push(message);
                    }
                });
                return results;
            },
            "SMALLER": function(size){
                var results = [];
                this.selectedMailbox.messages.forEach(function(message, i){
                    if((message.body || "").length < size){
                        nrCache[message.uid] = i + 1;
                        results.push(message);
                    }
                });
                return results;
            },
            "SUBJECT": function(value){
                return searchHeaders("SUBJECT", value);
            },
            "TEXT": function(value){
                var results = [];
                value = (value || "").toString();
                if(!value){
                    return [];
                }

                this.selectedMailbox.messages.forEach(function(message, i){
                    if((message.body || "").toString().toLowerCase().indexOf(value.toLowerCase()) >= 0){
                        nrCache[message.uid] = i + 1;
                        results.push(message);
                    }
                });
                return results;
            },
            "TO": function(value){
                return searchHeaders("TO", value);
            },
            "UID": function(sequence){
                return this.getMessageRange(sequence, true).map(function(item){
                    nrCache[item[1].uid] = item[0];
                    return item[1];
                });
            },
            "UNANSWERED": function(){
                return searchFlags("\\Answered", false);
            },
            "UNDELETED": function(){
                return searchFlags("\\Deleted", false);
            },
            "UNDRAFT": function(){
                return searchFlags("\\Draft", false);
            },
            "UNFLAGGED": function(){
                return searchFlags("\\Flagged", false);
            },
            "UNKEYWORD": function(flag){
                return searchFlags(flag, false);
            },
            "UNSEEN": function(){
                return searchFlags("\\Seen", false);
            }
        };

    // FIXME: charset is currently ignored
    if((params[0] || "").toString().toUpperCase() == "CHARSET"){
        params.shift(); // CHARSET
        charset = params.shift(); // value
    }

    query = composeQuery(params);
    query.forEach((function(q, i){

        if(!queryHandlers[q[0]] && q[0].match(/^[\d\,\:\*]+$/)){
            q.unshift("_SEQ");
        }else if(!queryHandlers[q[0]]){
            throw new Error("NO Invalid query element: " + q[0] + " (Failure)");
        }

        var handler = queryHandlers[q.shift()],
            currentResult = handler && handler.apply(this, q) || [];

        if(!i){
            totalResults = [].concat(currentResult || []);
        }else{
            for(var j = totalResults.length - 1; j>=0; j--){
                if(currentResult.indexOf(totalResults[j]) < 0){
                    totalResults.splice(j, 1);
                }
            }
        }
    }).bind(this));

    return totalResults;
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
        if(list.map(function(param){
            return (param || "").toString().toUpperCase().trim();
        }).indexOf("UID") < 0){
            list.push("UID");
        }
    }
    
    list.forEach((function(param){
        var paramName = (param && param.value || param).toString().toUpperCase();
        // if RFC822 or BODY[.] is requested, mark the message as read
        if(!this.mailboxReadOnly && (paramName == "RFC822" || paramName == "RFC822.TEXT" || param.value == "BODY")){
            if(message.flags.indexOf("\\Seen") < 0){
                message.flags = message.flags.concat("\\Seen");
                if(list.map(function(param){
                    return (param || "").toString().toUpperCase().trim();
                }).indexOf("FLAGS") < 0){
                    list.push("FLAGS");
                }
            }
        }
    }).bind(this));

    list.forEach((function(param){
        var paramName = (param && param.value || param).toString().toUpperCase();

        switch(paramName){
            case "UID":
            case "FLAGS":
                response[paramName] = message[param.toLowerCase()] || null;
                if(response[paramName]){
                    response[paramName]._FLAGS = true;
                }
                break;
            case "INTERNALDATE":
                // hacky way to get properly formatted internal date strings
                var internaldate = message.internaldate.toISOString().replace(/[^0-9:\-]/g, " ").substr(0, 19)+" +0000";
                internaldate = internaldate.replace(/^(\d{4})\-(\d{2})\-(\d{2})(?= )/, function(o, y, m, d){
                    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                    return d + "-" + months[Number(m)-1] + "-" + y;
                });
                response[paramName] = internaldate;
                break;
            case "RFC822.SIZE":
                response[paramName] = (message.body || "").length;
                break;
            case "RFC822.TEXT":
                response[paramName] = {_LITERAL: message.structured.text || ""};
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
                        throw new Error("BAD Fetch (Failure)");
                    }
                    response.BODY = bodystructure(message.structured, {body: true, upperCaseKeys: true});
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
                        var path = (param.params[0] || "").toUpperCase(),
                            match = path.match(/^(?:([\d\.]*)\.)?(.*)?$/),
                            pathName = (match && match[2] || ""),
                            pathNumbers = (match && match[1] || "").split("."),
                            pathNumber,
                            context = message.structured,
                            bodystruct = bodystructure(message.structured, {upperCaseKeys: true, skipContentLocation: true});

                        // Not exactly correct implementation, but more or less works.
                        // Allows queries like BODY[1.2.3.HEADER.FIELDS (From To)]
                        while((pathNumber = pathNumbers.shift())){
                            pathNumber = Number(pathNumber);

                            // RFC bodystructure begins with "MESSAGE" string, the bodystructure
                            // for embedded message is in the element with index 8
                            if((bodystruct[0] || "").toString().toUpperCase() == "MESSAGE"){
                                bodystruct = bodystruct[8];
                            }

                            // if this is a multipart list, use the selected one,
                            // otherwise it is a single element, do not go any deeper
                            if(bodystruct && Array.isArray(bodystruct[0])){
                                bodystruct = bodystruct[pathNumber - 1];    
                            }

                            context = bodystruct.node;
                        }

                        switch(pathName){
                            case "MIME":
                                response["BODY[" + path + "]"] = {_LITERAL: (context.header || []).join("\r\n") + "\r\n\r\n"};
                                break;
                            case "TEXT":
                                response["BODY[" + path + "]"] = {_LITERAL: context.text || ""};
                                break;
                            case "HEADER":
                                response["BODY[" + path + "]"] = {_LITERAL: (context.header || []).join("\r\n") + "\r\n\r\n"};
                                break;
                            case "HEADER.FIELDS":
                                param.responseName = "BODY[" + path + " ("+[].concat(param.params[1] || []).join(" ")+")]";
                                value = [];
                                (context.header || []).forEach(function(line){
                                    var key = (line.split(":").shift() || "").trim().toLowerCase();
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
                                param.responseName = "BODY[" + path + " ("+[].concat(param.params[1] || []).join(" ")+")]";
                                value = [];
                                (context.header || []).forEach(function(line){
                                    var key = (line.split(":").shift() || "").trim().toLowerCase();
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
    var lookup = (reference ? reference + this.options.separator : "") + match,
        result = [];

    var query = new RegExp("^" + lookup.
                // escape regex symbols
                replace(/([\\^$+?!.():=\[\]|,\-])/g, "\\$1").
                replace(/[*]/g, ".*").
                replace(/[%]/g, "[^" + (this.options.separator.replace(/([\\^$+*?!.():=\[\]|,\-])/g, "\\$1"))+ "]*") +
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

IMAPMockServer.addCommandHandler("CAPABILITY", function(connection, tag, data, callback){
    connection.send("*", connection.buildCapabilityList());
    connection.processNotices();
    connection.send(tag, "OK CAPABILITY completed");
    return callback();
});

IMAPMockServer.addCommandHandler("FETCH", function(connection, tag, data, callback){
    if(connection.state != "Selected"){
        connection.send(tag, "BAD Unknown command");
        return callback();
    }

    var range = data.shift(),
        params = data.shift() || [];

    connection.getMessageRange(range).forEach(function(item){
        connection.send("*", item[0] + " FETCH " + connection.buildMessageResponse(item[1], params));
    });

    connection.send(tag, "OK Success");

    callback();
});

IMAPMockServer.addCommandHandler("STORE", function(connection, tag, data, callback){
    if(connection.state != "Selected" || connection.mailboxReadOnly){
        connection.send(tag, "BAD Unknown command");
        return callback();
    }

    if(connection.mailboxReadOnly){
        connection.send(tag, "NO Read only mailbox");
        return callback();
    }

    connection.getMessageRange(data.shift()).forEach(function(item){
        connection.server.updateFlags(item[1], data[0], data[1]);
        if((data[0] ||"").match(/^[\-+]?FLAGS$/i)){
            connection.send("*", item[0] + " FETCH (FLAGS ("+ item[1].flags.join(" ") +"))");
        }
    });

    connection.send(tag, "OK STORE completed");

    callback();
});

IMAPMockServer.addCommandHandler("SELECT", function(connection, tag, data, callback){
    if(["Authenticated", "Selected"].indexOf(connection.state) < 0){
        connection.send(tag, "BAD Unknown command");
        return callback();
    }

    var mailboxName = (data.shift() || ""),
        mbox = connection.directoryCache[connection.server.checkMailboxName(mailboxName)] || false;
    
    if(!mbox || mbox.flags.indexOf("\\Noselect") >= 0){
        connection.send(tag, "NO [NONEXISTENT] Unknown Mailbox: " + mailboxName + " (Failure)");
        return callback();
    }

    connection.selectedMailbox = mbox;
    connection.mailboxReadOnly = false;
    connection.state = "Selected";
    connection.notices = [];

    var flags = [].concat(connection.options.permanentFlags || []);
    mbox.messages.forEach(function(message){
        message.flags.forEach(function(flag){
            if(flags.indexOf(flag) < 0){
                flags.push(flag);
            }
        });
    });

    connection.send("*", "FLAGS (" + flags.join(" ") + ")");
    connection.send("*", "OK [PERMANENTFLAGS (" + flags.join(" ") + " \\*)] Flags permitted.");
    connection.send("*", "OK [UIDVALIDITY " + mbox.uidvalitity + "] UIDs valid.");
    connection.send("*", mbox.messages.length+" EXISTS");
    connection.send("*", "0 RECENT");
    connection.send("*", "OK [UIDNEXT " + mbox.uidnext + "] Predicted next UID.");

    connection.send(tag, "OK [READ-WRITE] " + mailboxName + " selected. (Success)");
    
    callback();
});

IMAPMockServer.addCommandHandler("EXAMINE", function(connection, tag, data, callback){
    if(["Authenticated", "Selected"].indexOf(connection.state) < 0){
        connection.send(tag, "BAD Unknown command");
        return callback();
    }

    var mailboxName = (data.shift() || ""),
        mbox = connection.directoryCache[connection.server.checkMailboxName(mailboxName)] || false;
    
    if(!mbox || mbox.flags.indexOf("\\Noselect") >= 0){
        connection.send(tag, "NO [NONEXISTENT] Unknown Mailbox: " + mailboxName + " (Failure)");
        return callback();
    }

    connection.selectedMailbox = mbox;
    connection.mailboxReadOnly = true;
    connection.state = "Selected";
    connection.notices = [];

    var flags = [].concat(connection.options.permanentFlags || []);
    mbox.messages.forEach(function(message){
        message.flags.forEach(function(flag){
            if(flags.indexOf(flag) < 0){
                flags.push(flag);
            }
        });
    });

    connection.send("*", "FLAGS (" + flags.join(" ") + ")");
    connection.send("*", " OK [PERMANENTFLAGS (" + flags.join(" ") + " \\*)]  Flags permitted.");
    connection.send("*", "OK [UIDVALIDITY " + mbox.uidvalitity + "] UIDs valid.");
    connection.send("*", mbox.messages.length+" EXISTS");
    connection.send("*", "0 RECENT");
    connection.send("*", "OK [UIDNEXT " + mbox.uidnext + "] Predicted next UID.");

    connection.send(tag, "OK [READ-ONLY] EXAMINE completed. (Success)");
    
    callback();
});

IMAPMockServer.addCommandHandler("CLOSE", function(connection, tag, data, callback){
    if(connection.state != "Selected"){
        connection.send(tag, "BAD Unknown command");
        return callback();
    }

    var expunged = [],
        messages = connection.selectedMailbox.messages;
    
    for(var i = 0; i < messages.length; i++){
        if(messages[i].flags.indexOf("\\Deleted") >= 0){
            expunged.push(i + 1);
            messages.splice(i, 1);
            i--;
        }
    }

    connection.server.emit("notice", {
        type: "expunge",
        mailbox: connection.selectedMailbox.path,
        messages: expunged,
        client: connection
    });
    
    connection.state = "Authenticated";
    connection.selectedMailbox = false;
    connection.notices = [];

    connection.send(tag, "OK Returned to authenticated state");
    callback();
});

IMAPMockServer.addCommandHandler("STATUS", function(connection, tag, data, callback){
    if(["Authenticated", "Selected"].indexOf(connection.state) < 0){
        connection.send(tag, "BAD Unknown command");
        return callback();
    }

    var mailboxName = (data.shift() || ""),
        mbox = connection.directoryCache[connection.server.checkMailboxName(mailboxName)] || false,
        request = [].concat(data.shift() || []),
        flags = {},
        unseen = 0,
        response = [];
    
    if(!mbox || mbox.flags.indexOf("\\Noselect") >= 0){
        connection.send(tag, "NO [NONEXISTENT] Unknown Mailbox: " + mailboxName + " (Failure)");
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

    request.forEach(function(req){
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
    });

    connection.send("*", "STATUS (" + response.join(" ") + ")");
    connection.send(tag, "OK STATUS completed. (Success)");

    callback();
});

IMAPMockServer.addCommandHandler("LSUB", function(connection, tag, data, callback){
    if(["Authenticated", "Selected"].indexOf(connection.state) < 0){
        connection.send(tag, "BAD Unknown command");
        return callback();
    }

    var reference = data[0] || "",
        mailboxName = data[1] || "",
        result = connection.matchDirectories(reference, mailboxName);

    result.forEach(function(mbox){
        if(!mbox.unsubscribed){
            connection.send("*", 'LSUB ('+ mbox.flags.join(" ") +') "' + 
                (connection.options.separator || "/") + 
                '" ' + 
                connection.escapeString(mbox.path));    
        }
    });

    connection.processNotices();
    connection.send(tag, "OK Success");

    callback();
});

IMAPMockServer.addCommandHandler("LIST", function(connection, tag, data, callback){
    if(["Authenticated", "Selected"].indexOf(connection.state) < 0){
        connection.send(tag, "BAD Unknown command");
        return callback();
    }

    var reference = data[0] || "",
        mailboxName = data[1] || "",
        result = connection.matchDirectories(reference, mailboxName);

    result.forEach(function(mbox){
        connection.send("*", 'LIST ('+ mbox.flags.join(" ") +') "' + 
            (connection.options.separator || "/") + 
            '" ' + 
            connection.escapeString(mbox.path));
    });

    connection.processNotices();
    connection.send(tag, "OK Success");

    callback();
});

IMAPMockServer.addCommandHandler("ID", function(connection, tag, data, callback){
    if(!connection.checkSupport("ID")){
        connection.send(tag, "BAD Unknown command: ID");
        return callback();
    }

    connection.send("*", connection.buildIDString());
    connection.processNotices();
    connection.send(tag, "OK Success");

    callback();
});

IMAPMockServer.addCommandHandler("NOOP", function(connection, tag, data, callback){
    connection.processNotices();
    connection.send(tag, "OK NOOP completed");
    callback();
});

IMAPMockServer.addCommandHandler("CHECK", function(connection, tag, data, callback){
    connection.processNotices();
    connection.send(tag, "OK CHECK completed");
    callback();
});

IMAPMockServer.addCommandHandler("STARTTLS", function(connection, tag, data, callback){
    if(!connection.checkSupport("STARTTLS")){
        connection.send(tag, "BAD Unknown command: STARTTLS");
        return callback();
    }

    if(connection.secureConnection){
        connection.send(tag, "BAD Connection already secure");
        return callback();
    }

    var credentials = connection.options.credentials || connection.server.defaultCredentials;

    connection._ignoreData = true;
    connection.send(tag, "OK Server ready to start TLS negotiation");
    var secureConnector = starttls(connection.socket, credentials, function(socket){
        connection._ignoreData = false;
        connection._remainder = "";
        
        connection.socket = socket;
        connection.socket.on("data", connection.onData.bind(connection));

        connection.secureConnection = true;

        if(!socket.authorized){
            console.log("WARNING: TLS ERROR ("+socket.authorizationError+")");
        }

        connection.processNotices();
        callback();
    });

    secureConnector.on("error", function(err){
        console.log(err);
        try{
            connection.socket.close();
        }catch(E){}
        try{
            secureConnector.close();
        }catch(E){}
    });
});

IMAPMockServer.addCommandHandler("LOGOUT", function(connection, tag){
    connection.state = "Logout";
    connection.notices = [];
    if(connection.socket && !connection.socket.destroyed){
        connection.send("*", "BYE IMAP4rev1 Server logging out");
        connection.send(tag, "OK LOGOUT completed");
        connection.socket.end();
    }
});

IMAPMockServer.addCommandHandler("IDLE", function(connection, tag, data, callback){
    if(!connection.checkSupport("IDLE")){
        connection.send(tag, "BAD Unknown command: IDLE");
        return callback();
    }
    connection.idling = tag;
    connection.send("+", "idling");
    connection.processNotices();
    callback();
});

IMAPMockServer.addCommandHandler("LOGIN", function(connection, tag, data, callback){
    if(connection.checkSupport("LOGINDISABLED")){
        connection.send(tag, "NO Upgrade to secure connection first");
        return callback();
    }

    if(connection.state != "Not Authenticated"){
        connection.send(tag, "BAD Already logged in");
        return callback();
    }

    var user = data.shift() || "",
        pass = data.shift() || "";

    if(!(user in connection.server.users) || connection.server.users[user] != pass){
        connection.send(tag, "NO Invalid credentials");
    }else{
        connection.state = "Authenticated";
        connection.send("*", connection.buildCapabilityList());
        connection.send(tag, "OK " + user + " authenticated (Success)");
    }

    callback();
});

IMAPMockServer.addCommandHandler("EXPUNGE", function(connection, tag, data, callback){
    if(connection.state != "Selected" || connection.mailboxReadOnly){
        connection.send(tag, "BAD Unknown command");
        return callback();
    }

    if(connection.mailboxReadOnly){
        connection.send(tag, "NO Read only mailbox");
        return callback();
    }

    var expunged = [],
        messages = connection.selectedMailbox.messages;
    
    for(var i = 0; i < messages.length; i++){
        if(messages[i].flags.indexOf("\\Deleted") >= 0){
            expunged.push(i + 1);
            messages.splice(i, 1);
            i--;
        }
    }

    connection.server.emit("notice", {
        type: "expunge",
        mailbox: connection.selectedMailbox.path,
        messages: expunged
    });
    
    connection.processNotices();
    connection.send(tag, "OK Expunge completed (Success)");

    callback();
});

IMAPMockServer.addCommandHandler("APPEND", function(connection, tag, data, callback){
    if(["Authenticated", "Selected"].indexOf(connection.state) < 0){
        connection.send(tag, "BAD Unknown command");
        return callback();
    }

    var mailboxName = (data.shift() || ""),
        mbox = connection.directoryCache[connection.server.checkMailboxName(mailboxName)] || false,
        body = new Buffer(data.pop() || "", "binary"),
        flags = Array.isArray(data[0]) && data.shift() || [],
        date = data.shift() || new Date(),
        message = {
            flags: flags,
            internaldate: date,
            body: body
        };

    if(!mbox || mbox.flags.indexOf("\\NonExistent") >= 0){
        connection.send(tag, "NO [TRYCREATE] Unknown Mailbox: " + mailboxName + " (Failure)");
        return callback();
    }

    connection.server.addMessage(mailboxName, message, connection);

    if(connection.selectedMailbox && mailboxName == connection.selectedMailbox.path){
        connection.send("*", connection.selectedMailbox.messages.length +" EXISTS");
    }

    connection.send(tag, "OK APPEND completed (Success)");
    callback();
});

IMAPMockServer.addCommandHandler("UID", function(connection, tag, data, callback){
    if(connection.state != "Selected"){
        connection.send(tag, "BAD Unknown command");
        return callback();
    }

    var command = ((data || []).shift() || "").toString().toUpperCase(),
        range, params, mbox, mailboxName, results;

    switch(command){
        case "FETCH":
            range = data.shift();
            params = data.shift() || [];
            mbox = connection.selectedMailbox;

            connection.getMessageRange(range, true).forEach(function(item){
                connection.send("*", item[0] + " FETCH " + connection.buildMessageResponse(item[1], params, true));
            });

            connection.processNotices();
            connection.send(tag, "OK UID FETCH completed");
            break;
        
        case "STORE":
            range = data.shift();
            mbox = connection.selectedMailbox;

            connection.getMessageRange(range, true).forEach(function(item){
                connection.server.updateFlags(item[1], data[0], data[1]);
                if((data[0] ||"").match(/^[\-+]?FLAGS$/i)){
                    connection.send("*", item[0] + " FETCH " + connection.buildMessageResponse(item[1], ["FLAGS"], true));
                }
            });

            connection.processNotices();
            connection.send(tag, "OK UID STORE completed");
            break;
        case "COPY":
            range = data.shift();
            mailboxName = (data.shift() || "");
            mbox = connection.directoryCache[connection.server.checkMailboxName(mailboxName)] || false;
            params = data.shift() || [];

            if(!mbox || mbox.flags.indexOf("\\NonExistent") >= 0){
                connection.send(tag, "NO [TRYCREATE] Unknown Mailbox: " + mailboxName + " (Failure)");
                return callback();
            }

            if(connection.selectedMailbox && mbox == connection.selectedMailbox){
                connection.send(tag, "NO Select different destination");
                return callback();
            }

            connection.getMessageRange(range, true).forEach(function(item){
                var message = {
                    flags: [].concat(item[1].flags || []), // make a copy, these values might get modified later
                    internaldate: item[1].date,
                    body: item[1].body,
                };

                // TODO: add \Recent flag to copied messages
                connection.server.addMessage(mailboxName, message, connection);
            });

            connection.processNotices();
            connection.send(tag, "OK UID STORE completed");
            break;
        case "SEARCH":
            params = [].concat(data || []);
            results = connection.buildSearchResponse(params, {});

            if(results.length){
                results.sort(function(a, b){
                    return a.uid - b.uid;
                });

                connection.send("*", "SEARCH " + (results.map(function(message){
                    return message.uid;
                })).join(" "));
            }

            connection.processNotices();
            connection.send(tag, "OK UID SEARCH completed");
            break;
        default:
            connection.processNotices();
            connection.send(tag, "BAD Unknown command");
    }

    callback();
});

IMAPMockServer.addCommandHandler("SUBSCRIBE", function(connection, tag, data, callback){
    if(["Authenticated", "Selected"].indexOf(connection.state) < 0){
        connection.send(tag, "BAD Unknown command");
        return callback();
    }

    var mailboxName = (data.shift() || ""),
        mbox = connection.directoryCache[connection.server.checkMailboxName(mailboxName)] || false;
    
    if(!mbox || mbox.flags.indexOf("\\NonExistent") >= 0){
        connection.send(tag, "NO [NONEXISTENT] Unknown Mailbox: " + mailboxName + " (Failure)");
        return callback();
    }

    mbox.unsubscribed = false;
    
    connection.send(tag, "OK SUBSCRIBE completed");
    callback();
});

IMAPMockServer.addCommandHandler("UNSUBSCRIBE", function(connection, tag, data, callback){
    if(["Authenticated", "Selected"].indexOf(connection.state) < 0){
        connection.send(tag, "BAD Unknown command");
        return callback();
    }

    var mailboxName = (data.shift() || ""),
        mbox = connection.directoryCache[connection.server.checkMailboxName(mailboxName)] || false;
    
    if(!mbox){
        connection.send(tag, "NO [NONEXISTENT] Unknown Mailbox: " + mailboxName + " (Failure)");
        return callback();
    }

    mbox.unsubscribed = true;
    
    connection.send(tag, "OK UNSUBSCRIBE completed");
    callback();
});

IMAPMockServer.addCommandHandler("COPY", function(connection, tag, data, callback){
    if(["Authenticated", "Selected"].indexOf(connection.state) < 0){
        connection.send(tag, "BAD Unknown command");
        return callback();
    }

    var range = data.shift(),
        mailboxName = (data.shift() || ""),
        mbox = connection.directoryCache[connection.server.checkMailboxName(mailboxName)] || false;

    if(!mbox || mbox.flags.indexOf("\\NonExistent") >= 0){
        connection.send(tag, "NO [TRYCREATE] Unknown Mailbox: " + mailboxName + " (Failure)");
        return callback();
    }

    if(connection.selectedMailbox && mbox == connection.selectedMailbox){
        connection.send(tag, "NO Select different destination");
        return callback();
    }

    connection.getMessageRange(range).forEach(function(item){
        var message = {
            flags: [].concat(item[1].flags || []), // make a copy, these values might get modified later
            internaldate: item[1].date,
            body: item[1].body,
        };

        // TODO: add \Recent flag to copied messages
        connection.server.addMessage(mailboxName, message, connection);
    });

    connection.send(tag, "OK COPY completed (Success)");
    callback();
});

IMAPMockServer.addCommandHandler("CREATE", function(connection, tag, data, callback){
    if(["Authenticated", "Selected"].indexOf(connection.state) < 0){
        connection.send(tag, "BAD Unknown command");
        return callback();
    }

    try{
        connection.server.createMailbox(data.shift() || "");
    }catch(E){
        connection.send(tag, E.message);
        return callback();
    }

    connection.processNotices();
    connection.send(tag, "OK CREATE completed (Success)");
    callback();
});

IMAPMockServer.addCommandHandler("DELETE", function(connection, tag, data, callback){
    if(["Authenticated", "Selected"].indexOf(connection.state) < 0){
        connection.send(tag, "BAD Unknown command");
        return callback();
    }

    try{
        connection.server.deleteMailbox(data.shift() || "");
    }catch(E){
        connection.send(tag, E.message);
        return callback();
    }

    connection.processNotices();
    connection.send(tag, "OK DELETE Completed");
    callback();
});

IMAPMockServer.addCommandHandler("RENAME", function(connection, tag, data, callback){
    if(["Authenticated", "Selected"].indexOf(connection.state) < 0){
        connection.send(tag, "BAD Unknown command");
        return callback();
    }

    var oldMailboxName = (data.shift() || ""),
        newMailboxName = (data.shift() || ""),
        oldMbox = connection.directoryCache[connection.server.checkMailboxName(oldMailboxName)] || false,
        newMbox = connection.directoryCache[connection.server.checkMailboxName(newMailboxName)] || false;

    if(!oldMbox || oldMbox.flags.indexOf("\\NonExistent") >= 0){
        connection.send(tag, "NO [TRYCREATE] Unknown Mailbox: " + oldMailboxName + " (Failure)");
        return callback();
    }

    if(newMbox && newMbox.flags.indexOf("\\NonExistent") < 0){
        connection.send(tag, "NO Mailbox " + newMailboxName + " exists (Failure)");
        return callback();
    }

    try{
        connection.server.deleteMailbox(oldMailboxName);
    }catch(E){
        connection.send(tag, E.message);
        return callback();
    }

    try{
        connection.server.createMailbox(newMailboxName, oldMbox);
    }catch(E){
        connection.send(tag, E.message);
        return callback();
    }

    connection.processNotices();
    connection.send(tag, "OK RENAME Completed");
    callback();
});

IMAPMockServer.addCommandHandler("SEARCH", function(connection, tag, data, callback){
    if(connection.state != "Selected"){
        connection.send(tag, "BAD Unknown command");
        return callback();
    }

    var params = [].concat(data || []),
        nrCache = {},
        results = connection.buildSearchResponse(params, nrCache);

    if(results.length){
        results.sort(function(a, b){
            return nrCache[a.uid] - nrCache[b.uid];
        });

        connection.send("*", "SEARCH " + (results.map(function(message){
            return nrCache[message.uid];
        })).join(" "));
    }

    connection.send(tag, "OK SEARCH completed (Success)");
    callback();
});

