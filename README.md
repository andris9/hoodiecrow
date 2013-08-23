# toybird

Toybird is supposed to be a scriptable IMAP server for client testing. Currently it doesn't do much - a user can sign in, list mailbxes, fetch some messages and enter IDLE.

**NB** this is a proof of concept module, not yet something actually usable.

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
  * `NOOP`
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

## Issues

BODYSTRUCTURE is generated correctly even for complex messages but line number count is a bit off, not sure how this is exactly calculated (trim empty lines at end etc.?)

# License

**MIT**