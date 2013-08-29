var mockClient = require("../lib/mock-client"),
    toybird = require("../lib/server");

module.exports["Example test"] = function(test){
    var server = toybird({
        enabled: ["ID", "IDLE", "STARTTLS", "LOGINDISABLED"],
        separator: "/",
        directories: {
            "INBOX": {
                messages:[
                    {body: ""},
                    {body: ""},
                    {body: ""}
                ]
            }
        }
    });
    server.addUser("testuser", "testpass");
    server.listen(1234, function(){
        var cmds = ["A1 CAPABILITY", 
                "A2 STARTTLS", 
                "A3 LOGIN testuser testpass", 
                "A4 SELECT INBOX", 
                "A5 SEARCH ALL"];
        mockClient(1234, "localhost", cmds, false, function(resp){
            test.ok(resp.toString("utf-8").match(/^\* SEARCH 1 2 3$/m));
            server.close(function(){
                test.done();
            });
        });
    });
}