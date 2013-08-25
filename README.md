# toybird

Toybird is supposed to be a scriptable IMAP server for client testing.

**NB** this is a proof of concept module, not yet something actually usable.

## Scope

Toybird is a single user / multiple connections IMAP server that uses a JSON object as its directory and messages structure. Nothing is read from or written to disk and the entire directory structure is instantiated every time the server is started, eg. changes made through the IMAP protocol (adding/removing messages/flags etc) are not saved permanently. This should ensure that you can write unit tests for clients in a way where a new fresh server with unmodified data is started for every test.

Several clients can connect to the server simultanously but all the clients share the same user account, even if login credentials are different.

## Available commands

  * `CAPABILITY`
  * `LOGOUT`
  * `LOGIN`
  * `NOOP`
  * `CHECK`
  * `LIST`
  * `CREATE`
  * `DELETE`
  * `RENAME`
  * `LSUB`
  * `SUBSCRIBE`
  * `UNSUBSCRIBE`
  * `SELECT`
  * `EXAMINE`
  * `CLOSE`
  * `STATUS`
  * `FETCH` - partial support (missing support for `BODY[TEXT/MIME/nr.ZZZ]` and `RFC822.TEXT` values)
  * `STORE`
  * `COPY`
  * `APPEND`
  * `EXPUNGE`
  * `UID FETCH` - same issues as with regular `FETCH`
  * `UID STORE`
  * `UID COPY`

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
                "Sent mail":{},
                "Not Subscribed":{
                    unsubscribed: true
                }
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

  * The parser is way too forgiving, should be more strict
  * If `"foo/bar"` is subscribed but `"foo"` is not, then listing `LSUB "" "%"` should return `* LSUB (\Noselect) foo` but toybox ignores the unsubscribed `"foo"` and skips it from the listing.
  * BODYSTRUCTURE is generated correctly even for complex messages but line number count is a bit off, not sure how this is exactly calculated (trim empty lines at end etc.?)

# License

**MIT**