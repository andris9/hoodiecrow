var toybird = require("../lib/server"),
    mockClient = require("../lib/mock-client");

var IMAP_PORT = 4143,
    instance = 0;

module.exports["Toybird tests"] = {
    setUp: function(done){
        this.server = toybird({
            plugins: "UNSELECT",
            id:{
                name: "toybird",
                version: "0.1"
            },
            storage:{
                "":{
                    folders: {
                        "INBOX":{
                            messages: [
                                {
                                    raw: "Subject: hello 1\r\n\r\nWorld 1!", 
                                    internaldate: "14-Sep-2013 21:22:28 -0300",
                                    flags: "\\Deleted"
                                }
                            ]
                        }
                    }
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

    "CLOSE and \\Deleted": function(test){
        var cmds = ["A1 CAPABILITY",
                "A2 LOGIN testuser testpass",
                "A3 SELECT INBOX",
                "A4 CLOSE",
                "A5 SELECT INBOX",
                "ZZ LOGOUT"];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp){
            resp = resp.toString();
            test.equal((resp.match(/1 EXISTS/g) || []).length, 1);
            test.equal((resp.match(/0 EXISTS/g) || []).length, 1);
            test.done();
        }).bind(this));
    },

    "UNSELECT and \\Deleted": function(test){
        var cmds = ["A1 CAPABILITY",
                "A2 LOGIN testuser testpass",
                "A3 SELECT INBOX",
                "A4 UNSELECT",
                "A5 SELECT INBOX",
                "ZZ LOGOUT"];

        mockClient(IMAP_PORT, "localhost", cmds,  false, (function(resp){
            resp = resp.toString();
            test.equal((resp.match(/1 EXISTS/g) || []).length, 2);
            test.equal((resp.match(/0 EXISTS/g) || []).length, 0);
            test.done();
        }).bind(this));
    }
}