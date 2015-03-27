var hoodiecrow = require("../lib/server"),
    mockClient = require("../lib/mock-client");

var IMAP_PORT = 4143,
    instance = 0;

module.exports["Rename"] = {
    setUp: function(done) {
        this.server = hoodiecrow({
            plugins: "XTOYBIRD",
            storage: {
                "": {
                    folders: {
                        "level1": {
                            folders: {
                                "level2": {
                                    folders: {
                                        "level3": {
                                            folders: {
                                                "level4": {
                                                    folders: {}
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        },
                        "level5": {
                            folders: {
                                "level6": {
                                    folders: {}
                                }
                            }
                        }
                    }
                },
                "#news.": {
                    type: "shared",
                    separator: "."
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

    "Rename success": function(test) {
        var message = "From: sender <sender@example.com>\r\nTo: receiver@example.com\r\nSubject: HELLO!\r\n\r\nWORLD!";
        var cmds = ["A1 CAPABILITY",
            "A2 LOGIN testuser testpass",
            "A3 RENAME level1/level2 level5/level2",
            "A4 LIST \"\" \"*\"",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.ok(resp.indexOf('\r\n* LIST (\\HasNoChildren) "/" "level1"\r\n') >= 0);
            test.ok(resp.indexOf('\r\n* LIST (\\HasNoChildren) "/" "level5/level2/level3/level4"\r\n') >= 0);
            test.done();
        }).bind(this));
    }
}