var hoodiecrow = require("../lib/server"),
    mockClient = require("../lib/mock-client");

var IMAP_PORT = 4143,
    instance = 0;

module.exports["Hoodiecrow tests"] = {
    setUp: function(done){
        this.server = hoodiecrow({
            plugins: "UNSELECT",
            id:{
                name: "hoodiecrow",
                version: "0.1"
            },
            storage:{
                "INBOX":{
                    messages: [
                        {
                            raw: "Subject: hello 1\r\n\r\nWorld 1!",
                            internaldate: "14-Sep-2013 21:22:28 -0300",
                            flags: "\\Deleted"
                        },
                        {
                            raw: "Subject: hello 1\r\n\r\nWorld 2!"
                        }
                    ]
                },
                "":{
                    folders: {
                        "target": {}
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

    "COPY": function(test){
        var cmds = ["A1 LOGIN testuser testpass",
                "A2 SELECT INBOX",
                "A3 UID COPY 1:* target",
                "A4 SELECT target",
                "ZZ LOGOUT"];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf("\r\nA3 OK") >= 0);
            test.equal((resp.match(/\* 2 EXISTS/mg) || []).length, 2);
            test.done();
        }).bind(this));
    }
}
