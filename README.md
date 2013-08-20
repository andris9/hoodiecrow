# toybird

Toybird is supposed to be a scriptable example IMAP server. Currently it doesn't do much - a user can sign in, list mailbxes, fetch some messages (no BODY support yet) and enter IDLE.

**NB** this is a proof of concept module, not yet something actually usable.

## Usage

Install toybird and run sample application.

    git clone git@github.com:andris9/toybird.git
    cd toybird
    npm install
    node example.js

The sample application defines IMAP directory structure, enables ID and IDLE extensions and starts the server. When the server is running, the application creates a client that connects to it. The client lists available mailboxes, selects INBOX and fetches some message data from it.

# License

**MIT**