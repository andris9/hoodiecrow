var IMAPMockServer = require("./lib/server"),
    inbox = require("../inbox");

startServer(startClient);

function startServer(callback){

    // create a sample message structure that will be listed in INBOX
    var testmessages = [
        {
            uid: 123,
            flags: ["\\Seen"],
            date: new Date(2011, 10,3, 13,44),
            title: "Test message nr 1",
            from: {name: "Andris Reinman", address: "andris@node.ee"},
            to: {name: "Juulius Jube", address: "juulius@kreata.ee"},
            messageId: "<message-id-123@node.ee>"
        },{
            uid: 124,
            flags: ["\\Recent"],
            date: new Date(2012, 9,21, 15, 21),
            title: "Test message nr 2",
            from: {name: "Andris Reinman", address: "andris@node.ee"},
            to: {name: "Kuugel Kaagel", address: "kuugel@kreata.ee"},
            messageId: "<message-id-124@node.ee>"
        },]

    var server = new IMAPMockServer({

        // enable non default extensions
        enabled: ["ID", "IDLE"],

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
                messages: testmessages
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
                });
            });
        });
    });
}

