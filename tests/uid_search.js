var imapper = require("./resources/init"),
    mockClient = require("../lib/mock-client"),
data = require('./resources/memory-storage-plugin'),
_ = require('lodash');

var IMAP_PORT = 4143,
    instance = 0,
MSGS = {
                "INBOX": {
                    messages: [{
                        raw: "Subject: hello 1\r\n\r\nWorld 1!",
                        internaldate: "14-Sep-2013 18:22:28 +0300",
                        flags: ["\\Flagged"],
												uid: 67
                    }, {
                        raw: "Subject: hello 2\r\nCC: test\r\n\r\nWorld 2!",
                        flags: ["\\Recent", "\\Seen", "MyFlag"],
												uid: 68
                    }, {
                        raw: "Subject: hello 3\r\nDate: Fri, 13 Sep 2013 15:01:00 +0300\r\nBCC: test\r\n\r\nWorld 3!",
                        flags: ["\\Draft"],
												uid: 69
                    }, {
                        raw: "From: sender name <sender@example.com>\r\n" +
                            "To: Receiver name <receiver@example.com>\r\n" +
                            "Subject: hello 4\r\n" +
                            "Message-Id: <abcde>\r\n" +
                            "Date: Fri, 13 Sep 2013 15:01:00 +0300\r\n" +
                            "\r\n" +
                            "World 4!",
                        internaldate: "13-Sep-2013 18:22:28 +0300",
												uid: 70
                    }, {
                        raw: "Subject: hello 5\r\nfrom: test\r\n\r\nWorld 5!",
                        flags: ["\\Deleted", "\\Recent"],
												uid: 71
                    }, {
                        raw: "Subject: hello 6\r\n\r\nWorld 6!",
                        flags: "\\Answered",
                        uid: 66
                    }]
                },
                "#news.": {
                    type: "shared",
                    separator: ".",
                    folders: {
                        "world": {}
                    }
                },
                "#juke?": {
                    type: "shared",
                    separator: "?"
                }
            };
		
var genSearch = function (isUid,query,expected,test,debug) {
	var uid = isUid?"UID ":"", middle = "A3 "+uid+"SEARCH "+query,
	cmds = ["A1 LOGIN testuser testpass",
      "A2 SELECT INBOX",
      middle,
      "ZZ LOGOUT"
  ], list = (isUid ? _.map(expected,function (item) {
  	return MSGS.INBOX.messages[item-1].uid;
  }) : expected||[]).join(" ");
	if (debug) {console.log(middle);}

  mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
      resp = resp.toString();
			if (debug) {console.log(resp);}
      test.ok(resp.indexOf("\n* SEARCH "+list+"\r\n") >= 0);
      test.ok(resp.indexOf("\nA3 OK") >= 0);
      test.done();
  }).bind(this));
};

module.exports["UID SEARCH tests"] = {
    setUp: function(done) {
        this.server = imapper({
            plugins: ["ID", "STARTTLS" /*, "LOGINDISABLED"*/ , "AUTH-PLAIN", "NAMESPACE", "IDLE", "ENABLE", "CONDSTORE", "XTOYBIRD"]
				});
				data.load(MSGS);

        this.instanceId = ++instance;
        this.server.listen(IMAP_PORT, (function() {
            done();
        }).bind(this));
    },

    tearDown: function(done) {
        this.server.close((function() {
            done();
        }).bind(this));
    },

    "UID SEARCH ALL": function(test) {
			genSearch(true,"ALL",[1,2,3,4,5,6],test);
    },

    "UID SEARCH <SEQUENCE>": function(test) {
			genSearch(true,"1:3,5:*",[1,2,3,5,6],test);
    },

    "UID SEARCH OR": function(test) {
			genSearch(true,"OR KEYWORD \"MyFlag\" 5:6",[2,5,6],test);
    },

    "UID SEARCH ANSWERED": function(test) {
			genSearch(true,"ANSWERED",[6],test);
    },

    "UID SEARCH BCC": function(test) {
			genSearch(true,"BCC \"test\"",[3],test);
    },

    "UID SEARCH BEFORE": function(test) {
			genSearch(true,"BEFORE \"14-Sep-2013\"",[4],test);
    },

    "UID SEARCH BODY": function(test) {
			genSearch(true,"BODY \"World 3\"",[3],test);
    },

    "UID SEARCH CC": function(test) {
			genSearch(true,"CC \"test\"",[2],test);
    },

    "UID SEARCH DELETED": function(test) {
			genSearch(true,"DELETED",[5],test);
    },

    "UID SEARCH DRAFT": function(test) {
			genSearch(true,"DRAFT",[3],test);
    },

    "UID SEARCH FLAGGED": function(test) {
			genSearch(true,"FLAGGED",[1],test);
    },

    "UID SEARCH FROM": function(test) {
			genSearch(true,"FROM \"test\"",[5],test);
    },

    "UID SEARCH HEADER": function(test) {
			genSearch(true,"HEADER \"message-id\" \"abcd\"",[4],test);
    },

    "UID SEARCH KEYWORD": function(test) {
			genSearch(true,"KEYWORD \"MyFlag\"",[2],test);
    },

    "UID SEARCH LARGER": function(test) {
			genSearch(true,"LARGER 34",[2,3,4,5],test);
    },

    "UID SEARCH NEW": function(test) {
			genSearch(true,"NEW",[5],test);
    },

    "UID SEARCH RECENT UNSEEN": function(test) {
			genSearch(true,"RECENT UNSEEN",[5],test);
    },

    "UID SEARCH NOT": function(test) {
			genSearch(true,"NOT KEYWORD \"MyFlag\"",[1,3,4,5,6],test);
    },

    "UID SEARCH OLD": function(test) {
			genSearch(true,"OLD",[1,3,4,6],test);
    },

    "UID SEARCH NOT RECENT": function(test) {
			genSearch(true,"NOT RECENT",[1,3,4,6],test);
    },

    "UID SEARCH ON": function(test) {
			genSearch(true,"ON \"14-Sep-2013\"",[1],test);
    },

    "UID SEARCH RECENT": function(test) {
			genSearch(true,"RECENT",[2,5],test);
    },

    "UID SEARCH SEEN": function(test) {
			genSearch(true,"SEEN",[2],test);
    },

    "UID SEARCH SENTBEFORE": function(test) {
			genSearch(true,"SENTBEFORE \"14-Sep-2013\"",[3,4],test);
    },

    "UID SEARCH SENTON": function(test) {
			genSearch(true,"SENTON \"13-Sep-2013\"",[3,4],test);
    },

    "UID SEARCH SENTSINCE": function(test) {
			genSearch(true,"SENTSINCE \"14-Sep-2013\"",[1,2,5,6],test);
    },

    "UID SEARCH SINCE": function(test) {
			genSearch(true,"SINCE \"14-Sep-2013\"",[1,2,3,5,6],test);
    },

    "UID SEARCH SMALLER": function(test) {
			genSearch(true,"SMALLER 34",[1,6],test);
    },

    "UID SEARCH SUBJECT": function(test) {
			genSearch(true,"SUBJECT \"hello 2\"",[2],test);
    },

    "UID SEARCH TEXT first": function(test) {
			genSearch(true,"TEXT \"hello 2\"",[2],test);
    },

    "UID SEARCH TEXT second": function(test) {
			genSearch(true,"TEXT \"world 5\"",[5],test);
    },

    "UID SEARCH TO": function(test) {
			genSearch(true,"TO \"receiver\"",[4],test);
    },

    "UID SEARCH UID single": function(test) {
			genSearch(true,"UID 66",[6],test);
    },

    "UID SEARCH UID all": function(test) {
			genSearch(true,"UID 1:*",[1,2,3,4,5,6],test);
    },

    "UID SEARCH UNANSWERED": function(test) {
			genSearch(true,"UNANSWERED",[1,2,3,4,5],test);
    },

    "UID SEARCH UNDELETED": function(test) {
			genSearch(true,"UNDELETED",[1,2,3,4,6],test);
    },

    "UID SEARCH UNDRAFT": function(test) {
			genSearch(true,"UNDRAFT",[1,2,4,5,6],test);
    },

    "UID SEARCH UNFLAGGED": function(test) {
			genSearch(true,"UNFLAGGED",[2,3,4,5,6],test);
    },

    "UID SEARCH UNKEYWORD": function(test) {
			genSearch(true,"UNKEYWORD \"MyFlag\"",[1,3,4,5,6],test);
    },

    "UID SEARCH UNSEEN": function(test) {
			genSearch(true,"UNSEEN",[1,3,4,5,6],test);
    },

    "UID SEARCH INVALID": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 UID SEARCH ABCDE",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\nA3 NO") >= 0);
            test.done();
        }).bind(this));
    }
	};
