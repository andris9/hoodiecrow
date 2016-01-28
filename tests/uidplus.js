var hoodiecrow = require("../lib/server"),
    mockClient = require("../lib/mock-client");

var IMAP_PORT = 4143,
    instance = 0;

module.exports["Hoodiecrow tests"] = {
    setUp: function(done) {
        this.server = hoodiecrow({
            plugins: "UIDPLUS",
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
                    }, {
                        raw: "Subject: hello 1\r\n\r\nWorld 2!"
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

    "UID EXPUNGE": function(test) {
        var cmds = ["A1 CAPABILITY",
            "A2 LOGIN testuser testpass",
            "A3 SELECT INBOX",
            "A4 UID EXPUNGE 2",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            // only the message we requested to expunge should be expunge
            test.ok(resp.indexOf("\r\n* 2 EXPUNGE\r\n") >= 0);
            // no exists message should be deleted (Note that there will be a
            // 2 EXISTS in there from the SELECT.  But this is the testing idiom
            // used by the existing expunge test.)
            test.ok(resp.indexOf("\r\n* 1 EXISTS\r\n") < 0);
            // let's make sure the server still has one message in there.
            test.equal(this.server.getMailbox("INBOX").messages.length, 1);
            test.done();
        }).bind(this));
    },

    "APPEND": function(test) {
        var message = "From: sender <sender@example.com>\r\nTo: receiver@example.com\r\nSubject: HELLO!\r\n\r\nWORLD!";
        var cmds = ["A1 CAPABILITY",
            "A2 LOGIN testuser testpass",
            "A3 SELECT INBOX",
            "A4 APPEND INBOX {" + message.length + "}\r\n" + message,
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\nA2 OK") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.ok(resp.indexOf("\nA4 OK [APPENDUID 1 3]") >= 0);
            test.done();
        }).bind(this));
    },

    "UID COPY STRING": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 UID COPY 1:* \"target\"",
            "A4 SELECT target",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\r\nA3 OK [COPYUID 1 1,2 2,3]") >= 0);
            test.equal((resp.match(/\* 3 EXISTS/mg) || []).length, 1);
            test.done();
        }).bind(this));
    },

    "UID COPY ATOM": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 UID COPY 1:* target",
            "A4 SELECT target",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\r\nA3 OK [COPYUID 1 1,2 2,3]") >= 0);
            test.equal((resp.match(/\* 3 EXISTS/mg) || []).length, 1);
            test.done();
        }).bind(this));
    }
};
