var hoodiecrow = require("../lib/server"),
    mockClient = require("../lib/mock-client");

var IMAP_PORT = 4143,
    instance = 0;

module.exports["Delete"] = {
    setUp: function(done){
        this.server = hoodiecrow({
            plugins: "XTOYBIRD",
            storage: {
                "":{
                    folders: {
                        "INBOX":{},
                        "testfold": {uidnext: 234, folders: {"sub": {uidnext: 567}}}
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

    "Delete success": function(test){
        var message = "From: sender <sender@example.com>\r\nTo: receiver@example.com\r\nSubject: HELLO!\r\n\r\nWORLD!";
        var cmds = ["A1 LOGIN testuser testpass",
                "A2 DELETE testfold/sub",
                "C1 LIST \"\" \"*\"",
                "A3 DELETE testfold",
                "C2 LIST \"\" \"*\"",
                "ZZ LOGOUT"];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf("\nA2 OK") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "Delete parent": function(test){
        var message = "From: sender <sender@example.com>\r\nTo: receiver@example.com\r\nSubject: HELLO!\r\n\r\nWORLD!";
        var cmds = ["A1 LOGIN testuser testpass",
                "A3 DELETE testfold",
                "C1 LIST \"\" \"*\"",
                "A4 DELETE testfold",
                "C2 LIST \"\" \"*\"",
                "A4 DELETE testfold/sub",
                "C2 LIST \"\" \"*\"",
                "ZZ LOGOUT"];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.ok(resp.indexOf("\nA4 NO") >= 0);
            test.done();
        }).bind(this));
    }
}
