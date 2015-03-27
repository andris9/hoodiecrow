var hoodiecrow = require("../lib/server"),
    mockClient = require("../lib/mock-client");

var IMAP_PORT = 4143,
    instance = 0;

module.exports["Hoodiecrow tests"] = {
    setUp: function(done) {
        this.server = hoodiecrow({
            plugins: "UNSELECT",
            id: {
                name: "hoodiecrow",
                version: "0.1"
            },
            storage: {
                "INBOX": {
                    messages: [{
                        raw: "Subject: hello 1\r\n\r\nWorld 1!",
                        internaldate: "14-Sep-2013 21:22:28 -0300",
                        flags: "\\Deleted"
                    }]
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

    "CLOSE and \\Deleted": function(test) {
        var cmds = ["A1 CAPABILITY",
            "A2 LOGIN testuser testpass",
            "A3 SELECT INBOX",
            "A4 EXPUNGE",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\r\n* 1 EXPUNGE\r\n") >= 0);
            test.ok(resp.indexOf("\r\n* 0 EXISTS\r\n") < 0);
            test.done();
        }).bind(this));
    }
}