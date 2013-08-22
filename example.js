var IMAPMockServer = require("./lib/server"),
    inbox = require("../inbox"),
    fs = require("fs"),
    messageDirectory = __dirname + "/test/fixtures/MimeBack/messages-directory",
    messages = [];

// SAMPLE MESSAGE STRUCTURE
/*
[
    {
        uid: 123,
        flags: ["\\Seen"],
        internaldate: new Date(2011, 10,3, 13,44),
        
        // message body is either a Buffer or an ASCII string
        body: "From: Andris Reinman <andris@kreata.ee>\r\n" + 
              "To: Juulius Sage <juulius@kreata.ee>\r\n" + 
              "Subject: Hello, Sage!\r\n" + 
              "\r\n" + 
              "Simple text message\r\n"
    }
]
*/

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

try{
    var message = {
        uid: 100 + messages.length,
        flags: ["\\Seen"],
        internaldate: new Date()
    };
    // message body is either a Buffer or an ASCII string
    message.body = fs.readFileSync(__dirname + "/test/fixtures/mime-torture");
    messages.push(message);
}catch(E){console.log(E)}

startServer(startClient);

function startServer(callback){
    var server = new IMAPMockServer({

        // if set to true, start a TLS server
        secureConnection: false,

        // enable non default extensions
        enabled: ["ID", "IDLE", "STARTTLS", "LOGINDISABLED"],

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
                    "Sent mail":{}
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
        },
        debug: true
    });

    client.connect();

    client.on("connect", function(){

        client.listMailboxes(function(err, list){

            console.log("\nAvailable mailboxes:")
            console.log(list);
            console.log("");

            client.openMailbox("INBOX", function(error, mailbox){
                if(error) throw error;

                // list all messages
                client.listMessages(0, function(err, messages){
                    console.log("\nMessages:")
                    messages.forEach(function(message){
                        console.log(message.UID+": "+message.title);
                    });
                    console.log("");

                    client._send("STORE 1:* +FLAGS (\\Juhkental)")
                    client._send("STORE 1:* +FLAGS (\\Puhvet)")
                    client._send("STORE 1:* -FLAGS (\\Juhkental)")
                    client._send("STORE 1:* -FLAGS (\\Seen)")
                    client._send("STORE 1:* FLAGS (\\Sada \\Kada)")
                    client._send("STORE 1:* FLAGS.SILENT (\\Mada \\Vada)")

                    client._send("FETCH 1:* BODYSTRUCTURE")

                    setTimeout(function(){
                        client._send("LOGOUT")
                    }, 3000);
                });
            });
        });
    });
    client.on("close", function(){
        process.exit();
    });
}

