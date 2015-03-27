var hoodiecrow = require("../lib/server"),
    mockClient = require("../lib/mock-client");

var IMAP_PORT = 4143,
    instance = 0;

module.exports["Create"] = {
    setUp: function(done) {
        this.server = hoodiecrow({
            plugins: ["SPECIAL-USE", "CREATE-SPECIAL-USE"]
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

    "Create success": function(test) {
        var cmds = ["A1 CAPABILITY",
            "A2 LOGIN testuser testpass",
            "A3 CREATE MySpecial (USE (\\Sent \\Flagged))",
            "A4 LIST (SPECIAL-USE) \"\" \"*\"",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.ok(resp.indexOf('\n* LIST (\\HasNoChildren \\Sent \\Flagged) "/" "MySpecial"\r\n') >= 0);
            test.done();
        }).bind(this));
    },

    "Create fails": function(test) {
        var cmds = ["A1 CAPABILITY",
            "A2 LOGIN testuser testpass",
            "A3 CREATE MySpecial (USE (\\NotAllowed))",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\nA3 NO") >= 0);
            test.done();
        }).bind(this));
    }
}