var hoodiecrow = require("../lib/server"),
    mockClient = require("../lib/mock-client");

var IMAP_PORT = 4143,
    instance = 0;

module.exports["Literalplus disabled"] = {
    setUp: function(done) {
        this.server = hoodiecrow();

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

    "Invalid Login": function(test) {
        var cmds = ["A1 CAPABILITY",
            "A2 LOGIN {8+}\r\ntestuser {8+}\r\ntestpass",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf(" LITERAL+") < 0);
            test.ok(resp.indexOf("\nA2 BAD") >= 0);
            test.done();
        }).bind(this));
    }
}

module.exports["Literalplus enabled"] = {
    setUp: function(done) {
        this.server = hoodiecrow({
            plugins: "literalplus"
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

    "Login success regular": function(test) {
        var cmds = ["A1 CAPABILITY",
            "A2 LOGIN {8}\r\ntestuser {8}\r\ntestpass",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\r\n+") >= 0);
            test.ok(resp.indexOf(" LITERAL+") >= 0);
            test.ok(resp.indexOf("\nA2 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "Login success literalplus": function(test) {
        var cmds = ["A1 CAPABILITY",
            "A2 LOGIN {8+}\r\ntestuser {8+}\r\ntestpass",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\r\n+") < 0);
            test.ok(resp.indexOf(" LITERAL+") >= 0);
            test.ok(resp.indexOf("\nA2 OK") >= 0);
            test.done();
        }).bind(this));
    }
}