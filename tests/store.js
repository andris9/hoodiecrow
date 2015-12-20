var imapper = require("./resources/init"),
    mockClient = require("../lib/mock-client"),
		data = require('./resources/memory-storage-plugin');

var IMAP_PORT = 4143,
    instance = 0;

module.exports["imapper tests"] = {
    setUp: function(done) {
        this.server = imapper({});
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

    "Add flags": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 STORE 1 +FLAGS (\\Deleted)",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.ok(resp.indexOf("FLAGS (\\Seen \\Deleted)") >= 0);

            test.done();
        }).bind(this));
    },

    "Invalid system flag": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 STORE 1 +FLAGS (\\XNotValid)",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\nA3 BAD") >= 0);
            test.ok(resp.indexOf("FLAGS (\\Seen \\XNotValid)") < 0);

            test.done();
        }).bind(this));
    },

    "Custom flag": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 STORE 1 +FLAGS (\"Custom Flag\")",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();

            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.ok(resp.indexOf("FLAGS (\\Seen \"Custom Flag\")") >= 0);

            test.done();
        }).bind(this));
    },

    "Remove flags": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 STORE 2 -FLAGS (\\Seen)",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();

            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.ok(resp.indexOf("FLAGS (\\Deleted)") >= 0);

            test.done();
        }).bind(this));
    },

    "Set flags": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 STORE 2 FLAGS (MyFlag $My$Flag)",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();

            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.ok(resp.indexOf("(FLAGS (MyFlag $My$Flag))") >= 0);

            test.done();
        }).bind(this));
    },

    "Add flags silent": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 STORE 1 +FLAGS.SILENT (\\Deleted)",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();

            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.ok(resp.indexOf("FLAGS (\\Seen \\Deleted)") < 0);

            test.done();
        }).bind(this));
    },

    "Remove flags silent": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 STORE 2 -FLAGS.SILENT (\\Seen)",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();

            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.ok(resp.indexOf("FLAGS (\\Deleted)") < 0);

            test.done();
        }).bind(this));
    },

    "Set flags silent": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 STORE 2 FLAGS.SILENT (MyFlag $My$Flag)",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();

            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.ok(resp.indexOf("(FLAGS (MyFlag $My$Flag))") < 0);

            test.done();
        }).bind(this));
    }
};

module.exports["Custom flags not allowed"] = {
    setUp: function(done) {
        this.server = imapper({});
				data.load({
                "INBOX": {
                    allowPermanentFlags: false,
                    messages: [{
                        raw: "Subject: hello 1\r\n\r\nWorld 1!",
                        flags: ["\\Seen"]
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

    "System flag": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 STORE 1 +FLAGS (\\Deleted)",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();

            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.ok(resp.indexOf("FLAGS (\\Seen \\Deleted)") >= 0);

            test.done();
        }).bind(this));
    },

    "Custom flag": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 STORE 1 +FLAGS (\"Custom Flag\")",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();

            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.ok(resp.indexOf("FLAGS (\\Seen)") >= 0);

            test.done();
        }).bind(this));
    }
};
