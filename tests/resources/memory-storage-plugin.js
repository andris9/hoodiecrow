var _ = require('lodash'), async = require('async'), moment = require('moment'),
mimeParser = require("../../lib/mimeparser"),


server,
messageHandlers,

rawData = {
    "INBOX": {
			messages:[]
		},
    "": {
    }
}, 
data = _.cloneDeep(rawData),

referenceNamespace = false,
uidnextCache = {}, // keep nextuid values if mailbox gets deleted

folderCache = {},


dateCompare = {
	lt: function (date) {
		date = moment(date,"DD-MMM-YYYY");
		return function (d,format) {
			var m = moment(d,format);
			return m.diff(date) < 0 && m.date() !== date.date();
		};
	},
	ge: function (date) {
		date = moment(date,"DD-MMM-YYYY");
		return function (d,format) {
			var m = moment(d,format);
			return m.diff(date,'days') > 0 || (m.diff(date,'days') === 0 && m.date() === date.date());
		};
	},
	eq: function (date) {
		date = moment(date,"DD-MMM-YYYY");
		return function (d,format) {
			var m = moment(d,format);
			return m.diff(date,'days') === 0 && m.date() === date.date();
		};
	}
},

getMailbox = function(path) {
    if (path.toUpperCase() === "INBOX") {
        return folderCache.INBOX;
    }
    return folderCache[path];
},

checkFolderExists = function (folder) {
	return folderCache[folder] !== undefined;
},

getMessageRange = function (messages,range, isUid) {
  range = (range || "").toString();
  var result = [],
      rangeParts = range.split(","),
      uid,
      totalMessages = messages.length,
      maxUid = 0,

      inRange = function(nr, ranges, total) {
          var range, from, to;
          for (var i = 0, len = ranges.length; i < len; i++) {
              range = ranges[i];
              to = range.split(":");
              from = to.shift();
              if (from === "*") {
                  from = total;
              }
              from = Number(from) || 1;
              to = to.pop() || from;
              to = Number(to === "*" && total || to) || from;

              if (nr >= Math.min(from, to) && nr <= Math.max(from, to)) {
                  return true;
              }
          }
          return false;
      };
  messages.forEach(function(message) {
      if (message.uid > maxUid) {
          maxUid = message.uid;
      }
  });

  for (var i = 0, len = messages.length; i < len; i++) {
      uid = messages[i].uid || 1;
      if (inRange(isUid ? uid : i + 1, rangeParts, isUid ? maxUid : totalMessages)) {
          result.push([i + 1, messages[i]]);
      }
  }
	return result;
},

search = function (folder,query) {
	var messageSource = (folderCache[folder.path]||{}).messages, indexCache = {},
	totalResults = [],
  searchFlags = function(messages, flag, negate) {
      var results = [];
      messages.forEach(function(message) {
          if (
              (!negate && message.flags.indexOf(flag) >= 0) ||
              (negate && message.flags.indexOf(flag) < 0)) {
              results.push(message);
          }
      });
      return results;
  },

  searchHeaders = function(key, value, includeEmpty) {
      var results = [], compfn;
      key = (key || "").toString().toLowerCase();
			if (key === "date") {
				if (value.lt) {
					compfn = dateCompare.lt(value.lt);
				} else if (value.ge) {
					compfn = dateCompare.ge(value.ge);
				} else if (value.eq) {
					compfn = dateCompare.eq(value.eq);
				}
				if (compfn) {
	        results = _.reduce(messageSource,function(total, message) {
						var messageDate, format;
	            if (!message.parsed) {
	                message.parsed = mimeParser(message.raw || "");
	            }
							if (message.parsed.parsedHeader.date) {
								messageDate = message.parsed.parsedHeader.date;
								format = "DD MMM YYYY";
							} else {
								messageDate = message.internaldate;
								format = "DD-MMM-YYYY";
							}
	            if (compfn(messageDate,format)) {
	                total.push(message);
	            }
							return total;
	        },[]);
				}
			} else {
	      value = (value || "").toString();
	      if (!value && !includeEmpty) {
	          return [];
	      }

	      messageSource.forEach(function(message) {
	          if (!message.parsed) {
	              message.parsed = mimeParser(message.raw || "");
	          }
	          var headers = (message.parsed.header || []),
	              parts,
	              lineKey, lineValue;

	          for (var j = 0, len = headers.length; j < len; j++) {
	              parts = headers[j].split(":");
	              lineKey = (parts.shift() || "").trim().toLowerCase();
	              lineValue = (parts.join(":") || "");

	              if (lineKey === key && (!value || lineValue.toLowerCase().indexOf(value.toLowerCase()) >= 0)) {
	                  results.push(message);
	                  return;
	              }
	          }
	      });
			}
      return results;
  },

  queryHandlers = {


			"index": function (value) {
        return getMessageRange(messageSource, value, false).map(function(item) {
            return item[1];
        });
			},
			"uid": function (value) {
        return getMessageRange(messageSource, value, true).map(function(item) {
            return item[1];
        });
			},
			"headers": function (value) {
				var results = [];
				if (value) {
					results = _.reduce(value,function (total, val, header) {
						return total.concat(searchHeaders(header,val));
					},[]);
				}
				return results;
			},
			"date": function (value) {
        var results = [], compfn = null;
				if (value) {
					if (value.ge) {
						compfn = dateCompare.ge(value.ge);
					} else if (value.lt) {
						compfn = dateCompare.lt(value.lt);
					} else if (value.eq) {
						compfn = dateCompare.eq(value.eq);
					}
				}
				if (compfn) {
	        messageSource.forEach(function(message) {
	            if (compfn(message.internaldate,"DD-MMM-YYYY")) {
	                results.push(message);
	            }
	        });
				}
        return results;
			},
			"body": function (value) {
        var results = [];
        value = (value || "").toString();
        if (!value) {
            return [];
        }

        messageSource.forEach(function(message) {
            if (!message.parsed) {
                message.parsed = mimeParser(message.raw || "");
            }
            if ((message.parsed.text || "").toLowerCase().indexOf(value.toLowerCase()) >= 0) {
                results.push(message);
            }
        });
        return results;
			},
			"text": function (value) {
        var results = [];
        value = (value || "").toString();
        if (!value) {
            return [];
        }

        messageSource.forEach(function(message) {
            if ((message.raw || "").toString().toLowerCase().indexOf(value.toLowerCase()) >= 0) {
                results.push(message);
            }
        });
        return results;
			},
			"flags": function (value) {
        var messages = messageSource, result = _.reduce([].concat(value || []), function (total,flag) {
					var ret = [];
					if (typeof(flag) === "string") {
						ret = searchFlags(total, flag, false);
					} else if (flag.not) {
						ret = searchFlags(total, flag.not, true);
					}
        	return (ret || []);
        },messages);
				return result;
			},
			"size":function (value) {
        var results = [], compfn = null, size;
				if (value) {
					if (value.gt) {
						size = Number(value.gt);
						compfn = function (c) {
							return c > size;
						};
					} else if (value.lt) {
						size = Number(value.lt);
						compfn = function (c) {
							return c < size;
						};
					} else if (value.eq) {
						size = Number(value.eq);
						compfn = function (c) {
							return c === size;
						};
					}
				}
				if (compfn) {
	        messageSource.forEach(function(message) {
	            if (compfn((message.raw || "").length)) {
	                results.push(message);
	            }
	        });
				}
        return results;
			},
			"or": function (value) {
				// just take the results of either of 2 of them
				var results = _.reduce(value,function (total,val,key) {
					return total.concat( queryHandlers[key] ? queryHandlers[key](val)||[] : []  );
				},[]);
				return results;
			}
  };
	
	
/*	
  Object.keys(connection.server.searchHandlers).forEach(function(key) {

      // if handler takes more than 3 params (mailbox, message, i), use the remaining as value params
      if (!(key in queryParams) && connection.server.searchHandlers[key].length > 3) {
          queryParams[key] = [];
          for (var i = 0, len = connection.server.searchHandlers[key].length - 3; i < len; i++) {
              queryParams[key].push("VALUE");
          }
      }

      queryHandlers[key] = function() {
          var args = Array.prototype.slice.call(arguments),
              results = [];

          // check all messages against the user defined function
          messageSource.forEach(function(message, i) {
              if (connection.server.searchHandlers[key].apply(null, [connection, message, i + 1].concat(args))) {
                  nrCache[message.uid] = i + 1;
                  results.push(message);
              }
          });
          return results;
      };

  });
	*/
	
	// now need to do correct processing
  _.forIn(query,function(value, key) {

      if (!queryHandlers[key]) {
          totalResults = null;
					return false;
      } else {
		    var handler = queryHandlers[key],
		        currentResult = handler && handler(value) || [];

        totalResults = totalResults.concat(currentResult || []);
      }

  });
	if (totalResults === null) {
		return null;
	} else {
		// build the indexCache
		totalResults = _.uniq(totalResults);
		indexCache = _.reduce(messageSource,function (total,message,i) {
			if (_.includes(totalResults,message)) {
				total.push({uid:message.uid,index:i+1});
			}
			return total;
		},[]);
	  return _.uniq(indexCache);	
	}
},




/**
 * Ensures that a list of flags includes selected flag
 *
 * @param {Array} flags An array of flags to check
 * @param {String} flag If the flag is missing, add it
 */
ensureFlag = function(flags, flag) {
    if (flags.indexOf(flag) < 0) {
        flags.push(flag);
    }
},

/**
 * Removes a flag from a list of flags
 *
 * @param {Array} flags An array of flags to check
 * @param {String} flag If the flag is in the list, remove it
 */
removeFlag = function(flags, flag) {
    var i;
    if (flags.indexOf(flag) >= 0) {
        for (i = flags.length - 1; i >= 0; i--) {
            if (flags[i] === flag) {
                flags.splice(i, 1);
            }
        }
    }
},


processMailbox = function(path, mailbox, namespace) {
    mailbox.path = path;

    mailbox.namespace = namespace;
    mailbox.uid = mailbox.uid || 1;
    mailbox.uidvalidity = mailbox.uidvalidity || uidnextCache[path] || 1;
    mailbox.flags = [].concat(mailbox.flags || []);
    mailbox.allowPermanentFlags = "allowPermanentFlags" in mailbox ? mailbox.allowPermanentFlags : true;
    mailbox.permanentFlags = [].concat(mailbox.permanentFlags || server.systemFlags);

    mailbox.subscribed = "subscribed" in mailbox ? !!mailbox.subscribed : true;

    // ensure message array
    mailbox.messages = [].concat(mailbox.messages || []);

    // ensure highest uidnext
    mailbox.uidnext = Math.max.apply(Math, [mailbox.uidnext || 1].concat(mailbox.messages.map(function(message) {
        return (message.uid || 0) + 1;
    })));

    toggleFlags(mailbox.flags, ["\\HasChildren", "\\HasNoChildren"],
        mailbox.folders && Object.keys(mailbox.folders).length ? 0 : 1);
},


processMessage = function(message, mailbox) {
    // internaldate should always be a Date object
    message.internaldate = message.internaldate || new Date();
    if (Object.prototype.toString.call(message.internaldate) === "[object Date]") {
        message.internaldate = formatInternalDate(message.internaldate);
    }
    message.flags = [].concat(message.flags || []);
    message.uid = message.uid || mailbox.uidnext++;
		message.properties = _.extend(message.properties||{});

    // Allow plugins to process messages
		_.each(messageHandlers,function (handler) {
      handler(message, mailbox);
		});

},

toggleFlags = function(flags, checkFlags, value) {
    [].concat(checkFlags || []).forEach(function(flag, i) {
        if (i === value) {
            ensureFlag(flags, flag);
        } else {
            removeFlag(flags, flag);
        }
    });
},

indexFolders = function() {
    var folders = {};

    var walkTree = function(path, separator, branch, namespace) {
        var keyObj = namespace === "INBOX" ? {
            INBOX: true
        } : branch;

        Object.keys(keyObj).forEach(function(key) {

            var curBranch = branch[key],
                curPath = (path ? path + (path.substr(-1) !== separator ? separator : "") : "") + key;

            folders[curPath] = curBranch;
						folders[curPath].separator = separator;
            processMailbox(curPath, curBranch, namespace);

            // ensure uid, flags and internaldate for every message
            curBranch.messages.forEach(function(message, i) {

                // If the input was a raw message, convert it to an object
                if (typeof message === "string") {
                    curBranch.messages[i] = message = {
                        raw: message
                    };
                }

                processMessage(message, curBranch);
            });

            if (namespace !== "INBOX" && curBranch.folders && Object.keys(curBranch.folders).length) {
                walkTree(curPath, separator, curBranch.folders, namespace);
            }

        });
    };

    // Ensure INBOX namespace always exists
    if (!data.INBOX) {
        data.INBOX = {};
    }

    Object.keys(data).forEach(function(key) {
        if (key === "INBOX") {
            walkTree("", "/", data, "INBOX");
        } else {
            data[key].folders = data[key].folders || {};
            data[key].separator = data[key].separator || key.substr(-1) || "/";
            data[key].type = data[key].type || "personal";

            if (data[key].type === "personal" && referenceNamespace === false) {
                referenceNamespace = key;
            }

            walkTree(key, data[key].separator, data[key].folders, key);
        }
    });

    if (!referenceNamespace) {
        data[""] = data[""] || {};
        data[""].folders = data[""].folders || {};
        data[""].separator = data[""].separator || "/";
        data[""].type = "personal";
        referenceNamespace = "";
    }

    if (!data.INBOX.separator && referenceNamespace !== false) {
        data.INBOX.separator = data[referenceNamespace].separator;
    }

    if (referenceNamespace.substr(0, referenceNamespace.length - data[referenceNamespace].separator.length).toUpperCase === "INBOX") {
        toggleFlags(data.INBOX.flags, ["\\HasChildren", "\\HasNoChildren"],
            data[referenceNamespace].folders && Object.keys(data[referenceNamespace].folders).length ? 0 : 1);
    }
    folderCache = folders;
},

/**
 * Converts a date object to a valid date-time string format
 *
 * @param {Object} date Date object to be converted
 * @return {String} Returns a valid date-time formatted string
 */
formatInternalDate = function(date) {
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
},


makeMessage = function () {
	return {
		properties: {
			timestamp: new Date().getTime()
		},
		raw: "This is a message",
		raw_url: "http://localhost/raw",
		headers: "From: me@you.com\n\rTo: you@me.com",
		headers_url: "http://localhost/headers",
		html: "<html><body><h1>Message</h1></body></html>",
		html_url: "http://localhost/html",
		attachments: ["Attachment1","Attachment2"]
	};
},
makeFolder = function (f) {
	var folder = folderCache[f],
	total = folder.messages.length,
	seen = _.reduce(folder.messages,function (total,msg) {
		return total + (_.contains(msg.flags||[],"\\Seen") ? 1 : 0);
	},0), unseen = total - seen;
	return {
		name: f,
		path: f,
    flags: folder.flags,
    seen: seen,
    unseen: unseen,
		messages: total,
    permanentFlags: folder.permanentFlags
	};
},
makeMailbox = function () {
	return {
		folders: function (cb) {
			cb(null,_.keys(data));
		},
		getFolder: function (folder,cb) {
			if (folderCache[folder]) {
				cb(null,makeFolder(folder));
			} else {
				cb("no folder");
			}
		},
		createFolder: function (path,cb) {
	    // detect namespace for the path
	    var namespace = "",
	        storage,
	        folderPath;

	    Object.keys(data).forEach((function(key) {
	        if (key === "INBOX") {
	            // Ignore INBOX
	            return;
	        }
	        var ns = key.length ? key.substr(0, key.length - data[key].separator.length) : key;
	        if (key.length && (path === ns || path.substr(0, key.length) === key)) {
	            if (path === ns) {
	                return cb("Used mailbox name is a namespace value");
	            }
	            namespace = key;
	        } else if (!namespace && !key && data[key].type === "personal") {
	            namespace = key;
	        }
	    }).bind(this));

	    if (!data[namespace]) {
	        return cb("Unknown namespace");
	    } else {
	        folderPath = path;
	        storage = data[namespace];
	        if (storage.type !== "personal") {
	            return cb("Permission denied");
	        }

	        if (folderPath.substr(-storage.separator.length) === storage.separator) {
	            folderPath = folderPath.substr(0, folderPath.length - storage.separator.length);
	        }

	        if (folderCache[folderPath] && folderCache[folderPath].flags.indexOf("\\Noselect") < 0) {
	            return cb("Mailbox already exists");
	        }
	        path = folderPath;
	        folderPath = folderPath.substr(namespace.length).split(storage.separator);
	    }

	    var parent = storage,
	        curPath = namespace;

	    if (curPath) {
	        curPath = curPath.substr(0, curPath.length - storage.separator.length);
	    }

	    folderPath.forEach(function(folderName) {
	        curPath += (curPath.length ? storage.separator : "") + folderName;

	        var folder = getMailbox(curPath) || false;

	        if (folder && folder.flags && folder.flags.indexOf("\\NoInferiors") >= 0) {
	            return cb("Can not create subfolders for " + folder.path);
	        }

					if (!folder) {
	            folder = {
	                subscribed: false
	            };
	            processMailbox(curPath, folder, namespace);
	            parent.folders = parent.folders || {};
	            parent.folders[folderName] = folder;

	            delete uidnextCache[curPath];
	            folderCache[curPath] = folder;
	        }

	        if (parent !== storage) {
	            // Remove NoSelect if needed
	            removeFlag(parent.flags, "\\Noselect");

	            // Remove \HasNoChildren and add \\HasChildren from parent
	            toggleFlags(parent.flags, ["\\HasNoChildren", "\\HasChildren"], 1);
	        } else if (folder.namespace === referenceNamespace) {
	            if (referenceNamespace.substr(0, referenceNamespace.length - data[referenceNamespace].separator.length).toUpperCase === "INBOX") {
	                toggleFlags(data.INBOX.flags, ["\\HasNoChildren", "\\HasChildren"], 1);
	            }
	        }
	        parent = folder;
	    });
			indexFolders();
			cb();
		},
		delFolder: function (path,cb) {
			var that = this;
	    // Ensure case insensitive INBOX
	    if (path.toUpperCase() === "INBOX") {
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

	    Object.keys(data).forEach(function(key) {
	        if (key === "INBOX") {
	            // Ignore INBOX
	            return;
	        }
	        var ns = key.length ? key.substr(0, key.length - data[key].separator.length) : key;
	        if (key.length && (path === ns || path.substr(0, key.length) === key)) {
	            if (path === ns) {
	                return cb("Used mailbox name is a namespace value");
	            }
	            namespace = key;
	        } else if (!namespace && !key && data[key].type === "personal") {
	            namespace = key;
	        }
	    });

	    if (!data[namespace]) {
	        return cb("Unknown namespace");
	    } else {
	        parent = storage = data[namespace];

	        if (storage.type !== "personal") {
	            return cb("Permission denied");
	        }

	        if (folderPath.substr(-storage.separator.length) === storage.separator) {
	            folderPath = folderPath.substr(0, folderPath.length - storage.separator.length);
	        }

	        mailbox = folderCache[folderPath];

	        if (!mailbox || (
	                mailbox.flags.indexOf("\\Noselect") >= 0 &&
	                Object.keys(mailbox.folders || {}).length)) {
	            return cb("Mailbox does not exist");
	        }

	        folderPath = folderPath.split(storage.separator);
	        folderName = folderPath.pop();

	        parentKey = folderPath.join(storage.separator);
	        if (parentKey !== "INBOX") {
	            parent = folderCache[folderPath.join(storage.separator)] || parent;
	        }
					
					
					// now it is time to delete the folder
					// if this has subfolders AND we did not say to keep contents
					// then delete everything except for those subfolders, which should be saved in a new folder, by the same name
					// unselectable

          delete folderCache[mailbox.path];
          uidnextCache[mailbox.path] = mailbox.uidnext;
          delete parent.folders[folderName];

          if (parent !== storage) {
              if (parent.flags.indexOf("\\Noselect") >= 0 &&
                  !Object.keys(parent.folders || {}).length
              ) {
                  that.delFolder(parent.path,function(){});
              } else {
                  toggleFlags(parent.flags, ["\\HasNoChildren", "\\HasChildren"], Object.keys(parent.folders || {}).length ? 1 : 0);
              }
          } else if (namespace === this.referenceNamespace) {
              if (referenceNamespace.substr(0, this.referenceNamespace.length - data[referenceNamespace].separator.length).toUpperCase === "INBOX") {
                  toggleFlags(data.INBOX.flags, ["\\HasNoChildren", "\\HasChildren"], Object.keys(storage.folders || {}).length ? 1 : 0);
              }
          }
	    }
			indexFolders();
			cb();
		},
		renameFolder: function (source,destination,cb) {
			var that = this;
			// create the new one
			// move the contents over
			// delete the old one
			async.series([
				function (cb) {
					that.createFolder(destination,cb);
				},
				// move the contents over
				function (cb) {
					_.extend(folderCache[destination],folderCache[source]);
					cb();
				},
				// delete the old folder
				function (cb) {
					that.delFolder(source,cb);
				}
			],function (err,data) {
				cb(err,data);
			});
		},
		createMessage: function (f,msg,cb) {
	    var message = {
	        flags: msg.flags,
	        internaldate: msg.internaldate,
	        raw: msg.raw
	    }, folder = folderCache[f];
			if (!folder) {
				return cb("Invalid folder");
			} else {
		    folder.messages.push(message);
				indexFolders();
				cb();
			}
		},
		addFlags : function (folder,messages,isUid,flags,cb) {
			var ret = [];
			// check that the folder exists
			if (!checkFolderExists(folder)) {return cb("Invalid folder");}
			// now add the flags
			this.getMessageRange(folder,messages, isUid, function (err,messages) {
				// make sure that the messages exist
				if (!messages || messages.length <= 0) {
					return cb("Invalid messages");
				}
				_.each(messages,function (message) {
			    [].concat(flags).forEach(function(flag) {

			        // Ignore if it is not in allowed list and only permament flags are allowed to use
			        if (folderCache[folder].permanentFlags.indexOf(flag) < 0 && !folderCache[folder].allowPermanentFlags) {
			            return;
			        }

			        if (message[1].flags.indexOf(flag) < 0) {
			            message[1].flags.push(flag);
			        }
			    });
					ret.push({index: message[0], uid: message[1].uid, flags: message[1].flags});
				});
				cb(null,ret);
			});
		},
		removeFlags : function (folder,messages,isUid,flags,cb) {
			var ret = [];
			// check that the folder exists
			if (!checkFolderExists(folder)) {return cb("Invalid folder");}
			this.getMessageRange(folder,messages, isUid, function (err,messages) {
				// make sure that the messages exist
				if (!messages || messages.length <= 0) {
					return cb("Invalid messages");
				}
				_.each(messages,function (message) {
					[].concat(flags).forEach(function(flag) {
						
		        if (message[1].flags.indexOf(flag) >= 0) {
		            for (var i = 0; i < message[1].flags.length; i++) {
		                if (message[1].flags[i] === flag) {
		                    message[1].flags.splice(i, 1);
		                    break;
		                }
		            }
			        }
			    });
					ret.push({index: message[0], uid: message[1].uid, flags: message[1].flags});
				});
				cb(null,ret);
			});
			// callback without error, but with the new data
		},
		replaceFlags : function (folder,messages,isUid,flags,cb) {
			var ret = [];
			// check that the folder exists
			if (!checkFolderExists(folder)) {return cb("Invalid folder");}
			
			// now replace all of the flags
			this.getMessageRange(folder,messages, isUid, function (err,messages) {
				// make sure that the messages exist
				if (!messages || messages.length <= 0) {
					return cb("Invalid messages");
				}
				_.each(messages,function (message) {
			    var messageFlags = [];
			    [].concat(flags).forEach(function(flag) {

			        // Ignore if it is not in allowed list and only permament flags are allowed to use
			        if (folderCache[folder].permanentFlags.indexOf(flag) < 0 && !folderCache[folder].allowPermanentFlags) {
			            return;
			        }

			        if (messageFlags.indexOf(flag) < 0) {
			            messageFlags.push(flag);
			        }
			    });
			    message[1].flags = messageFlags;
					ret.push({index: message[0], uid: message[1].uid, flags: message[1].flags});
				});
				cb(null, ret);
			});
		},
		addProperties : function (folder,messages,isUid,properties,cb) {
			var ret = [];
			// check that the folder exists
			if (!checkFolderExists(folder)) {return cb("Invalid folder");}
			// now add the flags
			this.getMessageRange(folder,messages, isUid, function (err,messages) {
				// make sure that the messages exist
				if (!messages || messages.length <= 0) {
					return cb("Invalid messages");
				}
				_.each(messages,function (message) {
					_.each(properties,function (value,key) {
						if (!message[1].properties[key]) {
							message[1].properties[key] = value;
						} else if (_.isArray(message[1].properties[key])) {
							message[1].properties[key] = message[1].properties[key].concat(value||[]);
						} else if (typeof(message[1].properties[key]) === "string") {
							message[1].properties[key] = [].concat(message[1].properties[key],value||[]);
						} else {
							message[1].properties[key] = value;
						}
					});
					ret.push({index: message[0], uid: message[1].uid, properties: message[1].properties});
				});
				cb(null,ret);
			});
		},
		removeProperties : function (folder,messages,isUid,properties,cb) {
			var ret = [];
			// check that the folder exists
			if (!checkFolderExists(folder)) {return cb("Invalid folder");}
			this.getMessageRange(folder,messages, isUid, function (err,messages) {
				// make sure that the messages exist
				if (!messages || messages.length <= 0) {
					return cb("Invalid messages");
				}
				_.each(messages,function (message) {
					_.each(properties,function (value,key) {
						message[1].properties[key] = _.reduce([].concat(value||[]),function (list,toRemove) {
							return _.without(list,toRemove);
						},message[1].properties[key] || []);
					});
					ret.push({index: message[0], uid: message[1].uid, properties: message[1].properties});
				});
				cb(null,ret);
			});
			// callback without error, but with the new data
		},
		replaceProperties : function (folder,messages,isUid,properties,cb) {
			// check that the folder exists
			if (!checkFolderExists(folder)) {return cb("Invalid folder");}
			
			// now replace all of the flags
			this.getMessageRange(folder,messages, isUid, function (err,messages) {
				var ret = [];
				// make sure that the messages exist
				if (!messages || messages.length <= 0) {
					return cb("Invalid messages");
				}
				_.each(messages,function (message) {
					_.each(properties,function (value,key) {
						message[1].properties[key] = value;
					});
					ret.push({index: message[0], uid: message[1].uid, properties: message[1].properties});
				});
				cb(null,ret);
			});
		},
		listMessages: function (folder,cb) {
			cb();
		},
		searchMessages: function (folder,query,cb) {
			var results = search(folder,query);
			if (results) {
				cb(null,results);
			} else {
				cb("Bad search term");
			}
		},
		getMessages: function (folder,msg,cb) {
			cb(null,makeMessage());
		},
		getMessageRange: function (folder, range, isUid, cb) {
			var messages = folderCache[folder].messages || [];
			return cb(null,getMessageRange(messages,range,isUid,cb));
		},
		matchFolders : function(reference, match, callback) {
		    var includeINBOX = false;

		    if (reference === "" && referenceNamespace !== false) {
		        reference = referenceNamespace;
		        includeINBOX = true;
		    }

		    if (!data[reference]) {
		        return [];
		    }

		    var namespace = data[reference],
		        lookup = (reference || "") + match,
		        result = [];

		    var query = new RegExp("^" + lookup.
		        // escape regex symbols
		        replace(/([\\^$+?!.():=\[\]|,\-])/g, "\\$1").replace(/[*]/g, ".*").replace(/[%]/g, "[^" + (namespace.separator.replace(/([\\^$+*?!.():=\[\]|,\-])/g, "\\$1")) + "]*") +
		        "$",
		        "");

		    if (includeINBOX && ((reference ? reference + namespace.separator : "") + "INBOX").match(query)) {
		        result.push(folderCache.INBOX);
		    }

		    if (reference === "" && referenceNamespace !== false) {
		        reference = referenceNamespace;
		    }

		    Object.keys(folderCache).forEach(function(path) {
		        if (path.match(query) &&
		            (folderCache[path].flags.indexOf("\\NonExistent") < 0 || folderCache[path].path === match) &&
		            folderCache[path].namespace === reference) {
		            result.push(folderCache[path]);
		        }
		    });

		    callback(null,result);
		},
		subscribeFolder: function (path,callback) {
			if (!folderCache[path] || folderCache[path].flags.indexOf("\\Noselect") >= 0) {
				return callback("Invalid folder");
			}
			folderCache[path].subscribed = true;
			callback(null);
		},
		setFolderSpecialUse: function (path,attrs,callback) {
			if (folderCache[path]) {
				folderCache[path]["special-use"] = attrs;
			}
			callback();
		},
		expunge: function (folder, cb) {
		  var deleted = [],
			mailbox = folderCache[folder];
			if (!mailbox) {
				return cb("invalid mailbox");
			}
		      // old copy is required for those sessions that run FETCH before
		      // displaying the EXPUNGE notice
		      //mailboxCopy = [].concat(mailbox.messages);

		  for (var i = 0; i < mailbox.messages.length; i++) {
		      if (mailbox.messages[i].flags.indexOf("\\Deleted") >= 0) {
		          deleted.push(i+1);
		          mailbox.messages[i].ghost = true;
		          mailbox.messages.splice(i, 1);
		          i--;
		      }
		  }

			cb(null,{expunged: deleted, exists: mailbox.messages.length});
		},
	
		list: function (cb) {
			cb(null,["INBOX"]);
		},
		getNamespaces: function (cb) {
			var result = {personal: [], other: [], shared:[]};
			_.forOwn(data,function (value,key) {
				if (value && value.type && result[value.type]) {
					result[value.type].push({name: key, separator: value.separator});
				}
			});
			cb(null,result);
		},
		namespace: function (path,cb) {
	  	cb(null,data[path || referenceNamespace]);
		},
		delMessage: function (folder,id,cb) {
			cb();
		},
		moveMessage: function (folder,id,cb) {
			cb();
		},
		readMessage: function (folder,id,read,cb) {
			cb();
		},
		starMessage: function (folder,id,star,cb) {
			cb();
		}
	};
};


// the default test has no multiple mailboxes
module.exports = function (s) {
	server = s;
	return {
		mailbox: function (box,user,handlers) {
			messageHandlers = handlers;
			indexFolders();
			return makeMailbox();
		}
	};
};
module.exports.reset = function () {
	data = _.cloneDeep(rawData);
	indexFolders();
};
module.exports.load = function (d) {
	data = _.cloneDeep(d);
	indexFolders();
};

