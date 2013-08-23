# toybird

Toybird is supposed to be a scriptable IMAP server for client testing. Currently it doesn't do much - a user can sign in, list mailbxes, fetch some messages and enter IDLE.

**NB** this is a proof of concept module, not yet something actually usable.

## Scope

Toybird is a single user / multiple connections IMAP server that uses a JSON object as its directory and messages structure. Nothing is read from or written to disk and the entire directory structure is instantiated every time the server is started, eg. changes made through the IMAP protocol (adding/removing messages/flags etc) are not saved permanently. This should ensure that you can write unit tests for clients in a way where for every test a new fresh server is started with predefined data.

Several clients can connect to the server simultanously but all the clients share the same user account, even if login credentials are different.

## Available commands

  * `CAPABILITY`
  * `FETCH` - partial support (missing support for `BODY[zzz]`, `RFC822.ZZZ` etc. values)
  * `STORE`
  * `SELECT`
  * `EXAMINE`
  * `STATUS`
  * `CLOSE`
  * `LSUB`
  * `LIST`
  * `APPEND`
  * `EXPUNGE`
  * `UID FETCH` - same issues as with regular `FETCH`
  * `UID STORE`
  * `NOOP`
  * `CHECK`
  * `LOGOUT`
  * `LOGIN`

Supported extensions

  * `ID`
  * `IDLE`
  * `STARTTLS`
  * `LOGINDISABLED`

## Usage

Install toybird and run sample application.

    git clone git@github.com:andris9/toybird.git
    cd toybird
    npm install
    node example.js

The sample application defines IMAP directory structure, enables ID and IDLE extensions and starts the server. When the server is running, the application creates a client that connects to it. The client lists available mailboxes, selects INBOX and fetches some message data from it.

If you have the sample application running, you can try connecting to it with a Desktp IMAP client like Thunderbird (use host: `"localhost"`, port: `1234`, username: `"testuser"`, password: `"testpass"`). IMAP client should be able to list all existing messages, mark messages as read/unread, add-remove flags etc.

## Example

```javascript
var toybird = require("toybird");

var server = toybird({

    // enable non default extensions
    enabled: ["ID", "IDLE", "STARTTLS", "LOGINDISABLED"],

    // describe initial IMAP directory structure for this server instace
    directories: {
        "INBOX": {
            uidnext: 100,
            messages: [{
                uid:1,
                internaldate: new Date(),
                body: "From: sender\nTo:Receiver\nSubject: Test\n\nHello world!"
            }]
        },
        "Other":{
            flags: ["\\Noselect"],
            directories: {
                "Sent mail":{}
            }
        }
    }
);

// add authentication info for clients
server.addUser("testuser", "testpass");

// start the server
server.listen(143);
```

## Issues

BODYSTRUCTURE is generated correctly even for complex messages but line number count is a bit off, not sure how this is exactly calculated (trim empty lines at end etc.?)

# License

**MIT**