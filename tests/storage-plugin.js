var imapper = require("./resources/init"),
    mockClient = require("../lib/mock-client"),
	sinon = require('sinon'),
	FOLDER = "INBOX",
	MAILBOX = "testuser",
	TS = new Date().getTime(),
	storage = {mailbox: sinon.stub()},
	mailboxStub = {
		folders: sinon.stub(),
		get: sinon.stub(),
		create: sinon.stub()
	},
	folderStub = {
		properties: {
			id: FOLDER
		},
		status: {
      flags: {"abc":1},
      seen: 1,
      unseen: 0,
      permanentFlags: ["Deleted","Seen","abc"]
    },
		del: sinon.stub(),
		rename: sinon.stub(),
		createMessage: sinon.stub(),
		list: sinon.stub(),
		search: sinon.stub(),
		get: sinon.stub()
	},
	messageStub = {
		properties: {
			timestamp: TS
		},
		raw: "This is a message",
		raw_url: "http://localhost/raw",
		headers: "From: me@you.com\n\rTo: you@me.com",
		headers_url: "http://localhost/headers",
		html: "<html><body><h1>Message</h1></body></html>",
		html_url: "http://localhost/html",
		attachments: ["Attachment1","Attachment2"],
		del: sinon.stub(),
		move: sinon.stub(),
		read: sinon.stub(),
		star: sinon.stub()
	}
;

storage.mailbox.returns(mailboxStub);
mailboxStub.get.callsArgWith(1,null,folderStub);
folderStub.del.callsArg(0);
folderStub.rename.callsArg(1);
folderStub.createMessage.callsArgWith(1,null,messageStub);
folderStub.list.callsArgWith(0,null,[FOLDER]);
folderStub.search.callsArgWith(1,null,[messageStub.id]);
folderStub.get.callsArgWith(1,null,messageStub);
messageStub.del.callsArg(0);
messageStub.move.callsArg(1);
messageStub.read.callsArg(1);
messageStub.star.callsArg(1);




var IMAP_PORT = 4143,
    instance = 0;


module.exports["Storage plugin defined"] = {
    setUp: function(done) {
      this.server = imapper({
          plugins: ["AUTH-PLAIN"],
        	storage: storage
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

    "AUTHENTICATE should call connection.mailbox": function(test) {
	    var user = "testuser", pass = "testpass", cmds = ["A1 CAPABILITY",
	        "A2 AUTHENTICATE PLAIN",
	        new Buffer("\x00"+user+"\x00"+pass, "utf-8").toString("base64"),
	        "ZZ LOGOUT"
	    ];

			storage.mailbox.reset();
	    mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
	        resp = resp.toString();
	        test.ok(resp.indexOf("\nA2 OK") >= 0);
					test.ok(storage.mailbox.calledOnce);
					test.equal(storage.mailbox.getCall(0).args[0],MAILBOX);
	        test.done();
	    }).bind(this));
    },
		
    "LOGIN should call connection.mailbox": function(test) {
	    var user = "testuser", pass = "testpass", cmds = ["A1 CAPABILITY",
	        "A2 LOGIN "+user+' '+pass,
	        "ZZ LOGOUT"
	    ];

			storage.mailbox.reset();
	    mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
	        resp = resp.toString();
	        test.ok(resp.indexOf("\nA2 OK") >= 0);
					test.ok(storage.mailbox.calledOnce);
					test.equal(storage.mailbox.getCall(0).args[0],MAILBOX);
	        test.done();
	    }).bind(this));
    },
		
		"SELECT should call mailbox.get": function (test) {
	    var user = "testuser", pass = "testpass", cmds = ["A1 CAPABILITY",
	        "A2 LOGIN "+user+' '+pass,
					"A3 SELECT INBOX",
	        "ZZ LOGOUT"
	    ];

			mailboxStub.get.reset();
	    mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
	        resp = resp.toString();
	        test.ok(resp.indexOf("\nA3 OK") >= 0);
					test.ok(mailboxStub.get.calledOnce);
					test.equal(mailboxStub.get.getCall(0).args[0],"INBOX");
	        test.done();
	    }).bind(this));
		}
};

/*
   EXAMINE, CREATE, DELETE, RENAME, SUBSCRIBE, UNSUBSCRIBE, LIST, LSUB,
   STATUS, and APPEND.
*/
