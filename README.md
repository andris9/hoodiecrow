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
  * `FETCH`
  * `SEARCH`
  * `STORE`
  * `COPY`
  * `APPEND`
  * `EXPUNGE`
  * `UID FETCH`
  * `UID STORE`
  * `UID COPY`
  * `UID SEARCH`

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

## API

Server API allows to modify server state at runtime. If needed, specific notices are sent to connected clients.

### Create new mailbox

```javascript
server.createMailbox(path)
```

Where

  * `path` is the mailbox name (eg. *"Other/Sent Mail"*)

### Delete a mailbox

```javascript
server.deleteMailbox(path)
```

Where

  * `path` is the mailbox name (eg. *"Other/Sent Mail"*)

### Add new message

```javascript
server.addMessage(path, message)
```

Where

  * `path` is the mailbox name (eg. *"Other/Sent Mail"*)
  * `message` is the message structure (eg. `{uid: 1, flags: ["\Seen"], body:"From:..."}`)

### Define custom SEARCH handlers

You can define a search handler for any keyword.

```javascript
server.setSearchHandler(keyword, handler)
```

Where

  * `keyword` is the the search keyword (eg. *"SENTBEFORE"*)
  * `handler` (mailbox, message, index [, param1[, param2[,...paramN]]]) is the handler function for a message. If it returns true, the message is included in the search results

Example

```javascript
// return every 5th message
server.setSearchHandler("XFIFTH", function(mailbox, message, index){
    // 'index' is a 1 based message sequence number
    return index % 5 == 0;
});
// tag SEARCH XFIFTH
// * SEARCH 5 10 15 20
```

```javascript
// return messages with exact subject, overrides default SUBJECT
// default behavior is to search messages with partial, case insensitive matches
server.setSearchHandler("SUBJECT", function(mailbox, message, index, queryParam){
    return message.structured.parsedHeader.subject == queryParam;
});
// tag SEARCH SUBJECT "exact Match"
// * SEARCH ...(messages with 'Subject: exact Match')
```

## Plugins

There is some support for creating custom plugins in toybird. Plugins can be enabled with the `enabled` property byt providing a function as the capability.

```javascript
var server = toybird({enabled: [myplugin]});

function myplugin(server){

    // Add XMYPLUGIN to capability listing
    server.addCapability("ID", function(connection){
        // allow only for logged in users, hide for others
        return connection.state != "Not Authenticated";
    });

    // Add XMYPLUGIN command
    // Runnign 'tag XMYPLUGIN' should return server time
    // C: A1 XMYPLUGIN
    // S: * XMYPLUGIN "Sun Sep 01 2013 14:36:51 GMT+0300 (EEST)"
    // S: A1 OK XMYPLUGIN Completed (Success)
    server.addCommandHandler("XMYPLUGIN", function(connection, tag, data, callback){
        if(!connection.checkSupport("XMYPLUGIN")){
            connection.send(tag, "BAD Unknown command: XMYPLUGIN");
            return callback();
        }

        connection.send("*", "XMYPLUGIN " + connection.escapeString(Date()));
        
        connection.processNotices(); // show untagged responses like EXPUNGED etc.
        connection.send(tag, "OK XMYPLUGIN Completed (Success)");

        callback();
    });

    // Add XMYPLUGIN search keyword
    // Return random messages as search matches for 'tag SEARCH XMYPLUGIN'
    // C: A1 SEARCH XMYPLUGIN
    // S: * SEARCH ...(random list of messages)
    // S: A1 OK SEARCH Completed (Success)
    server.setSearchHandler("XMYPLUGIN", function(mailbox, message, index){
        return Math.random() >= 0.5;
    });
}
```

## Issues

These issues are low priority and might not get fixed any time soon

  * Session flags (including `\Recent`) are not supported, all flags are permanent
  * The parser is way too forgiving, should be more strict
  * Optional charset parameter for `SEARCH` is ignored
  * Special case for `LSUB %` - if `"foo/bar"` is subscribed but `"foo"` is not, then listing `LSUB "" "%"` should return `* LSUB (\Noselect) foo` but toybox ignores the unsubscribed `"foo"` and skips it from the listing.
  * BODYSTRUCTURE is generated correctly even for complex messages but line number count is a bit off, not sure how this is exactly calculated (trim empty lines at end etc.?)

# License

**MIT**