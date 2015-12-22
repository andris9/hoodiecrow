var imapper = require("./resources/init"),
    mockClient = require("../lib/mock-client"),
		data = require('./resources/memory-storage-plugin');

var IMAP_PORT = 4143,
    instance = 0;

module.exports["imapper tests"] = {
    setUp: function(done) {
        this.server = imapper({
            plugins: ["X-GM-EXT-1"]
        });
				data.load({
                "INBOX": {
                    messages: [{
                        raw: "Subject: hello 1\r\n\r\nWorld 1!",
                        flags: ["\\Seen"]
                    }, {
                        raw: "Subject: hello 1\r\n\r\nWorld 1!",
                        flags: ["\\Seen", "\\Deleted"]
                    }]
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

    "FETCH X-GM-MSGID": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 FETCH 1:2 X-GM-MSGID",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.ok(resp.indexOf("\n* 1 FETCH (X-GM-MSGID 1278455344230334866)\r\n" +
                "* 2 FETCH (X-GM-MSGID 1278455344230334867)\r\n") >= 0);

            test.done();
        }).bind(this));
    },

    "SEARCH X-GM-MSGID": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 SEARCH X-GM-MSGID 1278455344230334867",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.ok(resp.indexOf("\n* SEARCH 2\r\n") >= 0);

            test.done();
        }).bind(this));
    },

    "SEARCH X-GM-LABELS": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 FETCH 1:2 X-GM-LABELS",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.ok(resp.indexOf("\n* 1 FETCH (X-GM-LABELS (\\Inbox))\r\n" +
                "* 2 FETCH (X-GM-LABELS (\\Inbox))\r\n") >= 0);

            test.done();
        }).bind(this));
    },

    "STORE +X-GM-LABELS": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 STORE 1 +X-GM-LABELS (foo)",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.ok(resp.indexOf("\n* 1 FETCH (X-GM-LABELS (\\Inbox foo))\r\n") >= 0);

            test.done();
        }).bind(this));
    },

    "STORE -X-GM-LABELS": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 STORE 1 -X-GM-LABELS (\\Inbox)",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.ok(resp.indexOf("\n* 1 FETCH (X-GM-LABELS ())\r\n") >= 0);

            test.done();
        }).bind(this));
    },

    "STORE X-GM-LABELS": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 STORE 1 X-GM-LABELS (tere vana \"kere pere\")",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.ok(resp.indexOf("\n* 1 FETCH (X-GM-LABELS (tere vana \"kere pere\"))\r\n") >= 0);

            test.done();
        }).bind(this));
    }
};
