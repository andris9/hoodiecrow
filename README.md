# Hoodiecrow

![It's a dove - I know - but I didn't have a proper hoodiecrow picture in my computer](https://raw.github.com/andris9/hoodiecrow/master/hoodiecrow.jpg)

*It's a dove - I know - but I didn't have a proper hoodiecrow picture*

Hoodiecrow is a scriptable IMAP server for client integration testing. Currently it offers partial IMAP4ver1 support and some optional plugins that can be turned on and off.

[![Build Status](https://secure.travis-ci.org/andris9/hoodiecrow.png)](http://travis-ci.org/andris9/hoodiecrow)
[![NPM version](https://badge.fury.io/js/hoodiecrow.png)](http://badge.fury.io/js/hoodiecrow)

# Usage

### Run as a standalone server

Install Hoodiecrow with [npm](http://npmjs.org/)

```bash
npm install -g hoodiecrow
hoodiecrow --help
sudo hoodiecrow
```

Sudo is needed to bind to port 143. If you choose to use a higher port, say 1143, you do not need to use sudo.

`hoodiecrow --help` displays useful information about command line options for Hoodiecrow and some sample configuration data.

After you have started Hoodiecrow server, you can point your IMAP client to localhost:143

### Include as a Node.js module

Add `hoodiecrow` dependnecy

```bash
npm install hoodiecrow
```

Create and start an IMAP server

```javascript
var hoodiecrow = require("hoodiecrow"),
    server = hoodiecrow(options);
server.listen(143);
```

See [example.js](https://github.com/andris9/hoodiecrow/blob/master/example.js) for an example configuration.

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

  * **AUTH=PLAIN** (supports **SASL-IR**, ignores **LOGINDISABLED**)
  * **CONDSTORE** partial, see below for CONDSTORE support
  * **ENABLE**
  * **ID**
  * **IDLE**
  * **LITERALPLUS**
  * **LOGINDISABLED** is effective with LOGIN when connection is unencrypted but does not affect AUTH=PLAIN
  * **NAMESPACE** no anonymous namespaces though
  * **SALS-IR**
  * **STARTTLS**
  * **UNSELECT**
  * **XTOYBIRD** to programmatically control Hoodiecrow through the IMAP protocol. Does not require login.

Planned but not yet implemented

  * **SPECIAL-USE** (maybe **XLIST** as well but probably not)
  * **MOVE**
  * **UIDPLUS**
  * **QUOTA**
  * **X-GM-EXT-1** except for **SEARCH X-GM-RAW**
  * **AUTH=XOAUTH2** (maybe **AUTH=XOAUTH2** also)

## Authentication

An user can always login with username `"testuser"` and password `"testpass"`. Any other credentials can be added as needed.

## Existing XTOYBIRD commands

To use these functions, XTOYBIRD plugin needs to be enabled

  * **XTOYBIRD SERVER** dumps server object as a LITERAL string. Useful for debugging current state.
  * **XTOYBIRD CONNECTION** dumps session object as a LITERAL string. Useful for debugging current state (includes socket info etc).
  * **XTOYBIRD STORAGE** outputs storage as a LITERAL strint (JSON). Useful for storing the storage for later usage.

Example

```
S: * Hoodiecrow ready for rumble
C: A1 XTOYBIRD STORAGE
S: * OK [JSON] {3224}
S: {
S:   "": {
S:       "folders": {
S:           "INBOX": {
S:               "messages": [
S:                   {
S:                       "raw": "Subject: hello 1\r\n\r\nWorld 1!",
S:                       ...
S: A1 OK XTOYBIRD Completed
```

## Useful features for Hoodiecrow I'd like to see

  * An ability to change UIDVALIDITY at runtime (eg. `A1 XTOYBIRD UIDVALIDITY INBOX 123` where 123 is the new UIDVALIDITY for INBOX)
  * An ability to change available disk space (eg. `A1 XTOYBIRD DISKSPACE 100 50` where 100 is total disk space in bytes and 50 is available space)
  * An ability to restart the server to return initial state (`A1 XTOYBIRD RESET`)
  * An ability to change storage runtime by sending a JSON string describing the entire storage (`A1 XTOYBIRD UPDATE {123}\r\n{"":{"INBOX":{...}}})`)
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

# Known issues

These issues will be fixed

  * **CONDSTORE** support is partial

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

To run all the tests.

# License

**MIT**
