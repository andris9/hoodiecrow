var toybird = require("./lib/server"),
    server = toybird({
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
                            {
                                raw: "Subject: hello\r\n\r\nWorld!"
                            }
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
