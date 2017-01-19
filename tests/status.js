var imapper = require("./resources/init"),
  mockClient = require("../lib/mock-client"),
  data = require('imapper-storage-memory');


var IMAP_PORT = 4143,
  instance = 0,
  MSGS = {
    "INBOX": {
      messages: [
        {
          raw: "Subject: hello 1\r\n\r\nWorld 1!",
          internaldate: "14-Sep-2013 21:22:28 -0300",
          flags: "\\Seen"
        },
        {
          raw: "Subject: hello 2\r\n\r\nWorld 2!",
          internaldate: "14-Sep-2013 21:22:28 -0300",
          flags: "\\Deleted"
        },
        {
          raw: "Subject: hello 3\r\n\r\nWorld 3!",
          internaldate: "14-Sep-2013 21:22:28 -0300",
          flags: ["\\Deleted","\\Recent"]
        }
      ]
    },
    "": {
      folders: {
        "Test": {
          subscribed: false
        }
      }
    }
  };

module.exports["imapper tests"] = {
  setUp: function(done) {
    this.server = imapper();
    data.load(MSGS);
    this.instanceId = ++instance;
    this.server.listen(IMAP_PORT, (function() {
      done();
    }).bind(this));
  },

  tearDown: function(done) {
    this.server.close((function() {
      done();
    }).bind(this));
  },

  "STATUS No Folder": function(test) {
    var cmds = ["A1 LOGIN testuser testpass",
        "A2 STATUS Foo (UIDNEXT UIDVALIDITY RECENT UNSEEN MESSAGES)",
        "ZZ LOGOUT"
    ];

    mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
      resp = resp.toString();
      test.ok(resp.indexOf("\nA2 NO") >= 0);
      test.done();
    }).bind(this));
  },

  "STATUS Valid Folder": function(test) {
    var cmds = ["A1 LOGIN testuser testpass",
        "A2 STATUS INBOX (UIDNEXT UIDVALIDITY RECENT UNSEEN MESSAGES)",
        "ZZ LOGOUT"
    ];

    mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
      resp = resp.toString();
      test.ok(resp.indexOf('\n* STATUS INBOX (UIDNEXT 1 UIDVALIDITY 1 RECENT 1 UNSEEN 2 MESSAGES 3)\r\n') >= 0);
      test.ok(resp.indexOf("\nA2 OK") >= 0);
      test.done();
    }).bind(this));
  }
};
