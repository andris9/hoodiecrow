var toybird = require("../lib/server"),
    mockClient = require("../lib/mock-client");

var IMAP_PORT = 4143,
    instance = 0;

module.exports["Normal login"] = {
    setUp: function(done){
        this.server = toybird({
            storage: {
                "":{
                    folders: {
                        "INBOX":{}
                    }
                },
                "#news.":{
                    type: "shared",
                    separator: "."
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

    "Create fails - Mailbox exists": function(test){
        var message = "From: sender <sender@example.com>\r\nTo: receiver@example.com\r\nSubject: HELLO!\r\n\r\nWORLD!";
        var cmds = ["A1 CAPABILITY",
                "A2 LOGIN testuser testpass",
                "A3 CREATE INBOX",
                "ZZ LOGOUT"];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf("\nA3 NO") >= 0);
            test.done();
        }).bind(this));
    },

    "Create fails - Non-personal namespace": function(test){
        var message = "From: sender <sender@example.com>\r\nTo: receiver@example.com\r\nSubject: HELLO!\r\n\r\nWORLD!";
        var cmds = ["A1 CAPABILITY",
                "A2 LOGIN testuser testpass",
                "A3 CREATE #news.subfolder",
                "ZZ LOGOUT"];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf("\nA3 NO") >= 0);
            test.done();
        }).bind(this));
    },

    "Create success": function(test){
        var message = "From: sender <sender@example.com>\r\nTo: receiver@example.com\r\nSubject: HELLO!\r\n\r\nWORLD!";
        var cmds = ["A1 CAPABILITY",
                "A2 LOGIN testuser testpass",
                "A3 CREATE sub/folder/name/",
                "A4 LIST \"\" \"*\"",
                "ZZ LOGOUT"];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.ok(resp.indexOf('\n* LIST (\\HasChildren) "/" "sub"\r\n') >= 0);
            test.ok(resp.indexOf('* LIST (\\HasChildren) "/" "sub/folder"\r\n') >= 0);
            test.ok(resp.indexOf('* LIST (\\HasNoChildren) "/" "sub/folder/name"\r\n') >= 0);
            test.done();
        }).bind(this));
    }
}
