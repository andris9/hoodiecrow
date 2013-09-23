# Hoodiecrow

![Hoodiecrow](https://raw.github.com/andris9/hoodiecrow/master/hoodiecrow_actual.jpg)

Hoodiecrow is a scriptable IMAP server for client integration testing. It offers partial IMAP4ver1 support and some optional plugins that can be turned on and off. Nothing is ever written to disk, so when you restart the server, the original state is restored. 

[![Build Status](https://secure.travis-ci.org/andris9/hoodiecrow.png)](http://travis-ci.org/andris9/hoodiecrow)
[![NPM version](https://badge.fury.io/js/hoodiecrow.png)](http://badge.fury.io/js/hoodiecrow)

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

See [example.js](https://github.com/andris9/hoodiecrow/blob/master/example.js) for an example.

## Scope

Hoodiecrow is a single user / multiple connections IMAP server that uses a JSON object as its directory and messages structure. Nothing is read from or written to disk and the entire directory structure is instantiated every time the server is started, eg. changes made through the IMAP protocol (adding/removing messages/flags etc) are not saved permanently. This should ensure that you can write integration tests for clients in a way where a new fresh server with unmodified data is started for every test.

Several clients can connect to the server simultanously but all the clients share the same user account, even if login credentials are different.

Hoodiecrow is extendable, any command can be overwritten, plugins can be added etc (see command folder for built in command examples and plugin folder for plugin examples).

## Authentication

An user can always login with username `"testuser"` and password `"testpass"`. Any other credentials can be added as needed.

## Status

### IMAP4rev1

  * **FETCH** and **UID FETCH** support is partial (does not retrieve nested parts, eg. 1.1.TEXT)
  * Other commands should be more or less ready

### Supported Plugins

Plugins can be enabled when starting the server but can not be unloaded or loaded when the server is already running

  * **AUTH-PLAIN** Adds AUTH=PLAIN capability. Supports SALS-IR [RFC4959] as well
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
  * **XTOYBIRD** Custom plugin to allow programmatic control of the server. Login not required to use XTOYBIRD commands

Planned but not yet implemented

  * **MOVE**
  * **UIDPLUS**
  * **QUOTA**
  * **X-GM-EXT-1** except for **SEARCH X-GM-RAW**
  * **AUTH=XOAUTH2** (maybe **AUTH=XOAUTH2** also)

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
  * Maybe even enabling/disabling plugins but this would require restarting the server

```
C: A1 XTOYBIRD ENABLE ID UIDPLUS
S: * XTOYBIRD ENABLED ID
S: * XTOYBIRD ENABLED UIDPLUS
S: A1 XTOYBIRD completed. Restart required
C: A2 RESTART
* BYE Server is Restarting
```

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


# License

**MIT**
