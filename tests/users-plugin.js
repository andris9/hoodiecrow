var imapper = require("../lib/server"),
    mockClient = require("../lib/mock-client"),
	sinon = require('sinon'),
	users = {authenticate: sinon.stub()}
;

var IMAP_PORT = 4143,
    instance = 0;

module.exports["Users plugin"] = {
    setUp: function(done) {
			// make sure that calling authenticate does the right thing
			users.authenticate.callsArg(1);
      this.server = imapper({
          plugins: ["AUTH-PLAIN"],
        	users: users
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

    "Calls User.authenticate": function(test) {
    var user = "testuser", pass = "testpass", cmds = ["A1 CAPABILITY",
        "A2 AUTHENTICATE PLAIN",
        new Buffer("\x00"+user+"\x00"+pass, "utf-8").toString("base64"),
        "ZZ LOGOUT"
    ];

    mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
        resp = resp.toString();
        test.ok(resp.indexOf("\nA2 OK") >= 0);
				test.ok(users.authenticate.calledOnce);
				test.ok(users.authenticate.calledWith({username: user, password: pass}));
        test.done();
    }).bind(this));
    }
};

