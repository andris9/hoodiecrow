var toybird = require("../lib/server"),
    mockClient = require("../lib/mock-client");

module.exports["Toybird tests"] = {
    setUp: function(done){
        this.server = toybird({
            plugins: ["ID", "STARTTLS"/*, "LOGINDISABLED"*/, "AUTH-PLAIN", "NAMESPACE", "IDLE", "ENABLE", "CONDSTORE", "XTOYBIRD"],
            id:{
                name: "toybird",
                version: "0.1"
            },
            namespace:{
                "":{
                    folders: {
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

        this.server.listen(1234, done);
    },

    tearDown: function(done){
        this.server.close(done);
    },

    "FETCH UID": function(test){
        var cmds = ["A1 LOGIN testuser testpass",
                "A2 SELECT INBOX",
                "A3 FETCH 2 (UID)"];

        mockClient(1234, "localhost", cmds, false, function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf("\n* 2 FETCH (UID 2)\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        });
    },

    "FETCH FLAGS": function(test){
        var cmds = ["A1 LOGIN testuser testpass",
                "A2 SELECT INBOX",
                "A3 FETCH 2 (FLAGS)"];

        mockClient(1234, "localhost", cmds, false, function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf("\n* 2 FETCH (FLAGS (\\Seen))\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        });
    },

    "FETCH BODYSTRUCTURE": function(test){
        var cmds = ["A1 LOGIN testuser testpass",
                "A2 SELECT INBOX",
                "A3 FETCH 3 (BODYSTRUCTURE)"];

        mockClient(1234, "localhost", cmds, false, function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf("\n* 3 FETCH (BODYSTRUCTURE (\"TEXT\" \"PLAIN\" NIL NIL NIL \"7BIT\" 8 1 NIL NIL NIL))\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        });
    },

    "FETCH ENVELOPE": function(test){
        var cmds = ["A1 LOGIN testuser testpass",
                "A2 SELECT INBOX",
                "A3 FETCH 4 (ENVELOPE)"];

        mockClient(1234, "localhost", cmds, false, function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf('* 4 FETCH (ENVELOPE ("Fri, 13 Sep 2013 15:01:00 +0300" "hello 4" (("sender name" NIL "sender" "example.com")) (("sender name" NIL "sender" "example.com")) (("sender name" NIL "sender" "example.com")) (("Receiver name" NIL "receiver" "example.com")) NIL NIL NIL "<abcde>"))\r\n') >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        });
    },

    "FETCH BODY": function(test){
        var cmds = ["A1 LOGIN testuser testpass",
                "A2 SELECT INBOX",
                "A3 FETCH 3 (BODY)",
                "A4 FETCH 3 BODY[]",
                "A5 FETCH 3 BODY[]<4.10>",
                "A6 FETCH 3 BODY[]<4.10000>"];

        mockClient(1234, "localhost", cmds, false, function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf('\n* 3 FETCH (BODY ("TEXT" "PLAIN" NIL NIL NIL "7BIT" 8 1))\r\n') >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);

            test.ok(resp.indexOf('\n* 3 FETCH (BODY[] {28}\r\n'+
                    'Subject: hello 3\r\n'+
                    '\r\n'+
                    'World 3!)\r\n') >= 0);
            test.ok(resp.indexOf("\nA4 OK") >= 0);

            test.ok(resp.indexOf('\n* 3 FETCH (BODY[]<4.10> {10}\r\n'+
                    'ect: hello)\r\n') >= 0);
            test.ok(resp.indexOf("\nA5 OK") >= 0);

            test.ok(resp.indexOf('\n* 3 FETCH (BODY[]<4> {24}\r\n'+
                    'ect: hello 3\r\n'+
                    '\r\n'+
                    'World 3!)\r\n') >= 0);
            test.ok(resp.indexOf("\nA4 OK") >= 0);

            test.done();
        });
    },

    "FETCH RFC822": function(test){
        var cmds = ["A1 LOGIN testuser testpass",
                "A2 SELECT INBOX",
                "A3 FETCH 3 (RFC822)"];

        mockClient(1234, "localhost", cmds, false, function(resp){
            resp = resp.toString();

            test.ok(resp.indexOf('\n* 3 FETCH (RFC822 {28}\r\n'+
                    'Subject: hello 3\r\n'+
                    '\r\n'+
                    'World 3!)\r\n') >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);

            test.done();
        });
    },

    "FETCH INTERNALDATE": function(test){
        var cmds = ["A1 LOGIN testuser testpass",
                "A2 SELECT INBOX",
                "A3 FETCH 1 INTERNALDATE"];

        mockClient(1234, "localhost", cmds, false, function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf("\n* 1 FETCH (INTERNALDATE \"14-Sep-2013 21:22:28 -0300\")\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        });
    },

    "FETCH RFC8222.SIZE": function(test){
        var cmds = ["A1 LOGIN testuser testpass",
                "A2 SELECT INBOX",
                "A3 FETCH 4 RFC822.SIZE"];

        mockClient(1234, "localhost", cmds, false, function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf("\n* 4 FETCH (RFC822.SIZE 170)\r\n") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        });
    },

    "FETCH RFC822.HEADER": function(test){
        var cmds = ["A1 LOGIN testuser testpass",
                "A2 SELECT INBOX",
                "A3 FETCH 4 RFC822.HEADER"];

        mockClient(1234, "localhost", cmds, false, function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf('\n* 4 FETCH (RFC822.HEADER {162}\r\n'+
                'From: sender name <sender@example.com>\r\n'+
                'To: Receiver name <receiver@example.com>\r\n'+
                'Subject: hello 4\r\n'+
                'Message-Id: <abcde>\r\n'+
                'Date: Fri, 13 Sep 2013 15:01:00 +0300\r\n'+
                '\r\n'+
                ')\r\n') >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        });
    },

    "FETCH BODY[HEADER]": function(test){
        var cmds = ["A1 LOGIN testuser testpass",
                "A2 SELECT INBOX",
                "A3 FETCH 4 BODY[HEADER]"];

        mockClient(1234, "localhost", cmds, false, function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf('\n* 4 FETCH (BODY[HEADER] {162}\r\n'+
                'From: sender name <sender@example.com>\r\n'+
                'To: Receiver name <receiver@example.com>\r\n'+
                'Subject: hello 4\r\n'+
                'Message-Id: <abcde>\r\n'+
                'Date: Fri, 13 Sep 2013 15:01:00 +0300\r\n'+
                '\r\n'+
                ')\r\n') >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        });
    },

    "FETCH BODY[HEADER.FIELDS]": function(test){
        var cmds = ["A1 LOGIN testuser testpass",
                "A2 SELECT INBOX",
                "A3 FETCH 4 BODY[HEADER.FIELDS (From \"Subject\")]"];

        mockClient(1234, "localhost", cmds, false, function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf('\n* 4 FETCH (BODY[HEADER.FIELDS (From Subject)] {60}\r\n'+
                'From: sender name <sender@example.com>\r\n'+
                'Subject: hello 4\r\n'+
                '\r\n'+
                ')\r\n') >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        });
    },

    "FETCH BODY[HEADER.FIELDS.NOT]": function(test){
        var cmds = ["A1 LOGIN testuser testpass",
                "A2 SELECT INBOX",
                "A3 FETCH 4 BODY[HEADER.FIELDS.NOT (From \"Subject\")]"];

        mockClient(1234, "localhost", cmds, false, function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf('\n* 4 FETCH (BODY[HEADER.FIELDS.NOT (From Subject)] {104}\r\n'+
                'To: Receiver name <receiver@example.com>\r\n'+
                'Message-Id: <abcde>\r\n'+
                'Date: Fri, 13 Sep 2013 15:01:00 +0300\r\n'+
                '\r\n'+
                ')\r\n') >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        });
    }/*,

    "FETCH BODY[TEXT]": function(test){
        var cmds = ["A1 LOGIN testuser testpass",
                "A2 SELECT INBOX",
                "A3 FETCH 4 BODY[TEXT]"];

        mockClient(1234, "localhost", cmds, false, function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf('\n* 4 FETCH (BODY[HEADER.FIELDS.NOT (From Subject)] {104}\r\n'+
                'To: Receiver name <receiver@example.com>\r\n'+
                'Message-Id: <abcde>\r\n'+
                'Date: Fri, 13 Sep 2013 15:01:00 +0300\r\n'+
                '\r\n'+
                ')\r\n') >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        });
    }*/
}
