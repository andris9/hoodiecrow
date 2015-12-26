"use strict";

var Stream = require("stream").Stream;
var util = require("util");
var net = require("net");
var tls = require("tls");
var fs = require("fs");
var imapHandler = require("imap-handler");
var _ = require('lodash');
var connid = 1;
//var starttls = require("./starttls");

module.exports = function(options) {
    return new IMAPServer(options);
};

var checkSystemFlags = function(systemFlags, flags) {
	var valid = true;
	_.each(flags,function (flag) {
		if (flag.charAt(0) === "\\" && systemFlags.indexOf(flag) < 0) {
			valid = false;
		}
		return valid;
	});
	return valid;
},
normalizeSystemFlags = function(flags) {
	return _.map(flags,function (flag) {
    if (flag.charAt(0) === "\\") {
        flag = flag.charAt(0) + flag.charAt(1).toUpperCase() + flag.substr(2).toLowerCase();
    }
    return flag;
	});
};



function IMAPServer(options) {
    Stream.call(this);

    this.options = options || {};
    this.options.credentials = this.options.credentials || {
        key: fs.readFileSync(__dirname + "/../cert/server.key"),
        cert: fs.readFileSync(__dirname + "/../cert/server.crt")
    };

    if (this.options.secureConnection) {
        this.server = tls.createServer(this.options.credentials, this.createClient.bind(this));
    } else {
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
		this.userMailbox = null;
		
    this.users = this.options.users || {authenticate: function (opts,cb) {
    	cb("No authentication defined");
    }};

    [].concat(this.options.plugins || []).forEach((function(plugin) {
        switch (typeof plugin) {
            case "string":
                require("./plugins/" + plugin.toLowerCase())(this);
                break;
            case "function":
                plugin(this);
                break;
        }
    }).bind(this));

    this.systemFlags = [].concat(this.options.systemFlags || ["\\Answered", "\\Flagged", "\\Draft", "\\Deleted", "\\Seen"]);
    this.storage = this.options.storage(this) || {
			mailbox: function () {
				return(null);
			}
    };
    this.uidnextCache = {}; // keep nextuid values if mailbox gets deleted
}
util.inherits(IMAPServer, Stream);

IMAPServer.prototype.listen = function() {
    var args = Array.prototype.slice.call(arguments);
    this.server.listen.apply(this.server, args);
};

IMAPServer.prototype.close = function(callback) {
    this.server.close(callback);
};

IMAPServer.prototype.createClient = function(socket) {
    var connection = new IMAPConnection(this, socket);
    this.connectionHandlers.forEach((function(handler) {
        handler(connection);
    }).bind(this));
};

IMAPServer.prototype.registerCapability = function(keyword, handler) {
    this.capabilities[keyword] = handler || function() {
        return true;
    };
};

IMAPServer.prototype.setCommandHandler = function(command, handler) {
    command = (command || "").toString().toUpperCase();
    this.commandHandlers[command] = handler;
};


/**
 * Schedules a notifying message
 *
 * @param {Object} command An object of untagged response message
 * @param {Object|String} mailbox Mailbox the message is related to
 * @param {Object} ignoreConnection if set the selected connection ignores this notification
 */
IMAPServer.prototype.notify = function(command, mailbox, ignoreConnection) {
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
IMAPServer.prototype.getCommandHandler = function(command) {
    command = (command || "").toString().toUpperCase();

    var handler;

    // try to autoload if not supported
    if (!this.commandHandlers[command]) {
        try {
            handler = require("./commands/" + command.toLowerCase());
            this.setCommandHandler(command, handler);
        } catch (E) {
            //console.log(E);
        }
    }

    return this.commandHandlers[command] || false;
};


/**
 * Validates a date value. Useful for validating APPEND dates
 *
 * @param {String} date Date value to be validated
 * @return {Boolean} Returns true if the date string is in IMAP date-time format
 */
IMAPServer.prototype.validateInternalDate = function(date) {
    if (!date || typeof date !== "string") {
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
IMAPServer.prototype.formatInternalDate = function(date) {
    var day = date.getDate(),
        month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
            "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
        ][date.getMonth()],
        year = date.getFullYear(),
        hour = date.getHours(),
        minute = date.getMinutes(),
        second = date.getSeconds(),
        tz = date.getTimezoneOffset(),
        tzHours = Math.abs(Math.floor(tz / 60)),
        tzMins = Math.abs(tz) - tzHours * 60;

    return (day < 10 ? "0" : "") + day + "-" + month + "-" + year + " " +
        (hour < 10 ? "0" : "") + hour + ":" + (minute < 10 ? "0" : "") +
        minute + ":" + (second < 10 ? "0" : "") + second + " " +
        (tz > 0 ? "-" : "+") + (tzHours < 10 ? "0" : "") + tzHours +
        (tzMins < 10 ? "0" : "") + tzMins;
};


/**
 * Toggles listed flags. Vlags with `value` index will be turned on,
 * other listed fields are removed from the array
 *
 * @param {Array} flags List of flags
 * @param {Array} checkFlags Flags to toggle
 * @param {Number} value Flag from checkFlags array with value index is toggled
 */
IMAPServer.prototype.toggleFlags = function(flags, checkFlags, value) {
    [].concat(checkFlags || []).forEach((function(flag, i) {
        if (i === value) {
            this.ensureFlag(flags, flag);
        } else {
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
IMAPServer.prototype.ensureFlag = function(flags, flag) {
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
IMAPServer.prototype.removeFlag = function(flags, flag) {
    var i;
    if (flags.indexOf(flag) >= 0) {
        for (i = flags.length - 1; i >= 0; i--) {
            if (flags[i] === flag) {
                flags.splice(i, 1);
            }
        }
    }
};





/****
 BEGIN IMAPConnection
 ****/

function IMAPConnection(server, socket) {
    this.server = server;
		this._id = connid++;
    this.socket = socket;
    this.options = this.server.options;

    this.state = "Not Authenticated";

    this.secureConnection = !!this.options.secureConnection;

    this._remainder = "";
    this._command = "";
    this._literalRemaining = 0;

    this.inputHandler = false;

    this._commandQueue = [];
    this._processing = false;

    this.socket.on("data", this.onData.bind(this));
    this.socket.on("close", this.onClose.bind(this));
    this.socket.on("error", this.onError.bind(this));

    this.directNotifications = false;
    this._notificationCallback = this.onNotify.bind(this);
    this.notificationQueue = [];
    this.server.on("notify", this._notificationCallback);

    this.socket.write("* OK imapper ready for rumble\r\n");
}

IMAPConnection.prototype.onClose = function() {
    this.socket.removeAllListeners();
    this.socket = null;
    try {
        this.socket.end();
    } catch (E) {}
    this.server.removeListener("notify", this._notificationCallback);
};

IMAPConnection.prototype.onError = function(err) {
    if (this.options.debug) {
        console.log(this._id+" Socket error event emitted, %s", Date());
        console.log(err.stack);
    }
    try {
        this.socket.end();
    } catch (E) {}
};

IMAPConnection.prototype.onData = function(chunk) {
    var match, str;

    str = (chunk || "").toString("binary");

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


    this._remainder = str = this._remainder + str;

    if (this.options.debug) {
        console.log(this._id+" R: %s", str);
    }

    while ((match = str.match(/(\{(\d+)(\+)?\})?\r?\n/))) {
        if (!match[2]) {

            if (this.inputHandler) {
                this.inputHandler(this._command + str.substr(0, match.index));
            } else {
                this.scheduleCommand(this._command + str.substr(0, match.index));
            }

            this._remainder = str = str.substr(match.index + match[0].length);
            this._command = "";
            continue;
        }

        if (match[3] !== "+") {
            if (this.socket && !this.socket.destroyed) {
                this.socket.write("+ Go ahead\r\n");
            }
        }

        this._remainder = "";
        this._command += str.substr(0, match.index + match[0].length);
        this._literalRemaining = Number(match[2]);

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
};

IMAPConnection.prototype.onNotify = function(notification) {
	// do not send notifications with our connection if we were told to ignore this connection
    if (notification.ignoreConnection === this) {
        return;
    }
		// we send the notification if:
		// - the notification was not limited to a particular mailbox OR
		// - the notification mailbox and the selected mailbox are the same
    if (!notification.mailbox ||
        (this.selectedMailbox &&
            this.selectedMailbox.path === notification.mailbox)) {
        this.notificationQueue.push(notification.command);
        if (this.directNotifications) {
            this.processNotifications();
        }
    }
};

IMAPConnection.prototype.upgradeConnection = function(callback) {
    this.upgrading = true;

    this.options.credentials.ciphers = this.options.credentials.ciphers || "ECDH+AESGCM:DH+AESGCM:ECDH+AES256:DH+AES256:ECDH+AES128:DH+AES:ECDH+3DES:DH+3DES:RSA+AESGCM:RSA+AES:RSA+3DES:!aNULL:!MD5:!DSS";
    if (!("honorCipherOrder" in this.options.credentials)) {
        this.options.credentials.honorCipherOrder = true;
    }

    var secureContext = tls.createSecureContext(this.options.credentials);
    var socketOptions = {
        secureContext: secureContext,
        isServer: true,
        server: this.server.server,

        // throws if SNICallback is missing, so we set a default callback
        SNICallback: function(servername, cb) {
            cb(null, secureContext);
        }
    };

    // remove all listeners from the original socket besides the error handler
    this.socket.removeAllListeners();
    this.socket.on("error", this.onError.bind(this));

    // upgrade connection
    var secureSocket = new tls.TLSSocket(this.socket, socketOptions);

    secureSocket.on("close", this.onClose.bind(this));
    secureSocket.on("error", this.onError.bind(this));
    secureSocket.on("clientError", this.onError.bind(this));

    secureSocket.on("secure", function() {
        this.secureConnection = true;
        this.socket = secureSocket;
        this.upgrading = false;
        this.socket.on("data", this.onData.bind(this));
        callback();
    }.bind(this));
};

IMAPConnection.prototype.processNotifications = function(data) {
    var notification;
    for (var i = 0; i < this.notificationQueue.length; i++) {
        notification = this.notificationQueue[i];

        if (data && ["FETCH", "STORE", "SEARCH"].indexOf((data.command || "").toUpperCase()) >= 0) {
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
IMAPConnection.prototype.send = function(data) {
    if (!this.socket || this.socket.destroyed) {
        return;
    }
    if (!data.notification && data.tag !== "*") {
        // arguments[2] should be the original command
        this.processNotifications(arguments[2]);
    } else {
        // override values etc.
    }

    var args = Array.prototype.slice.call(arguments);
    this.server.outputHandlers.forEach((function(handler) {
        handler.apply(null, [this].concat(args));
    }).bind(this));

    // No need to display this response to user
    if (data.skipResponse) {
        return;
    }

    var compiled = imapHandler.compiler(data);

    if (this.options.debug) {
        console.log(this._id+" S: %s", compiled);
    }
    if (this.socket && !this.socket.destroyed) {
        this.socket.write(new Buffer(compiled + "\r\n", "binary"));
    }
};

IMAPConnection.prototype.scheduleCommand = function(data) {
    var parsed,
        tag = (data.match(/\s*([^\s]+)/) || [])[1] || "*";

    try {
        parsed = imapHandler.parser(data, {
            literalPlus: this.server.literalPlus
        });
    } catch (E) {
        this.send({
            tag: "*",
            command: "BAD",
            attributes: [{
                type: "SECTION",
                section: [{
                    type: "ATOM",
                    value: "SYNTAX"
                }]
            }, {
                type: "TEXT",
                value: E.message
            }]
        }, "ERROR MESSAGE", null, data, E);

        this.send({
            tag: tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "Error parsing command"
            }]
        }, "ERROR RESPONSE", null, data, E);

        return;
    }

    if (this.server.getCommandHandler(parsed.command)) {
        this._commandQueue.push({
            parsed: parsed,
            data: data
        });
        this.processQueue();
    } else {
        this.send({
            tag: parsed.tag,
            command: "BAD",
            attributes: [{
                type: "TEXT",
                value: "Invalid command " + parsed.command + ""
            }]
        }, "UNKNOWN COMMAND", parsed, data);
    }
};

IMAPConnection.prototype.processQueue = function(force) {
    var element;

    if (!force && this._processing) {
        return;
    }

    if (!this._commandQueue.length) {
        this._processing = false;
        return;
    }

    this._processing = true;

    element = this._commandQueue.shift();
    this.server.getCommandHandler(element.parsed.command)(this, element.parsed, element.data, (function() {
        if (!this._commandQueue.length) {
            this._processing = false;
        } else {
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
IMAPConnection.prototype.expungeDeleted = function(ignoreSelf, ignoreExists, cb) {
	var that = this, mailbox = this.selectedMailbox.path;
	this.userMailbox.expunge(mailbox,function (err,data) {
		if (data && data.expunged && data.expunged.length > 0) {
			data.expunged.forEach(function (i) {
	      that.server.notify({
	          tag: "*",
	          attributes: [
	              i, {
	                  type: "ATOM",
	                  value: "EXPUNGE"
	              }
	          ]
	      }, mailbox, ignoreSelf ? this : false);
			});
			if (data.exists) {
	      that.server.notify({
	          tag: "*",
	          attributes: [
	              data.exists, {
	                  type: "ATOM",
	                  value: "EXISTS"
	              }
	          ],
	      }, mailbox, ignoreSelf || ignoreExists ? that : false);
			}
		}
		cb(err);
	});
};

IMAPConnection.prototype.createMessage = function (path,msg,callback) {
	this.userMailbox.createMessage(path,msg,function (err,data) {
		/*
    this.notify({
        tag: "*",
        attributes: [
            mailbox.messages.length, {
                type: "ATOM",
                value: "EXISTS"
            }
        ]
    }, path, ignoreConnection);
*/

		callback(err,data);
	});
};

IMAPConnection.prototype.setState = function (state,user) {
	this.state = state;
	if (state === "Authenticated") {
		// set up our storage connection
		this.userMailbox = this.server.storage.mailbox(user,user,this.server.messageHandlers);
	} else if (state === "Logout") {
		this.userMailbox = null;
	}
};

IMAPConnection.prototype.select = function (mailbox,callback) {
	var that = this;
	this.userMailbox.getFolder(mailbox,function (err,data) {
		if (!err) {
			that.selectedMailbox = data;
	    that.readOnly = false;
			that.setState("Selected");
		}
		callback(err,data);
	});
};

IMAPConnection.prototype.addFlags = function (messages,isUid,flags,cb) {
	messages = [].concat(messages || []);
	flags = [].concat(flags || []);
  flags = normalizeSystemFlags(flags);
  if (!checkSystemFlags(this.server.systemFlags, flags)) {return cb("Invalid system flags");}
	this.userMailbox.addFlags(this.selectedMailbox.path,messages,isUid,flags,cb);
};
IMAPConnection.prototype.removeFlags = function (messages,isUid,flags,cb) {
	messages = [].concat(messages || []);
	flags = [].concat(flags || []);
  flags = normalizeSystemFlags(flags);
  if (!checkSystemFlags(this.server.systemFlags, flags)) {return cb("Invalid system flags");}
	this.userMailbox.removeFlags(this.selectedMailbox.path,messages,isUid,flags,cb);
};
IMAPConnection.prototype.replaceFlags = function (messages,isUid,flags,cb) {
	messages = [].concat(messages || []);
	flags = [].concat(flags || []);
  flags = normalizeSystemFlags(flags);
  if (!checkSystemFlags(this.server.systemFlags, flags)) {return cb("Invalid system flags");}
	this.userMailbox.replaceFlags(this.selectedMailbox.path,messages,isUid,flags,cb);
};
IMAPConnection.prototype.addProperties = function (messages,isUid,properties,cb) {
	messages = [].concat(messages || []);
	this.userMailbox.addProperties(this.selectedMailbox.path,messages,isUid,properties,cb);
};
IMAPConnection.prototype.removeProperties = function (messages,isUid,properties,cb) {
	messages = [].concat(messages || []);
	this.userMailbox.removeProperties(this.selectedMailbox.path,messages,isUid,properties,cb);
};
IMAPConnection.prototype.replaceProperties = function (messages,isUid,properties,cb) {
	messages = [].concat(messages || []);
	this.userMailbox.replaceProperties(this.selectedMailbox.path,messages,isUid,properties,cb);
};

IMAPConnection.prototype.getMessageRange = function (range,isUid,callback) {
	this.userMailbox.getMessageRange(this.selectedMailbox.path||this.selectedMailbox.name,range,isUid,callback);
};
IMAPConnection.prototype.getFolder = function (path,callback) {
	this.userMailbox.getFolder(path,callback);
};
IMAPConnection.prototype.createFolder = function (path,callback) {
	this.userMailbox.createFolder(path,callback);
};
IMAPConnection.prototype.matchFolders = function (reference,match,callback) {
	this.userMailbox.matchFolders(reference,match,callback);
};
IMAPConnection.prototype.subscribeFolder = function (path,callback) {
	this.userMailbox.subscribeFolder(path,callback);
};

IMAPConnection.prototype.list = function (mailbox,callback) {
	var that = this;
	this.userMailbox.getFolder(mailbox,function (err,data) {
		if (!err) {
			that.selectedMailbox = data;
	    that.readOnly = false;
			that.setState("Selected");
		}
		callback(err,data);
	});
};
IMAPConnection.prototype.examine = function (mailbox,callback) {
	var that = this;
	this.userMailbox.getFolder(mailbox,function (err,data) {
		if (!err) {
			that.selectedMailbox = data;
	    that.readOnly = true;
			that.setState("Selected");
		}
		callback(err,data);
	});
};

IMAPConnection.prototype.setFolderSpecialUse = function (folder,attrs,callback) {
	// set the special use
	this.userMailbox.setFolderSpecialUse(folder,attrs,function (err,data) {
		if (callback && typeof(callback) === "function") {
			callback(err,data);
		}
	});
};
IMAPConnection.prototype.delMailbox = function (folder,callback) {
	this.userMailbox.delFolder(folder,callback);
};
IMAPConnection.prototype.namespace = function (cb) {
	this.userMailbox.getNamespaces(cb);
};
IMAPConnection.prototype.renameMailbox = function (source,destination,cb) {
	this.userMailbox.renameFolder(source,destination,cb);
};

IMAPConnection.prototype.search = function (query,cb) {
	this.userMailbox.searchMessages(this.selectedMailbox,query,cb);
};
