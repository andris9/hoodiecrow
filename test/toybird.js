var mockClient = require("../lib/mock-client"),
    toybird = require("../lib/server");

module.exports["Basic tests"] = {
    setUp: function(done){
        this.server = toybird({
            enabled: ["ID", "IDLE", "STARTTLS", "LOGINDISABLED"],
            separator: "/",
            directories: {
                "INBOX": {
                    messages:[{}, {}, {}]
                }
            }
        });
        this.server.addUser("testuser", "testpass");
        this.server.listen(1234, done);
    },

    tearDown: function(done){
        this.server.close(done);
    },

    basic: function(test){
        var cmds = ["A1 CAPABILITY", 
                "A2 STARTTLS",
                "A3 LOGIN testuser testpass", 
                "A4 SELECT INBOX",
                "A6 LOGOUT"];
        mockClient(1234, "localhost", cmds, false, function(resp){
            test.ok(resp.toString("utf-8").indexOf(" OK [READ-WRITE]"));
            test.done();
        });
    }
}