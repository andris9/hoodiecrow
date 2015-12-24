var imapper = require("./resources/init"),
    mockClient = require("../lib/mock-client"),
	data = require('./resources/memory-storage-plugin')
;

var IMAP_PORT = 4143,
    instance = 0;

module.exports["Normal login"] = {
    setUp: function(done) {
        this.server = imapper();

				data.load({
                "INBOX": {
                    messages: [{
                        raw: "Subject: hello 1\r\n\r\nWorld 1!",
                        internaldate: "14-Sep-2013 21:22:28 -0300",
                        flags: "\\Deleted"
                    }]
                }
            });
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
    "EXAMINE existent": function(test) {
        var cmds = ["A1 CAPABILITY",
            "A2 LOGIN testuser testpass",
            "A3 EXAMINE INBOX",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "EXAMINE non-existent": function(test) {
      var cmds = ["A1 CAPABILITY",
          "A2 LOGIN testuser testpass",
          "A3 EXAMINE Foo",
          "ZZ LOGOUT"
      ];

      mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
          resp = resp.toString();
          test.ok(resp.indexOf("\nA3 NO") >= 0);
          test.done();
      }).bind(this));

  }
};