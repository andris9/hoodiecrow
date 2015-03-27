# Hoodiecrow

![Hoodiecrow](https://raw.github.com/andris9/hoodiecrow/master/hoodiecrow_actual.jpg)

*Image by yours truly, see the original in [Instagram](http://instagram.com/p/el_FOIo_tB/#)*

Hoodiecrow is a scriptable IMAP server for client integration testing. It offers [IMAP4ver1](http://tools.ietf.org/html/rfc3501) support and some optional plugins that can be turned on and off. Nothing is ever written to disk, so when you restart the server, the original state is restored.

[![Build Status](https://secure.travis-ci.org/andris9/hoodiecrow.png)](http://travis-ci.org/andris9/hoodiecrow)
[![NPM version](https://badge.fury.io/js/hoodiecrow.png)](http://badge.fury.io/js/hoodiecrow)

STARTTLS requires Node *0.12* or *iojs* as it uses [tls.TLSSocket](https://nodejs.org/api/tls.html#tls_class_tls_tlssocket) API.

# Usage

### Run as a standalone server

To run Hoodiecrow you need [Node.js](http://nodejs.org/) in your machine. Node should work on almost any platform, so Hoodiecrow should too.

If you have Node.js installed, install Hoodiecrow with the `npm` command and run it:

```bash
npm install -g hoodiecrow
sudo hoodiecrow
```

Sudo is needed to bind to port 143. If you choose to use a higher port, say 1143 (`hoodiecrow -p 1143`), you do not need to use sudo.

`hoodiecrow` command also provides an incoming SMTP server which appends all incoming messages
automatically to INBOX. To use it, use *smtpPort* option (`hoodiecrow --smtpPort=1025`).

> **Protip** Running `hoodiecrow --help` displays useful information about command line options for Hoodiecrow and some sample configuration data.

After you have started Hoodiecrow server, you can point your IMAP client to `localhost:143`. Use `"testuser"` as user name and `"testpass"` as password to log in to the server.

### Include as a Node.js module

Add `hoodiecrow` dependency

```bash
npm install hoodiecrow
```

Create and start an IMAP server

```javascript
var hoodiecrow = require("hoodiecrow"),
    server = hoodiecrow(options);
server.listen(143);
```

See [complete.js](https://github.com/andris9/hoodiecrow/blob/master/examples/complete.js) for an example.

## Scope

Hoodiecrow is a single user / multiple connections IMAP server that uses a JSON object as its directory and messages structure. Nothing is read from or written to disk and the entire directory structure is instantiated every time the server is started, eg. changes made through the IMAP protocol (adding/removing messages/flags etc) are not saved permanently. This should ensure that you can write integration tests for clients in a way where a new fresh server with unmodified data is started for every test.

Several clients can connect to the server simultanously but all the clients share the same user account, even if login credentials are different.

Hoodiecrow is extendable, any command can be overwritten, plugins can be added etc (see command folder for built in command examples and plugin folder for plugin examples).

## Authentication

An user can always login with username `"testuser"` and password `"testpass"`. Any other credentials can be added as needed.

## Status

### IMAP4rev1

All commands are supported but might be a bit buggy

### Supported Plugins

Plugins can be enabled when starting the server but can not be unloaded or loaded when the server is already running.
All plugins are self contained and not tied to core. If you do not enable a plugin, no trace of it is left
to the system. For example, if you do not enable CONDSTORE, messages do not have a MODSEQ value set.

  * **AUTH-PLAIN** Adds AUTH=PLAIN capability. Supports SASL-IR [RFC4959] as well
  * **CONDSTORE** Partially implemented CONDSTORE [RFC4551] support
  * **CREATE-SPECIAL-USE** Enables CREATE-SPECIAL-USE [RFC6154] capability. Allowed special flags can be set with server option `"special-use"`
  * **ENABLE** Adds ENABLE capability [RFC5161]. Must be loaded before any plugin that requires ENABLE support (eg. CONDSTORE)
  * **ID** Adds ID [RFC2971] capability
  * **IDLE** Adds IDLE [RFC2177] capability
  * **LITERALPLUS** Enables LITERAL+ [RFC2088] capability
  * **LOGINDISABLED** Disables LOGIN support for unencrypted connections
  * **NAMESPACE** Adds NAMESPACE [RFC2342] capability
  * **SASL-IR** Enables SASL-IR [RFC4959] capability
  * **SPECIAL-USE** Enables SPECIAL-USE [RFC6154] capability Mailboxes need to have a "special-use" property (String or Array) that will be used as extra flag for LIST and LSUB responses
  * **STARTTLS** Adds STARTTLS command
  * **UNSELECT** Adds UNSELECT [RFC3691] capability
  * **X-GM-EXT-1** Adds partial support for [Gmail specific](https://developers.google.com/gmail/imap_extensions) options. `X-GM-MSGID` is fully supported, `X-GM-LABELS` is partially supported (labels can be STOREd and FETCHed but setting a label does not change message behavior, for example the message does not get copied to another mailbox). `X-GM-THRID` is not supported as I haven't figured threading out yet.
  * **XOAUTH2** GMail XOAUTH2 login. Only works with SALS-IR, if you need non SASL-IR support as well, let me know. Use `"testuser"` as the username and `"testtoken"` as Access Token to log in.
  * **XTOYBIRD** Custom plugin to allow programmatic control of the server. Login not required to use XTOYBIRD commands

Planned but not yet implemented

  * **MOVE**
  * **UIDPLUS**
  * **QUOTA**

## Authentication

An user can always login with username `"testuser"` and password `"testpass"`. Any other credentials can be added as needed.

## Existing XTOYBIRD commands

To use these functions, XTOYBIRD plugin needs to be enabled

Available commands:

  * **XTOYBIRD SERVER** dumps server internals
  * **XTOYBIRD CONNECTION** dumps connection internals
  * **XTOYBIRD STORAGE** dumps storage as JSON
  * **XTOYBIRD USERADD "username" "password"** adds or updates user
  * **XTOYBIRD USERDEL "username"** removes an user
  * **XTOYBIRD SHUTDOWN** Closes the server after the last client disconnects. New connections are rejected.

Example usage for XTOYBIRD STORAGE:

```
S: * Hoodiecrow ready for rumble
C: A1 XTOYBIRD STORAGE
S: * XTOYBIRD [XJSONDUMP] {3224}
S: {
S:     "INBOX": {
S:         "messages": [
S:             {
S:                 "raw": "Subject: hello 1\r\n\r\nWorld 1!",
S:                 ...
S: A1 OK XTOYBIRD Completed
```

## Useful features for Hoodiecrow I'd like to see

  * An ability to change UIDVALIDITY at runtime (eg. `A1 XTOYBIRD UIDVALIDITY INBOX 123` where 123 is the new UIDVALIDITY for INBOX)
  * An ability to change available disk space (eg. `A1 XTOYBIRD DISKSPACE 100 50` where 100 is total disk space in bytes and 50 is available space)
  * An ability to restart the server to return initial state (`A1 XTOYBIRD RESET`)
  * An ability to change storage runtime by sending a JSON string describing the entire storage (`A1 XTOYBIRD UPDATE {123}\r\n{"INBOX":{...}})`)

## CONDSTORE support

  * All messages have MODSEQ value
  * CONDSTORE can be ENABLEd
  * SELECT/EXAMINE show HIGHESTMODSEQ
  * SELECT/EXAMINE support (CONDSTORE) option
  * Updating flags increments MODSEQ value
  * FETCH (MODSEQ) works
  * FETCH (CHANGEDSINCE modseq) works
  * STORE (UNCHANGEDSINCE modseq) partially works (edge cases are not covered)

**SEARCH MODSEQ** is not supported

# Known issues

  * *INBOX** as a separate namespace and managing INBOX subfolders is a mess. CREATE seems to work, DELETE is buggy and RENAME doesn't work with INBOX subfolders (unless the default namespace is `"INBOX."`, not `""`). I need to rethink how this works.

Not sure if these should be fixed or not

  * **STORE** does not emit notifications to other clients
  * **MODSEQ** updates are not notified

These issues are probably not going to get fixed

  * **Session flags** are not supported (this means that `\Recent` flag is also not supported)
  * **addr-adl** (at-domain-list) values are not supported, NIL is always used
  * **anonymous namespaces** are not supported
  * **STORE** returns NO and nothing is updated if there are pending EXPUNGE messages
  * **CHARSET** argument is ignored

# Running tests

Running tests requires you to have grunt-cli installed

    npm install -g grunt-cli

After which you can run

    grunt

or

    npm test

## Example configs

### Cyrus

config.json:

```json
{
    "INBOX":{},
    "INBOX.":{},
    "user.":{
        "type":"user"
    },
    "":{
        "type":"shared"
    }
}
```

### Gmail

config.json:

```json
{
    "INBOX":{},
    "":{
        "separator": "/",
        "folders":{
            "[Gmail]":{
                "flags": ["\\Noselect"],
                "folders": {
                    "All Mail":{
                        "special-use": "\\All"
                    },
                    "Drafts":{
                        "special-use": "\\Drafts"
                    },
                    "Important":{
                        "special-use": "\\Important"
                    },
                    "Sent Mail":{
                        "special-use": "\\Sent"
                    },
                    "Spam":{
                        "special-use": "\\Junk"
                    },
                    "Starred":{
                        "special-use": "\\Flagged"
                    },
                    "Trash":{
                        "special-use": "\\Trash"
                    }
                }
            }
        }
    }
}
```

## Use Hoodiecrow for testing your client

Creating your tests in Node.js is a piece of cake, you do not even need to run the `hoodiecrow` command. Here is a sample [nodeunit] test.

```javascript
var hoodiecrow = require("hoodiecrow"),
    myIMAPCLient = require("../my-imap-client");

module.exports["IMAP tests"] = {

    // Executed before every test
    // creates a new blank IMAP server
    setUp: function(callback){
        this.server = hoodiecrow();
        this.server.listen(1143);
        callback();
    },

    // Executed after every test
    // Closes the IMAP server created for the test
    tearDown: function(callback){
        this.server.close(callback);
    },

    /**
     * In this test a new IMAP client is instantiated that tries to connect
     * to the IMAP server. If client is connected the test is considered
     * as passed.
     */
    "Connect to the server": function(test){
        var client = myIMAPCLient.connect("localhost", 1143);
        client.on("ready", function(){
            client.disconnect();
            test.done();
        });
    }
}
```

## Creating custom plugins

A plugin can be a string as a pointer to a built in plugin or a function. Plugin function is run when the server is created and gets server instance object as an argument.

```javascript
hoodiecrow({
    // Add two plugins, built in "IDLE" and custom function
    plugin: ["IDLE", myAwesomePlugin]
});

// Plugin handler
function myAwesomePlugin(server){

    // Add a string to the capability listing
    server.registerCapability("XSUM");

    /**
     * Add a new command XSUM
     * If client runs this command, the response is a sum of all
     * numeric arguments provided
     *
     * A1 XSUM 1 2 3 4 5
     * * XSUM 15
     * A1 OK SUM completed
     *
     * @param {Object} connection - Session instance
     * @param {Object} parsed - Input from the client in structured form
     * @param {String} data - Input command as a binary string
     * @param {Function} callback - callback function to run
     */
    server.setCommandHandler("XSUM", function(connection, parsed, data, callback){

        // Send untagged XSUM response
        connection.send({
            tag: "*",
            command: "XSUM",
            attributes:[
                [].concat(parsed.attributes || []).reduce(function(prev, cur){
                    return prev + Number(cur.value);
                }, 0)
            ]
        }, "XSUM", parsed, data);

        // Send tagged OK response
        connection.send({
            tag: parsed.tag,
            command: "OK",
            attributes:[
                // TEXT allows to send unquoted
                {type: "TEXT", value: "XSUM completed"}
            ]
        }, "XSUM", parsed, data);
        callback();
    });
}
```

### Plugin mehtods

#### Add a capability

    server.registerCapability(name[, availabilty])

Where

  * **name** a string displayed in the capability response
  * **availability** a function which returns boolean value. Executed before displaying the capability response. If the function returns true, the capability is displayed, if false then not.

Example

```javascript
// Display in CAPABILITY only in Not Authenticated state
server.registerCapability("XAUTH", function(connection){
    return connection.state == "Not Authenticated";
});
```

#### Define a command

    server.setCommandHandler(name, handler)

Where

  * **name** is the command name
  * **handler** *(connection, parsed, data, callback)* is the handler function for the command

Handler arguments

  * **connection** - Session instance
  * **parsed** - Input from the client in structured form (see [imap-handler](https://github.com/andris9/imap-handler#parse-imap-commands) for reference)
  * **data** - Input command as a binary string
  * **callback** - callback function to run (does not take any arguments)

The command should send data to the client with `connection.send()`

    connection.send(response, description, parsed, data, /* any additional data */)

Where

  * **response** is a [imap-handler](https://github.com/andris9/imap-handler#parse-imap-commands) compatible object. To get the correct tag for responsing OK, NO or BAD, look into `parsed.tag`
  * **description** is a string identifying the response to be used by other plugins
  * **parsed** is the `parsed` argument passed to the handler
  * **data** is the `data` argument passed to the handler
  * additional arguments can be used to provide input for other plugins

#### Retrieve an existing handler

To override existing commands you should first cache the existing command, so you can use it in your own command handler.

    server.getCommandHandler(name) -> Function

Where

  * **name** is the function name

Example

```javascript
var list = server.getCommandHandler("LIST");
server.setCommandHandler("LIST", function(connection, parsed, data, callback){
    // do something
    console.log("Received LIST request");
    // run the cached command
    list(connection, parsed, data, callback);
});
```

#### Reroute input from the client

If your plugin needs to get direct input from the client, you can reroute the incoming data by defining a `connection.inputHandler` function. The function gets input data as complete lines (without the linebreaks). Once you want to reroute the input back to the command handler, just clear the function.

```
connection.inputHandler = function(line){
    console.log(line);
    connection.inputHandler = false;
}
```

See [idle.js](https://github.com/andris9/hoodiecrow/blob/master/lib/plugins/idle.js) for an example

#### Override output

Any response sent to the client can be overriden or cancelled by other handlers. You should append your handler to `server.outputHandlers` array. If something is being sent to the client, the response object is passed through all handlers in this array.

    server.outputHandlers.push(function(connection, /* arguments from connection.send */){})

`response` arguments from `connection.send` is an object and thus any modifications will be passed on. If `skipResponse` property is added to the response object, the data is not sent to the client.

```javascript
// All untagged responses are ignored and not passed to the client
server.outputHandlers.push(function(connection, response, description){
    if(response.tag == "*"){
        response.skipResponse = true;
        console.log("Ignoring untagged response for %s", description);
    }
});
```

#### Other possbile operations

It is possible to append messages to a mailbox; create, delete and rename mailboxes; change authentication state and so on through the `server` and `connection` methods and properties. See existing command handlers and plugins for examples.

# License

**MIT**
