var toybird = require("./lib/server"),
    server = toybird({
        plugins: ["ID", "STARTTLS"/*, "LOGINDISABLED"*/, "SASL-IR", "AUTH-PLAIN", "NAMESPACE", "IDLE", "ENABLE", "CONDSTORE", "XTOYBIRD", "LITERALPLUS"],
        id:{
            name: "toybird",
            version: "0.1"
        },
        namespace:{
            "":{
                folders: {
                    "INBOX":{
                        messages: [
                            "Subject: hello 1\r\n\r\nWorld 1!",
                            {raw: "Subject: hello 2\r\n\r\nWorld 2!", internaldate: "14-Sep-2013 21:22:28 -0300"},
                            {raw: "Subject: hello 3\r\n\r\nWorld 3!", flags: ["\\Seen"]},
                            {raw: "Subject: hello 4\r\n\r\nWorld 4!", flags: "\\Answered"},
                            "Subject: hello 5\r\n\r\nWorld 5!",
                            "Subject: hello 6\r\n\r\nWorld 6!"
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

const PORT = 1234;

server.listen(PORT, function(){
    console.log("Toybird listening on port %s", PORT)
});
