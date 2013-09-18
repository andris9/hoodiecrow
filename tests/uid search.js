var hoodiecrow = require("../lib/server"),
    mockClient = require("../lib/mock-client");

var IMAP_PORT = 4143,
    instance = 0;

module.exports["Search tests"] = {
    setUp: function(done){
        this.server = hoodiecrow({
            plugins: ["ID", "STARTTLS"/*, "LOGINDISABLED"*/, "AUTH-PLAIN", "NAMESPACE", "IDLE", "ENABLE", "CONDSTORE", "XTOYBIRD"],
            id:{
                name: "hoodiecrow",
                version: "0.1"
            },
            storage:{
                "":{
                    folders: {
                        "INBOX":{
                            messages: [
                                {raw: "Subject: hello 1\r\n\r\nWorld 1!", internaldate: "14-Sep-2013 18:22:28 +0300", flags: ["\\Flagged"]},
                                {raw: "Subject: hello 2\r\nCC: test\r\n\r\nWorld 2!", flags: ["\\Recent", "\\Seen", "MyFlag"]},
                                {raw: "Subject: hello 3\r\nDate: Fri, 13 Sep 2013 15:01:00 +0300\r\nBCC: test\r\n\r\nWorld 3!", flags: ["\\Draft"]},
                                {raw: "From: sender name <sender@example.com>\r\n"+
                                    "To: Receiver name <receiver@example.com>\r\n"+
                                    "Subject: hello 4\r\n"+
                                    "Message-Id: <abcde>\r\n"+
                                    "Date: Fri, 13 Sep 2013 15:01:00 +0300\r\n"+
                                    "\r\n"+
                                    "World 4!",
                                    internaldate: "13-Sep-2013 18:22:28 +0300"},
                                {raw: "Subject: hello 5\r\nfrom: test\r\n\r\nWorld 5!", flags: ["\\Deleted", "\\Recent"]},
                                {raw: "Subject: hello 6\r\n\r\nWorld 6!", flags: "\\Answered", uid: 66}
                            ]
                        }
                    }
                },
                "#news.":{
                    type: "shared",
                    separator: ".",
                    folders: {
                        "world":{}
                    }
                },
                "#juke?":{
                    type: "shared",
                    separator: "?"
                }
            }
        });

        this.instanceId = ++instance;
        this.server.listen(IMAP_PORT, (function(){
            done();
        }).bind(this));
    },

    tearDown: function(done){
        this.server.close((function(){
            done();
        }).bind(this));
    },

    "SEARCH ALL": function(test){
        var cmds = ["A1 LOGIN testuser testpass",
                "A2 SELECT INBOX",
                "A3 UID SEARCH ALL",
                "ZZ LOGOUT"];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 67 68 69 70 71 66\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "SEARCH OR": function(test){
        var cmds = ["A1 LOGIN testuser testpass",
                "A2 SELECT INBOX",
                "A3 UID SEARCH OR KEYWORD \"MyFlag\" 5:6",
                "ZZ LOGOUT"];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf("\n* SEARCH 68 71 66\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    }
}
