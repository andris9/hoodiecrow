# hoodiecrow

Hoodiecrow is supposed to be a scriptable IMAP server for client testing.

[![Build Status](https://secure.travis-ci.org/andris9/hoodiecrow.png)](http://travis-ci.org/andris9/hoodiecrow)
[![NPM version](https://badge.fury.io/js/hoodiecrow.png)](http://badge.fury.io/js/hoodiecrow)

## Scope

Hoodiecrow is a single user / multiple connections IMAP server that uses a JSON object as its directory and messages structure. Nothing is read from or written to disk and the entire directory structure is instantiated every time the server is started, eg. changes made through the IMAP protocol (adding/removing messages/flags etc) are not saved permanently. This should ensure that you can write unit tests for clients in a way where a new fresh server with unmodified data is started for every test.

Several clients can connect to the server simultanously but all the clients share the same user account, even if login credentials are different.

Hoodiecrow is extendable, any command can be overwritten, plugins can be added etc (see command folder for built in command examples and plugin folder for plugin examples).

## Authentication

An user can always login with username `"testuser"` and password `"testpass"`. Any other credentials can be added as needed.

## Status

### IMAP4rev1

  * **FETCH** and **UID FETCH** support is partial
  * No **SEARCH** or **UID SEARCH**
  * Other commands should be more or less ready

I'm trying to get these done one by one. Most of it was already implemented in the previous incarnation  of **hoodiecrow**, so I can copy and paste a lot.

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

## Existing XTOYBIRD commands

  * **XTOYBIRD SERVER** dumps server object as a LITERAL string. Useful for debugging current state.
  * **XTOYBIRD SERVER** dumps session object as a LITERAL string. Useful for debugging current state.
  * **XTOYBIRD STORAGE** outputs storage as a LITERAL strint (JSON). Useful for storing the storage for later usage.

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

  * **addr-adl** (at-domain-list) values are not supported, NIL is always used
  * **anonymous namespaces** are not supported
  * **STORE** returns NO and nothing is updated if there are pending EXPUNGE messages

# License

**MIT**
