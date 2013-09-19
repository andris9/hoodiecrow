var hoodiecrow = require("./lib/server"),
    server = hoodiecrow({
        plugins: ["ID", "STARTTLS"/*, "LOGINDISABLED"*/, "SASL-IR", "AUTH-PLAIN", "NAMESPACE", "IDLE", "ENABLE", "XTOYBIRD", "LITERALPLUS", "UNSELECT", "SPECIAL-USE"],
        id:{
            name: "hoodiecrow",
            version: "0.1"
        },
        storage: {
            "": {
                "folders": {
                    "INBOX": {
                        "special-use": "\\Inbox",
                        "messages": [
                            {
                                "raw": "Subject: hello 1\r\n\r\nWorld 1!",
                                "internaldate": "18-Sep-2013 17:28:15 +0300"
                            },
                            {
                                "raw": "Subject: hello 2\r\n\r\nWorld 2!",
                                "internaldate": "14-Sep-2013 21:22:28 -0300"
                            },
                            {
                                "raw": "Subject: hello 4\r\n\r\nWorld 4!",
                                "flags": [
                                    "\\Answered"
                                ],
                                "internaldate": "18-Sep-2013 17:28:15 +0300"
                            },
                            {
                                "raw": "Subject: hello 5\r\n\r\nWorld 5!",
                                "internaldate": "18-Sep-2013 17:28:15 +0300"
                            }
                        ]
                    },
                    "Drafts": {
                        "special-use": "\\Drafts",
                        "messages": []
                    },
                    "Test folder": {}
                },
                "separator": "/",
                "type": "personal"
            },
            "#news.": {
                "type": "shared",
                "separator": ".",
                "folders": {
                    "world": {
                        "path": "#news.world",
                        "namespace": "#news.",
                        "uid": 1,
                        "uidvalidity": 1,
                        "flags": [
                            "\\HasNoChildren"
                        ],
                        "allowPermanentFlags": true,
                        "permanentFlags": [
                            "\\Answered",
                            "\\Flagged",
                            "\\Draft",
                            "\\Deleted",
                            "\\Seen"
                        ],
                        "subscribed": true,
                        "messages": [],
                        "uidnext": 1
                    }
                }
            },
            "#juke?": {
                "type": "shared",
                "separator": "?"
            }
        },
        debug: true
    });

const PORT = 1143;

server.listen(PORT, function(){
    console.log("Hoodiecrow listening on port %s", PORT)
});
