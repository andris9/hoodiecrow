var imapper = require("./resources/init"),
    mockClient = require("../lib/mock-client"),
data = require('imapper-storage-memory');


var IMAP_PORT = 4143,
    instance = 0;

module.exports["imapper tests"] = {
    setUp: function(done) {
        this.server = imapper({
            plugins: ["ID", "STARTTLS" /*, "LOGINDISABLED"*/ , "AUTH-PLAIN", "NAMESPACE", "IDLE", "ENABLE", "CONDSTORE", "XTOYBIRD"]
        });
				data.load({
                "INBOX": {
                    messages: [{
                        raw: "Subject: hello 1\r\n\r\nWorld 1!",
                        internaldate: "14-Sep-2013 21:22:28 -0300"
                    }, {
                        raw: "Subject: hello 2\r\n\r\nWorld 2!",
                        flags: ["\\Seen"]
                    }, {
                        raw: "Subject: hello 3\r\n\r\nWorld 3!"
                    }, {
                        raw: "From: sender name <sender@example.com>\r\n" +
                            "To: Receiver name <receiver@example.com>\r\n" +
                            "Subject: hello 4\r\n" +
                            "Message-Id: <abcde>\r\n" +
                            "Date: Fri, 13 Sep 2013 15:01:00 +0300\r\n" +
                            "\r\n" +
                            "World 4!"
                    }, {
                        raw: "Subject: hello 5\r\n\r\nWorld 5!"
                    }, {
                        raw: "Subject: hello 6\r\n\r\nWorld 6!"
                    }]
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

    "Mark as Seen": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT INBOX",
            "A3 UID FETCH 2 BODY[]",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();

            test.ok(resp.indexOf('* 2 FETCH (BODY[] {28}\r\n' +
                'Subject: hello 2\r\n' +
                '\r\n' +
                'World 2! FLAGS (\\Seen) UID 2)\r\n') >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);

            test.done();
        }).bind(this));
    }
};
