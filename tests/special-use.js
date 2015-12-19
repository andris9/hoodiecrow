var imapper = require("./resources/init"),
    mockClient = require("../lib/mock-client"),
data = require('./resources/memory-storage-plugin');


var IMAP_PORT = 4143,
    instance = 0;

module.exports["Special-use"] = {
    setUp: function(done) {
        this.server = imapper({
            plugins: ["SPECIAL-USE"]
        });
				data.load({
                "": {
                    folders: {
                        "INBOX": {
                            "special-use": "\\Inbox",
                            messages: []
                        },
                        "Test": {
                            subscribed: false
                        },
                        "Sent mail": {
                            "special-use": ["\\Sent", "\\Drafts"],
                            subscribed: false
                        }
                    }
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

    "LIST NORMAL": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 CAPABILITY",
            "A3 LIST \"\" \"*\"",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.equal((resp.match(/^\* LIST\b/mg) || []).length, 3);
            test.ok(resp.indexOf('\n* LIST (\\HasNoChildren) "/" "INBOX"\r\n') >= 0);
            test.ok(resp.indexOf('\n* LIST (\\HasNoChildren) "/" "Test"\r\n') >= 0);
            test.ok(resp.indexOf('\n* LIST (\\HasNoChildren \\Sent \\Drafts) "/" "Sent mail"\r\n') >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "LIST (SPECIAL-USE)": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 CAPABILITY",
            "A3 LIST (SPECIAL-USE) \"\" \"*\"",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.equal((resp.match(/^\* LIST\b/mg) || []).length, 1);
            test.ok(resp.indexOf('\n* LIST (\\HasNoChildren \\Sent \\Drafts) "/" "Sent mail"\r\n') >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "LIST RETURN (SPECIAL-USE)": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 CAPABILITY",
            "A3 LIST \"\" \"*\" RETURN (SPECIAL-USE)",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.equal((resp.match(/^\* LIST\b/mg) || []).length, 3);
            test.ok(resp.indexOf('\n* LIST () "/" "INBOX"\r\n') >= 0);
            test.ok(resp.indexOf('\n* LIST () "/" "Test"\r\n') >= 0);
            test.ok(resp.indexOf('\n* LIST (\\Sent \\Drafts) "/" "Sent mail"\r\n') >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "LIST (SPECIAL-USE) RETURN (SPECIAL-USE)": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 CAPABILITY",
            "A3 LIST (SPECIAL-USE) \"\" \"*\" RETURN (SPECIAL-USE)",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.equal((resp.match(/^\* LIST\b/mg) || []).length, 1);
            test.ok(resp.indexOf('\n* LIST (\\Sent \\Drafts) "/" "Sent mail"\r\n') >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    }
};


module.exports["No Special-use"] = {
    setUp: function(done) {
        this.server = imapper({});
				data.load({
                "": {
                    folders: {
                        "INBOX": {
                            "special-use": "\\Inbox",
                            messages: []
                        },
                        "Test": {
                            subscribed: false
                        },
                        "Sent mail": {
                            "special-use": ["\\Sent", "\\Drafts"],
                            subscribed: false
                        }
                    }
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

    "LIST NORMAL": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 CAPABILITY",
            "A3 LIST \"\" \"*\"",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.equal((resp.match(/^\* LIST\b/mg) || []).length, 3);
            test.ok(resp.indexOf('\n* LIST (\\HasNoChildren) "/" "INBOX"\r\n') >= 0);
            test.ok(resp.indexOf('\n* LIST (\\HasNoChildren) "/" "Test"\r\n') >= 0);
            test.ok(resp.indexOf('\n* LIST (\\HasNoChildren) "/" "Sent mail"\r\n') >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "LIST (SPECIAL-USE)": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 CAPABILITY",
            "A3 LIST (SPECIAL-USE) \"\" \"*\"",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\nA3 BAD") >= 0);
            test.done();
        }).bind(this));
    },

    "LIST RETURN (SPECIAL-USE)": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 CAPABILITY",
            "A3 LIST \"\" \"*\" RETURN (SPECIAL-USE)",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\nA3 BAD") >= 0);
            test.done();
        }).bind(this));
    },

    "LIST (SPECIAL-USE) RETURN (SPECIAL-USE)": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 CAPABILITY",
            "A3 LIST (SPECIAL-USE) \"\" \"*\" RETURN (SPECIAL-USE)",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\nA3 BAD") >= 0);
            test.done();
        }).bind(this));
    }
};