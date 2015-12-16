var imapper = require("./resources/init"),
    mockClient = require("../lib/mock-client");

var IMAP_PORT = 4143,
    instance = 0;

module.exports["Search tests"] = {
    setUp: function(done) {
        this.server = imapper({
            plugins: ["ID", "STARTTLS" /*, "LOGINDISABLED"*/ , "AUTH-PLAIN", "NAMESPACE", "IDLE", "ENABLE", "CONDSTORE", "XTOYBIRD"],
            id: {
                name: "imapper",
                version: "0.1"
            },
            storage: {
                "INBOX": {
                    messages: [{
                        raw: "Subject: hello 1\r\n\r\nWorld 1!",
                        internaldate: "14-Sep-2013 18:22:28 +0300",
                        flags: ["\\Flagged"]
                    }, {
                        raw: "Subject: hello 2\r\nCC: test\r\n\r\nWorld 2!",
                        flags: ["\\Recent", "\\Seen", "MyFlag"]
                    }, {
                        raw: "Subject: hello 3\r\nDate: Fri, 13 Sep 2013 15:01:00 +0300\r\nBCC: test\r\n\r\nWorld 3!",
                        flags: ["\\Draft"]
                    }, {
                        raw: "From: sender name <sender@example.com>\r\n" +
                            "To: Receiver name <receiver@example.com>\r\n" +
                            "Subject: hello 4\r\n" +
                            "Message-Id: <abcde>\r\n" +
                            "Date: Fri, 13 Sep 2013 15:01:00 +0300\r\n" +
                            "\r\n" +
                            "World 4!",
                        internaldate: "13-Sep-2013 18:22:28 +0300"
                    }, {
                        raw: "Subject: hello 5\r\nfrom: test\r\n\r\nWorld 5!",
                        flags: ["\\Deleted", "\\Recent"]
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
            }
        });

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

    "SEARCH ALL": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH ALL",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 1 2 3 4 5 6\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH ANSWERED": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH ANSWERED",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 6\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH <SEQUENCE>": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH 1:3,5:*",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 1 2 3 5 6\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH BCC": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH BCC \"test\"",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 3\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH BEFORE": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH BEFORE \"14-Sep-2013\"",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 4\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH BODY": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH BODY \"World 3\"",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 3\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH CC": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH CC \"test\"",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 2\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH DELETED": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH DELETED",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 5\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH DRAFT": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH DRAFT",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 3\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH FLAGGED": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH FLAGGED",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 1\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH FROM": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH FROM \"test\"",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 5\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH HEADER": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH HEADER \"message-id\" \"abcd\"",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 4\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH KEYWORD": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH KEYWORD \"MyFlag\"",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 2\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH LARGER": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH LARGER 34",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 2 3 4 5\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH NEW": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH NEW",
            "A3 SEARCH RECENT UNSEEN",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.equal((resp.match(/\n\* SEARCH 5\r\n/g) || []).length, 2);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH NOT": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH NOT KEYWORD \"MyFlag\"",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 1 3 4 5 6\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH OLD": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH OLD",
            "A3 SEARCH NOT RECENT",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.equal((resp.match(/\n\* SEARCH 1 3 4 6\r\n/g) || []).length, 2);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH ON": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH ON \"14-Sep-2013\"",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 1\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH OR": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH OR KEYWORD \"MyFlag\" 5:6",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 2 5 6\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH RECENT": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH RECENT",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 2 5\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH SEEN": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH SEEN",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 2\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH SENTBEFORE": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH SENTBEFORE \"14-Sep-2013\"",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 3 4\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH SENTON": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH SENTBEFORE \"13-Sep-2013\"",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 3 4\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH SENTSINCE": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH SENTSINCE \"14-Sep-2013\"",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 1 2 5 6\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH SINCE": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH SINCE \"14-Sep-2013\"",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 1 2 3 5 6\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH SMALLER": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH SMALLER 34",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 1 6\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH SUBJECT": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH SUBJECT \"hello 2\"",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 2\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH TEXT": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH TEXT \"hello 2\"",
            "A4 SEARCH TEXT \"world 5\"",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 2\r\n") >= 0);
            test.ok(resp.indexOf("\n* SEARCH 5\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.ok(resp.indexOf("\nA4 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH TO": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH TO \"receiver\"",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 4\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH UID": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH UID 66",
            "A4 SEARCH UID 1:*",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 6\r\n") >= 0);
            test.ok(resp.indexOf("\n* SEARCH 1 2 3 4 5 6\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.ok(resp.indexOf("\nA4 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH UNANSWERED": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH UNANSWERED",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 1 2 3 4 5\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH UNDELETED": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH UNDELETED",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 1 2 3 4 6\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH UNDRAFT": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH UNDRAFT",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 1 2 4 5 6\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH UNFLAGGED": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH UNFLAGGED",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 2 3 4 5 6\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH UNKEYWORD": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH UNKEYWORD \"MyFlag\"",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 1 3 4 5 6\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH UNSEEN": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH UNSEEN",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 1 3 4 5 6\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH INVALID": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH ABCDE",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\nA3 NO") >= 0);
            test.done();
        }).bind(this));
    }
};
