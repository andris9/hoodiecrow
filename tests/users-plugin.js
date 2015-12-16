var imapper = require("../lib/server"),
    mockClient = require("../lib/mock-client"),
	sinon = require('sinon'),
	stub = sinon.stub(),
	users = {authenticate: stub}
;

var IMAP_PORT = 4143,
    instance = 0;

module.exports["No users plugin defined"] = {
    setUp: function(done) {
			// make sure that calling authenticate does the right thing
			stub.callsArg(1);
      this.server = imapper({
          plugins: ["AUTH-PLAIN"]
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

    "AUTH-PLAIN Should return failure": function(test) {
	    var user = "testuser", pass = "testpass", cmds = ["A1 CAPABILITY",
	        "A2 AUTHENTICATE PLAIN",
	        new Buffer("\x00"+user+"\x00"+pass, "utf-8").toString("base64"),
	        "ZZ LOGOUT"
	    ];
			stub.reset();
	    mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
	        resp = resp.toString();
	        test.ok(resp.indexOf("\nA2 NO") >= 0);
					test.ok(!stub.called);
	        test.done();
	    }).bind(this));
    },
		
    "LOGIN Should return failure": function(test) {
	    var user = "testuser", pass = "testpass", cmds = ["A1 CAPABILITY",
	        "A2 LOGIN "+user+' '+pass,
	        "ZZ LOGOUT"
	    ];

			stub.reset();
	    mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
	        resp = resp.toString();
	        test.ok(resp.indexOf("\nA2 NO") >= 0);
					test.ok(!stub.called);
	        test.done();
	    }).bind(this));
    }
};

module.exports["Users plugin defined"] = {
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

    "AUTH-PLAIN should call User.authenticate": function(test) {
	    var user = "testuser", pass = "testpass", cmds = ["A1 CAPABILITY",
	        "A2 AUTHENTICATE PLAIN",
	        new Buffer("\x00"+user+"\x00"+pass, "utf-8").toString("base64"),
	        "ZZ LOGOUT"
	    ];

			stub.reset();
	    mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
	        resp = resp.toString();
	        test.ok(resp.indexOf("\nA2 OK") >= 0);
					test.ok(stub.calledOnce);
					test.deepEqual(stub.getCall(0).args[0],{username: user, password: pass, method: 'PLAIN'});
	        test.done();
	    }).bind(this));
    },
		
    "LOGIN should call User.authenticate": function(test) {
	    var user = "testuser", pass = "testpass", cmds = ["A1 CAPABILITY",
	        "A2 LOGIN "+user+' '+pass,
	        "ZZ LOGOUT"
	    ];

			stub.reset();
	    mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
	        resp = resp.toString();
	        test.ok(resp.indexOf("\nA2 OK") >= 0);
					test.ok(stub.calledOnce);
					test.deepEqual(stub.getCall(0).args[0],{username: user, password: pass, method: 'LOGIN'});
	        test.done();
	    }).bind(this));
    }
};

