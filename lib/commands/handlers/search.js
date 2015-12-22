"use strict";
var _ = require('lodash');

/* 
 given a set of messages (messageSource) and search terms (params),
 search in messageSource for those that match params

 In other words, this handler does two things:
 1- parse params into an intelligent search query
 2- use the search query on the messages

 For this to work with a plugin and asynchronously, we need to have this do the first part - parse the params - 
   without messages, and then hand the parsed query to a plugin that can handle it
 */
module.exports = function(params) {
	var result,
        query,

        charset,

        queryParams = {
            "BCC": ["VALUE"],
            "BEFORE": ["VALUE"],
            "BODY": ["VALUE"],
            "CC": ["VALUE"],
            "FROM": ["VALUE"],
            "HEADER": ["VALUE", "VALUE"],
            "KEYWORD": ["VALUE"],
            "LARGER": ["VALUE"],
            "NOT": ["COMMAND"],
            "ON": ["VALUE"],
            "OR": ["COMMAND", "COMMAND"],
            "SENTBEFORE": ["VALUE"],
            "SENTON": ["VALUE"],
            "SENTSINCE": ["VALUE"],
            "SINCE": ["VALUE"],
            "SMALLER": ["VALUE"],
            "SUBJECT": ["VALUE"],
            "TEXT": ["VALUE"],
            "TO": ["VALUE"],
            "UID": ["VALUE"],
            "UNKEYWORD": ["VALUE"]
        },

        composeQuery = function(params) {
            params = [].concat(params || []);

            var pos = 0,
                param,
                returnParams = [];

            var getParam = function(level) {
                level = level || 0;
                if (pos >= params.length) {
                    return undefined;
                }

                var param = params[pos++],
                    paramTypes = queryParams[param.toUpperCase()] || [],
                    paramCount = paramTypes.length,
                    curParams = [param.toUpperCase()];

                if (paramCount) {
                    for (var i = 0, len = paramCount; i < len; i++) {
                        switch (paramTypes[i]) {
                            case "VALUE":
                                curParams.push(params[pos++]);
                                break;
                            case "COMMAND":
                                curParams.push(getParam(level + 1));
                                break;
                        }
                    }
                }
                return curParams;
            };

            while (typeof(param = getParam()) !== "undefined") {
                returnParams.push(param);
            }

            return returnParams;
        },
				
				sendFlag = function (flags,negate) {
					var val = _.map([].concat(flags||[]),function (f) {
						return negate ? {not:f} : f;
					});
					return ({flags:val});
				},
				sendHeader = function (header,value,negate) {
					var val = negate ? {not:value} : value, headers = {};
					headers[header] = val;
					return {headers: headers};
				},

        queryHandlers = {
            "_SEQ": function(params) {
							return ({index:params[0]});
            },
            "ALL": function() {
              return ({index:"1:*"});
            },
            "ANSWERED": function(params,negate) {
							return sendFlag("\\Answered",negate);
            },
            "BCC": function(params,negate) {
							return sendHeader("bcc",params[0],negate);
            },
            "BEFORE": function(params) {
							return ({date:{"lt":params[0]}});
            },
            "BODY": function(params,negate) {
							return {body: negate ? {not:params[0]} : params[0]};
            },
            "CC": function(params,negate) {
							return sendHeader("cc",params[0],negate);
            },
            "DELETED": function(params,negate) {
							return sendFlag("\\Deleted",negate);
            },
            "DRAFT": function(params,negate) {
							return sendFlag("\\Draft",negate);
            },
            "FLAGGED": function(params,negate) {
							return sendFlag("\\Flagged",negate);
            },
            "FROM": function(params,negate) {
							return sendHeader("from",params[0],negate);
            },
            "HEADER": function(params, negate) {
							return sendHeader(params[0],params[1] || "",negate);
            },
            "KEYWORD": function(params,negate) {
							return sendFlag(params[0],negate);
            },
            "LARGER": function(params,negate) {
							var ret = {size:{}}, key = negate?"lt":"gt";
							ret.size[key] = params[0];
							return ret;
            },
            "NEW": function(params,negate) {
							return negate ? {flags:{or:[{not:"\\Recent"},"\\Seen"]}} : {flags:["\\Recent",{not:"\\Seen"}]};
            },
            "NOT": function(params) {
							var q = params[0];
							// first check if we have a normal handler for it
                if (!queryHandlers[q[0]] && q[0].match(/^[\d\,\:\*]+$/)) {
                    q.unshift("_SEQ");
                } else if (!queryHandlers[q[0]]) {
                    throw new Error("NO Invalid query element: " + q[0] + " (Failure)");
                }

								// second, apply the nomal handler but tell it we are negating
                return queryHandlers[q.shift()](q,true);
            },
            "OLD": function(params,negate) {
							return sendFlag("\\Recent",!negate);
            },
            "ON": function(params) {
							return ({date:{"eq":params[0]}});
            },
            "OR": function(params) {
							var left = params[0], right = params[1],
							jointResult = [], leftResults, rightResults, leftQuery = left[0], rightQuery = right[0], key;

                if (!queryHandlers[leftQuery] && leftQuery.match(/^[\d\,\:\*]+$/)) {
                    left.unshift("_SEQ");
                } else if (!queryHandlers[leftQuery]) {
                    throw new Error("NO Invalid query element: " + left[0] + " (Failure)");
                }

                if (!queryHandlers[rightQuery] && rightQuery.match(/^[\d\,\:\*]+$/)) {
                    right.unshift("_SEQ");
                } else if (!queryHandlers[right[0]]) {
                    throw new Error("NO Invalid query element: " + right[0] + " (Failure)");
                }

                leftResults = queryHandlers[left.shift()](left);
                rightResults = queryHandlers[right.shift()](right);
								
								// now we have to see if we match them in the special headers or flags case
								if (!leftResults) {
									jointResult = rightResults;
								} else if (!rightResults) {
									jointResult = leftResults;
								} else if (leftResults.headers && rightResults.headers) {
									// if the actual headers match, we need to make an array join, rather than merge
									if (leftQuery === rightQuery) {
										// get the key from the first one
										key = _.keys(leftResults.headers)[0];
										leftResults.headers = {or: [leftResults.headers[0],rightResults.headers[0]]};
										jointResult = leftResults;
									} else {
										leftResults.headers = _.extend(leftResults.headers,rightResults.headers);
										jointResult = {headers: {or: leftResults.headers}};
									}
								} else if (leftResults.flags && rightResults.flags) {
									jointResult = {flags: {or:leftResults.flags.concat(rightResults.flags)}};
								} else {
									// merge them together outright
									jointResult = {or:_.extend(leftResults,rightResults)};
								}

                return jointResult;
            },
            "RECENT": function(params,negate) {
							return sendFlag("\\Recent",negate);
            },
            "SEEN": function(params,negate) {
							return sendFlag("\\Seen",negate);
            },
            "SENTBEFORE": function(params) {
							return {headers:{sent:{lt:params[0]}}};
            },
            "SENTON": function(params) {
							return {headers:{sent:{eq:params[0]}}};
            },
            "SENTSINCE": function(params) {
							return {headers:{sent:{gt:params[0]}}};
            },
            "SINCE": function(params) {
							return ({date:{"gt":params[0]}});
            },
            "SMALLER": function(params,negate) {
							var ret = {size:{}}, key = negate?"gt":"lt";
							ret.size[key] = params[0];
							return ret;
            },
            "SUBJECT": function(params,negate) {
							return sendHeader("subject",params[0],negate);
            },
            "TEXT": function(params,negate) {
							return {text: negate ? {not:params[0]} : params[0]};
            },
            "TO": function(params,negate) {
							return sendHeader("to",params[0],negate);
            },
            "UID": function(params) {
							return {uid:params[0]};
            },
            "UNANSWERED": function(params,negate) {
							return sendFlag("\\Answered",!negate);
            },
            "UNDELETED": function(params,negate) {
							return sendFlag("\\Deleted",!negate);
            },
            "UNDRAFT": function(params,negate) {
							return sendFlag("\\Draft",!negate);
            },
            "UNFLAGGED": function(params,negate) {
							return sendFlag("\\Flagged",!negate);
            },
            "UNKEYWORD": function(flag,negate) {
							return sendFlag(flag,!negate);
            },
            "UNSEEN": function(params,negate) {
							return sendFlag("\\Seen",!negate);
            }
        };


    // FIXME: charset is currently ignored
    if ((params[0] || "").toString().toUpperCase() === "CHARSET") {
        params.shift(); // CHARSET
        charset = params.shift(); // value
    }

    query = composeQuery(params);
		try {
	    result = _.map(query,function(q) {
	        if (!queryHandlers[q[0]] && q[0].match(/^[\d\,\:\*]+$/)) {
	            q.unshift("_SEQ");
	        } else if (!queryHandlers[q[0]]) {
	            throw new Error("NO Invalid query element: " + q[0] + " (Failure)");
	        }

	        var key = q.shift(),
					handler = queryHandlers[key];
					return handler && handler(q) || null;
	    });

			// now need to put them together
			result = _.reduce(result,function (summary,item) {
				// copy each item over to summary, unless it already exists, in which case join it
				// remember that all items in result are meant to be AND together unless we hear otherwise
				_.forIn(item,function (value,key) {
					if (summary[key] === undefined) {
						// if it does not exist, just copy it over
						summary[key] = value;
					} else {
						// if it does exist, it depends if it is an array
						if (_.isArray(value) && _.isArray(summary[key])) {
							summary[key].push.apply(summary[key],value);
						}
					
					}
				});
				return summary;
			},{});


		} catch (e) {
			result = null;
		}

		// result now is an array with the object representing each search

		return result;
};