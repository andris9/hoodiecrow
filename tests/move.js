var hoodiecrow = require("../lib/server"),
    mockClient = require("../lib/mock-client");

var IMAP_PORT = 4143,
    instance = 0;

module.exports["Hoodiecrow tests"] = {
    setUp: function(done) {
        this.server = hoodiecrow({
            plugins: ["UIDPLUS", "MOVE"],
            id: {
                name: "hoodiecrow",
                version: "0.1"
            },
            storage: {
                "INBOX": {
                    messages: [{
                        raw: "Subject: hello 1\r\n\r\nWorld 1!",
                        internaldate: "14-Sep-2013 21:22:28 -0300"
                    }, {
                        raw: "Subject: hello 1\r\n\r\nWorld 2!"
                    }, {
                        raw: "Subject: hello 1\r\n\r\nWorld 3!"
                    }]
                },
                "": {
                    folders: {
                        "target": {
                            messages: [{
                                raw: "Subject: hello 3\r\n\r\nWorld 3!"
                            }]
                        }
                    }
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

    "MOVE": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 MOVE 1:2 \"target\"",
            "A4 SELECT target",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\r\n* OK [COPYUID 1 1,2 2,3]") >= 0);
            test.equal(this.server.getMailbox("INBOX").messages.length, 1);
            test.equal(this.server.getMailbox("target").messages.length, 3);
            test.done();
        }).bind(this));
    },

    "UID MOVE": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 UID MOVE 1:2 target",
            "A4 SELECT target",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\r\n* OK [COPYUID 1 1,2 2,3]") >= 0);
            test.equal(this.server.getMailbox("INBOX").messages.length, 1);
            test.equal(this.server.getMailbox("target").messages.length, 3);
            test.done();
        }).bind(this));
    }
};
