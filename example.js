var toybird = require("./lib/server"),
    inbox = require("../inbox"),
    fs = require("fs"),
    messageDirectory = __dirname + "/test/fixtures/MimeBack/messages-directory",
    messages = [],
    server;

var IMAP_PORT = 1234;

// load some messages from the MimeBack folder messages
fs.readdirSync(messageDirectory).forEach(function(name, i){
    if(["OLD", ".DS_Store"].indexOf(name) >= 0){
        return;
    }

    var message = {
        uid: 100 + i,
        flags: ["\\Seen"],
        internaldate: new Date()
    };

    try{
        // message body is either a Buffer or an ASCII string
        message.body = fs.readFileSync(messageDirectory + "/" + name);
        messages.push(message);
    }catch(E){}
});

startServer(startClient);

function startServer(callback){
    server = toybird({

        // output command to console
        debug: true,

        // if set to true, start a TLS server
        secureConnection: false,

        // enable non default extensions
        // logindisabled is not enabled, so you could log in with telnet or nc
        enabled: [
            require("./lib/plugins/id"),
            "xfifth",
            "condstore",
            "IDLE",
            "STARTTLS"/*, "LOGINDISABLED"*/],

        // base directory
        reference: "",

        // directory path separator
        separator: "/",

        // Automatically logged in as selected user
        // preauth: "testuser",

        // IMAP directory structure
        directories: {
            "INBOX": {
                uidnext: 100,
                messages: messages
            },
            "Misc": {
                flags: ["\\Noselect"]
            },
            "Other":{
                flags: ["\\Noselect"],
                directories: {
                    "Sent mail":{},
                    "Not listed":{
                        unsubscribed: true
                    }
                }
            }
        }
    });

    // add authentication info
    server.addUser("testuser", "testpass");

    server.setSearchHandler("SUBJECT", function(mailbox, message, index, queryParam){
        return message.structured.parsedHeader.subject == queryParam;
    });

    // start the server
    server.listen(IMAP_PORT, function(){
        console.log("IMAP server listening on port %s", IMAP_PORT);
        callback();
    });
}


function startClient(){

    var client = inbox.createConnection(IMAP_PORT, "localhost", {
        secureConnection: false,
        auth:{
            user: "testuser",
            pass: "testpass"
        }
    });

    client.connect();

    client.on("connect", function(){
        client.openMailbox("INBOX", function(error, mailbox){
            if(error) throw error;
            // list all messages
            client.listMessages(0, function(err, messages){
                console.log("\nMessages:")
                messages.forEach(function(message){
                    console.log(message.UID+": "+message.title);
                });
                console.log("");
                client._send("search XFIFTH");
                client._send("search MODSEQ 15");
                client._send("FETCH 1:* (UID) (CHANGEDSINCE 15)")
            });
        });
    });
}

