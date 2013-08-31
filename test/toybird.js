var mockClient = require("../lib/mock-client"),
    toybird = require("../lib/server");

module.exports["Basic tests"] = {
    setUp: function(done){
        this.server = toybird({
            enabled: ["ID", "IDLE", "STARTTLS", "LOGINDISABLED"],
            separator: "/",
            directories: {
                "INBOX": {
                    messages:[{}, {q: "abc"}, {}]
                }
            }
        });
        this.server.addUser("testuser", "testpass");
        this.server.setSearchHandler("testsearch", function(mailbox, message, index, param){
            return param == message.q;
        });
        this.server.listen(1234, done);
    },

    tearDown: function(done){
        this.server.close(done);
    },

    "Failed login, LOGINDISABLED": function(test){
        var cmds = ["A1 CAPABILITY", 
                "A2 LOGIN testuser testpass", 
                "A3 LOGOUT"];
        mockClient(1234, "localhost", cmds, false, function(resp){
            test.ok(resp.toString("utf-8").indexOf("\nA2 NO") >= 0);
            test.done();
        });
    },

    "Start TLS, LOGIN invalid": function(test){
        var cmds = ["A1 CAPABILITY", 
                "A2 STARTTLS",
                "A3 LOGIN testuser invalidpass", 
                "A4 LOGOUT"];
        mockClient(1234, "localhost", cmds, false, function(resp){
            test.ok(resp.toString("utf-8").indexOf("\nA3 NO") >= 0);
            test.done();
        });
    },

    "Start TLS, LOGIN success": function(test){
        var cmds = ["A1 CAPABILITY", 
                "A2 STARTTLS",
                "A3 LOGIN testuser testpass", 
                "A4 LOGOUT"];
        mockClient(1234, "localhost", cmds, false, function(resp){
            test.ok(resp.toString("utf-8").indexOf("\nA3 OK") >= 0);
            test.done();
        });
    },

    "Select INBOX": function(test){
        var cmds = ["A1 CAPABILITY", 
                "A2 STARTTLS",
                "A3 LOGIN testuser testpass", 
                "A4 SELECT INBOX",
                "A5 LOGOUT"];
        mockClient(1234, "localhost", cmds, false, function(resp){
            test.ok(resp.toString("utf-8").indexOf("\nA4 OK [READ-WRITE]") >= 0);
            test.done();
        });
    },

    "Custom SEARCH": function(test){
        var cmds = ["A1 CAPABILITY", 
                "A2 STARTTLS",
                "A3 LOGIN testuser testpass", 
                "A4 SELECT INBOX",
                "A5 SEARCH TESTSEARCH abc",
                "A6 LOGOUT"];
        mockClient(1234, "localhost", cmds, false, function(resp){
            test.ok(resp.toString("utf-8").indexOf("\r\n* SEARCH 2\r\n") >= 0);
            test.done();
        });
    }
}