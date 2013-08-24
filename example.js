var toybird = require("./lib/server"),
    inbox = require("../inbox"),
    fs = require("fs"),
    messageDirectory = __dirname + "/test/fixtures/MimeBack/messages-directory",
    messages = [],
    server;

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

        // if set to true, start a TLS server
        secureConnection: false,

        // enable non default extensions
        // logindisabled is not enabled, so you could log in with telnet or nc
        enabled: ["ID", "IDLE", "STARTTLS"/*, "LOGINDISABLED"*/],

        // base directory
        reference: "",

        // directory path separator
        separator: "/",

        // default flags listed when a mailbox is selected
        flags: ["\\Answered", "\\Flagged", "\\Draft", "\\Deleted", "\\Seen"],

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

    // start the server
    server.listen(1234, callback);
}


function startClient(){

    var client = inbox.createConnection(1234, "localhost", {
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

                // add a new message after 5 seconds of idle time
                setTimeout(function(){
                    server.addMessage("INBOX", {
                        body: "From: andris\r\nTo: Juulius\r\nSubject: test message\r\n\r\nHello!"
                    });
                }, 5000);
            });
        });
    });
}

