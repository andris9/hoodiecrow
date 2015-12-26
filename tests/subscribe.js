var imapper = require("./resources/init"),
    mockClient = require("../lib/mock-client"),
data = require('imapper-storage-memory');


var IMAP_PORT = 4143,
    instance = 0,
	MSGS = {
    "INBOX": {
        messages: []
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
        this.server = imapper({
            plugins: ["NAMESPACE"]
        });
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

    "SUBSCRIBE No Folder": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SUBSCRIBE Foo",
						"A3 LSUB \"\" \"*\"",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf('\n* LSUB (\\HasNoChildren) "/" "INBOX"\r\n') >= 0);
            test.ok(resp.indexOf('\n* LSUB (\\HasNoChildren) "/" "Foo"\r\n') < 0);
            test.ok(resp.indexOf("\nA2 BAD") >= 0);
            test.done();
        }).bind(this));
    },

    "SUBSCRIBE Valid Folder": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 SUBSCRIBE Test",
						"A3 LSUB \"\" \"*\"",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf('\n* LSUB (\\HasNoChildren) "/" "INBOX"\r\n') >= 0);
            test.ok(resp.indexOf('\n* LSUB (\\HasNoChildren) "/" "Test"\r\n') >= 0);
            test.ok(resp.indexOf("\nA2 OK") >= 0);
            test.done();
        }).bind(this));
    }
};
