process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

var imapper = require("./resources/init"),
    mockClient = require("../lib/mock-client");

var IMAP_PORT = 4143,
    instance = 0;

module.exports["Normal login"] = {
    setUp: function(done) {
        this.server = imapper();

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
            "A2 LOGIN wrong pass",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf(" LOGINDISABLED") < 0);
            test.ok(resp.indexOf("\nA2 NO") >= 0);
            test.done();
        }).bind(this));
    },

    "Successful login": function(test) {
        var cmds = ["A1 CAPABILITY",
            "A2 LOGIN testuser testpass",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf(" LOGINDISABLED") < 0);
            test.ok(resp.indexOf("\nA2 OK") >= 0);
            test.done();
        }).bind(this));
    }
};

module.exports["LOGINDISABLED"] = {
    setUp: function(done) {
        this.server = imapper({
            plugins: ["STARTTLS", "LOGINDISABLED"]
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

    "Unencrypted login fail": function(test) {
        var cmds = ["A1 CAPABILITY",
            "A2 LOGIN testuser testpass",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf(" LOGINDISABLED") >= 0);
            test.ok(resp.indexOf("\nA2 BAD") >= 0);
            test.done();
        }).bind(this));
    },

    "Successful TLS login": function(test) {
        var cmds = ["A1 CAPABILITY",
            "A2 STARTTLS",
            "A3 LOGIN testuser testpass",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf(" LOGINDISABLED") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "LOGINDISABLED missing after STARTTLS": function(test) {
        var cmds = ["A1 STARTTLS",
            "A2 CAPABILITY",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf(" LOGINDISABLED") < 0);
            test.done();
        }).bind(this));
    }
};