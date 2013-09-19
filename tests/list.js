var hoodiecrow = require("../lib/server"),
    mockClient = require("../lib/mock-client");

var IMAP_PORT = 4143,
    instance = 0;

module.exports["Hoodiecrow tests"] = {
    setUp: function(done){
        this.server = hoodiecrow({
            plugins: ["NAMESPACE"],
            id:{
                name: "hoodiecrow",
                version: "0.1"
            },
            storage:{
                "INBOX":{
                    messages: [
                        {raw: "Subject: hello 1\r\n\r\nWorld 1!", internaldate: "14-Sep-2013 21:22:28 -0300"},
                        {raw: "Subject: hello 2\r\n\r\nWorld 2!", flags: ["\\Seen"]},
                        {raw: "Subject: hello 3\r\n\r\nWorld 3!"},
                        {raw: "From: sender name <sender@example.com>\r\n"+
                            "To: Receiver name <receiver@example.com>\r\n"+
                            "Subject: hello 4\r\n"+
                            "Message-Id: <abcde>\r\n"+
                            "Date: Fri, 13 Sep 2013 15:01:00 +0300\r\n"+
                            "\r\n"+
                            "World 4!"},
                        {raw: "Subject: hello 5\r\n\r\nWorld 5!"},
                        {raw: "Subject: hello 6\r\n\r\nWorld 6!"}
                    ]
                },
                "":{
                    folders: {
                        "Test": {
                            subscribed: false
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

    "Namespace": function(test){
        var cmds = ["A1 LOGIN testuser testpass",
                "A2 CAPABILITY",
                "A3 NAMESPACE",
                "ZZ LOGOUT"];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp){
            resp = resp.toString();
            test.ok(resp.match(/^\* CAPABILITY\b.*?\bNAMESPACE\b/m));
            test.ok(resp.indexOf('\n* NAMESPACE (("" "/")) NIL (("#news." ".") ("#juke?" "?"))\r\n') >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "LIST separator": function(test){
        var cmds = ["A1 LOGIN testuser testpass",
                "A2 CAPABILITY",
                "A3 LIST \"\" \"\"",
                "ZZ LOGOUT"];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp){
            resp = resp.toString();
            test.equal((resp.match(/^\* LIST\b/mg) || []).length, 1);
            test.ok(resp.indexOf('\n* LIST (\\Noselect) "/" ""\r\n') >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "LIST default namespace": function(test){
        var cmds = ["A1 LOGIN testuser testpass",
                "A2 CAPABILITY",
                "A3 LIST \"\" \"*\"",
                "ZZ LOGOUT"];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp){
            resp = resp.toString();
            test.equal((resp.match(/^\* LIST\b/mg) || []).length, 2);
            test.ok(resp.indexOf('\n* LIST (\\HasNoChildren) "/" "INBOX"\r\n') >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "LIST #news namespace": function(test){
        var cmds = ["A1 LOGIN testuser testpass",
                "A2 CAPABILITY",
                "A3 LIST \"#news.\" \"*\"",
                "ZZ LOGOUT"];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp){
            resp = resp.toString();
            test.equal((resp.match(/^\* LIST\b/mg) || []).length, 1);
            test.ok(resp.indexOf('\n* LIST (\\HasNoChildren) "." "#news.world"\r\n') >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "LSUB all": function(test){
        var cmds = ["A1 LOGIN testuser testpass",
                "A2 CAPABILITY",
                "A3 LSUB \"\" \"*\"",
                "ZZ LOGOUT"];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp){
            resp = resp.toString();
            test.equal((resp.match(/^\* LSUB\b/mg) || []).length, 1);
            test.ok(resp.indexOf('\n* LSUB (\\HasNoChildren) "/" "INBOX"\r\n') >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    }
}
