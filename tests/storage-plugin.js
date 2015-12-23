var imapper = require("./resources/init"),
    mockClient = require("../lib/mock-client"),
	sinon = require('sinon'),
	FOLDER = "INBOX",
	MAILBOX = "testuser",
	TS = new Date().getTime(),
	mstub = sinon.stub(),
	storage = function () {
		return {mailbox: mstub};
	},
	mailboxStub = {
		folders: sinon.stub(),
		matchFolders: sinon.stub(),
		namespace: sinon.stub(),
		getFolder: sinon.stub(),
		createFolder: sinon.stub(),
		delFolder: sinon.stub(),
		renameFolder: sinon.stub(),
		createMessage: sinon.stub(),
		listMessages: sinon.stub(),
		getMessages: sinon.stub(),
		getMessageRange: sinon.stub(),
		delMessage: sinon.stub(),
		moveMessage: sinon.stub(),
		copyMessage: sinon.stub(),
		addFlags: sinon.stub(),
		replaceFlags: sinon.stub(),
		removeFlags: sinon.stub(),
		addProperties: sinon.stub(),
		removeProperties: sinon.stub(),
		replaceProperties: sinon.stub(),
		setFolderSpecialUse: sinon.stub(),
		expunge: sinon.stub(),
		getNamespaces: sinon.stub(),
		searchMessages: sinon.stub()
	},
	folderStub = {
		properties: {},
		id: FOLDER,
		flags: ["abc"],
		status: {
      flags: {"abc":1},
      seen: 1,
      unseen: 0,
      permanentFlags: ["Deleted","Seen","abc"]
    },
		separator: '/',
		path: 'INBOX'
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
		uid: 265
	}
;

mstub.returns(mailboxStub);
mailboxStub.folders.callsArgWith(0,null,[folderStub]);
mailboxStub.matchFolders.callsArgWith(2,null,[folderStub]);
mailboxStub.namespace.callsArgWith(1,null,{separator:'/'});
mailboxStub.getFolder.callsArgWith(1,null,folderStub);
mailboxStub.createFolder.callsArgWith(1,null,folderStub);
mailboxStub.delFolder.callsArg(1);
mailboxStub.renameFolder.callsArg(2);
mailboxStub.createMessage.callsArg(2);
mailboxStub.listMessages.callsArgWith(1,null,[messageStub]);
mailboxStub.getMessages.callsArgWith(3,null,[messageStub]);
mailboxStub.getMessageRange.callsArgWith(3,null,[messageStub]);
mailboxStub.delMessage.callsArg(2);
mailboxStub.moveMessage.callsArg(3);
mailboxStub.copyMessage.callsArg(3);
mailboxStub.addFlags.callsArg(4);
mailboxStub.replaceFlags.callsArg(4);
mailboxStub.removeFlags.callsArg(4);
mailboxStub.addProperties.callsArg(5);
mailboxStub.replaceProperties.callsArg(5);
mailboxStub.removeProperties.callsArg(5);
mailboxStub.setFolderSpecialUse.callsArg(2);
mailboxStub.expunge.callsArg(3);
mailboxStub.getNamespaces.callsArgWith(0,["INBOX",""]);
mailboxStub.searchMessages.callsArgWith(2,null,[{index:1,uid:messageStub.uid}]);



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

			mstub.reset();
	    mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
	        resp = resp.toString();
	        test.ok(resp.indexOf("\nA2 OK") >= 0);
					test.ok(mstub.calledOnce);
					test.equal(mstub.getCall(0).args[0],MAILBOX);
	        test.done();
	    }).bind(this));
    },
		
    "LOGIN should call connection.mailbox": function(test) {
	    var user = "testuser", pass = "testpass", cmds = ["A1 CAPABILITY",
	        "A2 LOGIN "+user+' '+pass,
	        "ZZ LOGOUT"
	    ];

			mstub.reset();
	    mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
	        resp = resp.toString();
	        test.ok(resp.indexOf("\nA2 OK") >= 0);
					test.ok(mstub.calledOnce);
					test.equal(mstub.getCall(0).args[0],MAILBOX);
	        test.done();
	    }).bind(this));
    },
		
		"SELECT should call mailbox.getFolder": function (test) {
	    var user = "testuser", pass = "testpass", cmds = ["A1 CAPABILITY",
	        "A2 LOGIN "+user+' '+pass,
					"A3 SELECT INBOX",
	        "ZZ LOGOUT"
	    ];
			mailboxStub.getFolder.reset();
	    mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
	        resp = resp.toString();
	        test.ok(resp.indexOf("\nA3 OK") >= 0);
					test.ok(mailboxStub.getFolder.calledOnce);
					test.equal(mailboxStub.getFolder.getCall(0).args[0],"INBOX");
	        test.done();
	    }).bind(this));
		},
		"EXAMINE should call mailbox.getFolder": function (test) {
	    var user = "testuser", pass = "testpass", cmds = ["A1 CAPABILITY",
	        "A2 LOGIN "+user+' '+pass,
					"A3 EXAMINE INBOX",
	        "ZZ LOGOUT"
	    ];
			mailboxStub.getFolder.reset();
	    mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
	        resp = resp.toString();
	        test.ok(resp.indexOf("\nA3 OK") >= 0);
					test.ok(mailboxStub.getFolder.calledOnce);
					test.equal(mailboxStub.getFolder.getCall(0).args[0],"INBOX");
	        test.done();
	    }).bind(this));
		},
		"LIST with argument should call mailbox.matchFolders": function (test) {
	    var user = "testuser", pass = "testpass", cmds = ["A1 CAPABILITY",
	        "A2 LOGIN "+user+' '+pass,
          "A3 LIST \"\" \"*\"",
	        "ZZ LOGOUT"
	    ];
			mailboxStub.matchFolders.reset();
	    mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
	        resp = resp.toString();
	        test.ok(resp.indexOf("\nA3 OK") >= 0);
					test.ok(mailboxStub.matchFolders.calledOnce);
					test.equal(mailboxStub.matchFolders.getCall(0).args[0],"");
					test.equal(mailboxStub.matchFolders.getCall(0).args[1],"*");
	        test.done();
	    }).bind(this));
		},
		"LIST without argument should call mailbox.namespace": function (test) {
	    var user = "testuser", pass = "testpass", cmds = ["A1 CAPABILITY",
	        "A2 LOGIN "+user+' '+pass,
          "A3 LIST \"\" \"\"",
	        "ZZ LOGOUT"
	    ];
			mailboxStub.namespace.reset();
	    mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
	        resp = resp.toString();
	        test.ok(resp.indexOf("\nA3 OK") >= 0);
					test.ok(mailboxStub.namespace.calledOnce);
					test.equal(mailboxStub.namespace.getCall(0).args[0],"");
	        test.done();
	    }).bind(this));
		}
};

/*
   CREATE, DELETE, RENAME, SUBSCRIBE, UNSUBSCRIBE, LIST, LSUB,
   STATUS, APPEND, SEARCH, FETCH
*/
