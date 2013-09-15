var toybird = require("../lib/server"),
    mockClient = require("../lib/mock-client");

var IMAP_PORT = 4143,
    instance = 0;

module.exports["Normal login"] = {
    setUp: function(done){
        this.server = toybird();

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

    "Append simple": function(test){
        var message = "From: sender <sender@example.com>\r\nTo: receiver@example.com\r\nSubject: HELLO!\r\n\r\nWORLD!";
        var cmds = ["A1 CAPABILITY",
                "A2 LOGIN testuser testpass",
                "A3 SELECT INBOX",
                "A4 APPEND INBOX {" + message.length + "}\r\n"+message,
                "A5 FETCH 1 BODY[HEADER.FIELDS (Subject)]",
                "ZZ LOGOUT"];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf("\nA2 OK") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.ok(resp.indexOf("\nA4 OK") >= 0);
            test.ok(resp.indexOf("\nA5 OK") >= 0);
            test.ok(resp.indexOf("\nSubject: HELLO!") >= 0);
            test.done();
        }).bind(this));
    },

    "Append flags": function(test){
        var message = "From: sender <sender@example.com>\r\nTo: receiver@example.com\r\nSubject: HELLO!\r\n\r\nWORLD!";
        var cmds = ["A1 CAPABILITY",
                "A2 LOGIN testuser testpass",
                "A3 SELECT INBOX",
                "A4 APPEND INBOX (MyFlag) {" + message.length + "}\r\n"+message,
                "A5 FETCH 1 (FLAGS BODY[HEADER.FIELDS (Subject)])",
                "ZZ LOGOUT"];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf("\nA2 OK") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.ok(resp.indexOf("\nA4 OK") >= 0);
            test.ok(resp.indexOf("\nA5 OK") >= 0);
            test.ok(resp.indexOf("MyFlag") >= 0);
            test.ok(resp.indexOf("\nSubject: HELLO!") >= 0);
            test.done();
        }).bind(this));
    },

    "Append internaldate": function(test){
        var message = "From: sender <sender@example.com>\r\nTo: receiver@example.com\r\nSubject: HELLO!\r\n\r\nWORLD!";
        var cmds = ["A1 CAPABILITY",
                "A2 LOGIN testuser testpass",
                "A3 SELECT INBOX",
                "A4 APPEND INBOX \"14-Sep-2013 21:22:28 -0300\" {" + message.length + "}\r\n"+message,
                "A5 FETCH 1 (INTERNALDATE BODY[HEADER.FIELDS (Subject)])",
                "ZZ LOGOUT"];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf("\nA2 OK") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.ok(resp.indexOf("\nA4 OK") >= 0);
            test.ok(resp.indexOf("\nA5 OK") >= 0);
            test.ok(resp.indexOf("14-Sep-2013 21:22:28 -0300") >= 0);
            test.ok(resp.indexOf("\nSubject: HELLO!") >= 0);
            test.done();
        }).bind(this));
    },

    "Append full": function(test){
        var message = "From: sender <sender@example.com>\r\nTo: receiver@example.com\r\nSubject: HELLO!\r\n\r\nWORLD!";
        var cmds = ["A1 CAPABILITY",
                "A2 LOGIN testuser testpass",
                "A3 SELECT INBOX",
                "A4 APPEND INBOX (MyFlag) \"14-Sep-2013 21:22:28 -0300\" {" + message.length + "}\r\n"+message,
                "A5 FETCH 1 (FLAGS INTERNALDATE BODY[HEADER.FIELDS (Subject)])",
                "ZZ LOGOUT"];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf("\nA2 OK") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.ok(resp.indexOf("\nA4 OK") >= 0);
            test.ok(resp.indexOf("\nA5 OK") >= 0);
            test.ok(resp.indexOf("MyFlag") >= 0);
            test.ok(resp.indexOf("14-Sep-2013 21:22:28 -0300") >= 0);
            test.ok(resp.indexOf("\nSubject: HELLO!") >= 0);
            test.done();
        }).bind(this));
    }
}