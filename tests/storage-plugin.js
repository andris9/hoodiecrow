var imapper = require("./resources/init"), _ = require('lodash'),
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
		getFolder: sinon.stub(),
		createFolder: sinon.stub(),
		delFolder: sinon.stub(),
		renameFolder: sinon.stub(),
		createMessage: sinon.stub(),
		addFlags: sinon.stub(),
		removeFlags: sinon.stub(),
		replaceFlags: sinon.stub(),
		addProperties: sinon.stub(),
		removeProperties: sinon.stub(),
		replaceProperties: sinon.stub(),
		namespace: sinon.stub(),
		getNamespaces: sinon.stub(),
		matchFolders: sinon.stub(),
		getMessageRange: sinon.stub(),
		setFolderSpecialUse: sinon.stub(),
		searchMessages: sinon.stub(),
		subscribeFolder: sinon.stub(),
		expunge: sinon.stub()
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
		flags: ["\\Deleted","\\Seen","ABC"],
		uid: 265
	}
;

mstub.returns(mailboxStub);
mailboxStub.getFolder.callsArgWith(1,null,folderStub);
mailboxStub.createFolder.callsArgWith(1,null,folderStub);
mailboxStub.delFolder.callsArg(1);
mailboxStub.renameFolder.callsArg(2);
mailboxStub.createMessage.callsArg(2);
mailboxStub.addFlags.callsArgWith(4,[{id:1}]);
mailboxStub.replaceFlags.callsArgWith(4,[{id:1}]);
mailboxStub.removeFlags.callsArgWith(4,[{id:1}]);
mailboxStub.addProperties.callsArgWith(4,[{id:1}]);
mailboxStub.replaceProperties.callsArgWith(4,[{id:1}]);
mailboxStub.removeProperties.callsArgWith(4,[{id:1}]);
mailboxStub.namespace.callsArgWith(1,null,{separator:'/'});
mailboxStub.getNamespaces.callsArgWith(0,["INBOX",""]);
mailboxStub.matchFolders.callsArgWith(2,null,[folderStub]);
mailboxStub.getMessageRange.callsArgWith(3,null,[_.extend({index:1},messageStub),null]);
mailboxStub.setFolderSpecialUse.callsArg(2);
mailboxStub.searchMessages.callsArgWith(2,null,[{index:1,uid:messageStub.uid}]);
mailboxStub.subscribeFolder.callsArg(1);
mailboxStub.expunge.callsArg(1);



var IMAP_PORT = 4143,
    instance = 0;


module.exports["Storage plugin defined"] = {
    setUp: function(done) {
      this.server = imapper({
          plugins: ["AUTH-PLAIN","NAMESPACE","SPECIAL-USE", "CREATE-SPECIAL-USE","X-GM-EXT-1"],
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
		},

    "CREATE should call mailbox.create": function(test) {
        var folder = "sub/folder/name", cmds = ["A1 CAPABILITY",
            "A2 LOGIN testuser testpass",
            "A3 CREATE "+folder,
            "A4 LIST \"\" \"*\"",
            "ZZ LOGOUT"
        ];
				mailboxStub.createFolder.reset();
        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\nA3 OK") >= 0);
						test.ok(mailboxStub.createFolder.calledOnce);
						test.equal(mailboxStub.createFolder.getCall(0).args[0],folder);
            test.done();
        }).bind(this));
    },

    "DELETE should call mailbox.delete": function(test) {
        var folder = "sub/folder/name", cmds = ["A1 LOGIN testuser testpass",
            "A2 CREATE "+folder,
            "A3 DELETE "+folder,
            "ZZ LOGOUT"
        ];
				mailboxStub.delFolder.reset();
        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\nA2 OK") >= 0);
            test.ok(resp.indexOf("\nA3 OK") >= 0);
						test.ok(mailboxStub.delFolder.calledOnce);
						test.equal(mailboxStub.delFolder.getCall(0).args[0],folder);
            test.done();
        }).bind(this));
    },

    "RENAME should call mailbox.rename": function(test) {
        var folder = "sub/folder/name", newfolder = "sub/folder/newname", cmds = ["A1 CAPABILITY",
            "A2 LOGIN testuser testpass",
            "A3 CREATE "+folder,
            "A4 RENAME "+folder+" "+newfolder,
            "ZZ LOGOUT"
        ];
				mailboxStub.renameFolder.reset();
        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\nA3 OK") >= 0);
            test.ok(resp.indexOf("\nA4 OK") >= 0);
						test.ok(mailboxStub.renameFolder.calledOnce);
						test.equal(mailboxStub.renameFolder.getCall(0).args[0],folder);
						test.equal(mailboxStub.renameFolder.getCall(0).args[1],newfolder);
            test.done();
        }).bind(this));
    },
		
    "APPEND should call mailbox.createMessage": function(test) {
        var message = "From: sender <sender@example.com>\r\nTo: receiver@example.com\r\nSubject: HELLO!\r\n\r\nWORLD!",
				folder = "INBOX",
        cmds = ["A1 CAPABILITY",
            "A2 LOGIN testuser testpass",
            "A3 SELECT "+folder,
            "A4 APPEND "+folder+" {" + message.length + "}\r\n" + message,
            "ZZ LOGOUT"
        ];
				mailboxStub.createMessage.reset();
        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
						var msg;
            resp = resp.toString();
            test.ok(resp.indexOf("\nA4 OK") >= 0);
						test.ok(mailboxStub.createMessage.calledOnce);
						test.equal(mailboxStub.createMessage.getCall(0).args[0],folder);
						msg = mailboxStub.createMessage.getCall(0).args[1];
						test.equal(msg.raw,message);
            test.done();
        }).bind(this));
    },
		
    "FETCH should call mailbox.getMessageRange": function(test) {
        var folder = "INBOX", range = "1:5,10,15:18", cmds = ["A1 LOGIN testuser testpass",
            "A2 EXAMINE "+folder,
            "A3 FETCH "+range+" (BODY)",
            "ZZ LOGOUT"
        ];
				mailboxStub.getMessageRange.reset();
        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
						test.ok(mailboxStub.getMessageRange.calledOnce);
						test.equal(mailboxStub.getMessageRange.getCall(0).args[0],folder);
						test.equal(mailboxStub.getMessageRange.getCall(0).args[1],range);
						test.equal(mailboxStub.getMessageRange.getCall(0).args[2],false);
            test.done();
        }).bind(this));
    },
    "UID FETCH should call mailbox.getMessageRange": function(test) {
        var folder = "INBOX", range = "1:5,10,15:18", cmds = ["A1 LOGIN testuser testpass",
            "A2 EXAMINE "+folder,
            "A3 UID FETCH "+range+" (BODY)",
            "ZZ LOGOUT"
        ];
				mailboxStub.getMessageRange.reset();
        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
						test.ok(mailboxStub.getMessageRange.calledOnce);
						test.equal(mailboxStub.getMessageRange.getCall(0).args[0],folder);
						test.equal(mailboxStub.getMessageRange.getCall(0).args[1],range);
						test.equal(mailboxStub.getMessageRange.getCall(0).args[2],true);
            test.done();
        }).bind(this));
    },

    "NAMESPACE should call mailbox.getNamespaces": function(test) {
        var cmds = ["A1 LOGIN testuser testpass",
            "A2 NAMESPACE",
            "ZZ LOGOUT"
        ];
				mailboxStub.getNamespaces.reset();
        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\nA2 OK") >= 0);
						test.ok(mailboxStub.getNamespaces.calledOnce);
            test.done();
        }).bind(this));
    },
		
    "CREATE-SPECIAL-USE should call mailbox.setFolderSpecialUse": function(test) {
        var folder = "MySpecial", cmds = ["A1 CAPABILITY",
            "A2 LOGIN testuser testpass",
            "A3 CREATE "+folder+" (USE (\\Sent \\Flagged))",
            "ZZ LOGOUT"
        ];
				mailboxStub.setFolderSpecialUse.reset();
        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\nA3 OK") >= 0);
						test.ok(mailboxStub.setFolderSpecialUse.calledOnce);
						test.equal(mailboxStub.setFolderSpecialUse.getCall(0).args[0],folder);
            test.done();
        }).bind(this));
    },
		
    "EXPUNGE should call mailbox.expunge": function(test) {
        var folder = "INBOX", cmds = ["A1 CAPABILITY",
            "A2 LOGIN testuser testpass",
            "A3 SELECT "+folder,
            "A4 EXPUNGE",
            "ZZ LOGOUT"
        ];
				mailboxStub.expunge.reset();
        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
						test.ok(mailboxStub.expunge.calledOnce);
						test.equal(mailboxStub.expunge.getCall(0).args[0],folder);
            test.done();
        }).bind(this));
    },
		
    "SUBSCRIBE should call mailbox.subscribe": function(test) {
        var folder = "Test", cmds = ["A1 LOGIN testuser testpass",
            "A2 SUBSCRIBE "+folder,
            "ZZ LOGOUT"
        ];
				mailboxStub.subscribeFolder.reset();
        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
						test.ok(mailboxStub.subscribeFolder.calledOnce);
						test.equal(mailboxStub.subscribeFolder.getCall(0).args[0],folder);
            test.done();
        }).bind(this));
    },

    "SEARCH should call mailbox.searchMessages": function(test) {
        var folder = "INBOX", cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT "+folder,
            "A3 SEARCH ANSWERED",
            "ZZ LOGOUT"
        ];
				mailboxStub.searchMessages.reset();
        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
						test.equal(mailboxStub.searchMessages.getCall(0).args[0],folder);
						// WE DO NOT CHECK THE SEARCH QUERY!!
						// There already is tests/search-query.js to test conversions
            test.done();
        }).bind(this));
    },
		
    "STORE +FLAGS should call mailbox.addFlags": function(test) {
        var folder = "INBOX", range = "1:5", flags = "\\Deleted",
				cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT "+folder,
            "A3 STORE "+range+" +FLAGS ("+flags+")",
            "ZZ LOGOUT"
        ];
				mailboxStub.addFlags.reset();
        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
						test.equal(mailboxStub.addFlags.getCall(0).args[0],folder);
						test.equal(mailboxStub.addFlags.getCall(0).args[1],range);
						test.equal(mailboxStub.addFlags.getCall(0).args[2],false);
						test.deepEqual(mailboxStub.addFlags.getCall(0).args[3],[flags]);
            test.done();
        }).bind(this));
    },

    "UID STORE +FLAGS should call mailbox.addFlags": function(test) {
        var folder = "INBOX", range = "1:5", flags = "\\Deleted",
				cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT "+folder,
            "A3 UID STORE "+range+" +FLAGS ("+flags+")",
            "ZZ LOGOUT"
        ];
				mailboxStub.addFlags.reset();
        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
						test.equal(mailboxStub.addFlags.getCall(0).args[0],folder);
						test.equal(mailboxStub.addFlags.getCall(0).args[1],range);
						test.equal(mailboxStub.addFlags.getCall(0).args[2],true);
						test.deepEqual(mailboxStub.addFlags.getCall(0).args[3],[flags]);
            test.done();
        }).bind(this));
    },
		
    "STORE FLAGS should call mailbox.replaceFlags": function(test) {
        var folder = "INBOX", range = "1:5", flags = "\\Deleted",
				cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT "+folder,
            "A3 STORE "+range+" FLAGS ("+flags+")",
            "ZZ LOGOUT"
        ];
				mailboxStub.replaceFlags.reset();
        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
						test.equal(mailboxStub.replaceFlags.getCall(0).args[0],folder);
						test.equal(mailboxStub.replaceFlags.getCall(0).args[1],range);
						test.equal(mailboxStub.replaceFlags.getCall(0).args[2],false);
						test.deepEqual(mailboxStub.replaceFlags.getCall(0).args[3],[flags]);
            test.done();
        }).bind(this));
    },

    "UID STORE FLAGS should call mailbox.replaceFlags": function(test) {
        var folder = "INBOX", range = "1:5", flags = "\\Deleted",
				cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT "+folder,
            "A3 UID STORE "+range+" FLAGS ("+flags+")",
            "ZZ LOGOUT"
        ];
				mailboxStub.replaceFlags.reset();
        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
						test.equal(mailboxStub.replaceFlags.getCall(0).args[0],folder);
						test.equal(mailboxStub.replaceFlags.getCall(0).args[1],range);
						test.equal(mailboxStub.replaceFlags.getCall(0).args[2],true);
						test.deepEqual(mailboxStub.replaceFlags.getCall(0).args[3],[flags]);
            test.done();
        }).bind(this));
    },

    "STORE -FLAGS should call mailbox.removeFlags": function(test) {
        var folder = "INBOX", range = "1:5", flags = "\\Deleted",
				cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT "+folder,
            "A3 STORE "+range+" -FLAGS ("+flags+")",
            "ZZ LOGOUT"
        ];
				mailboxStub.removeFlags.reset();
        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
						test.equal(mailboxStub.removeFlags.getCall(0).args[0],folder);
						test.equal(mailboxStub.removeFlags.getCall(0).args[1],range);
						test.equal(mailboxStub.removeFlags.getCall(0).args[2],false);
						test.deepEqual(mailboxStub.removeFlags.getCall(0).args[3],[flags]);
            test.done();
        }).bind(this));
    },

    "UID STORE -FLAGS should call mailbox.removeFlags": function(test) {
        var folder = "INBOX", range = "1:5", flags = "\\Deleted",
				cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT "+folder,
            "A3 UID STORE "+range+" -FLAGS ("+flags+")",
            "ZZ LOGOUT"
        ];
				mailboxStub.removeFlags.reset();
        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
						test.equal(mailboxStub.removeFlags.getCall(0).args[0],folder);
						test.equal(mailboxStub.removeFlags.getCall(0).args[1],range);
						test.equal(mailboxStub.removeFlags.getCall(0).args[2],true);
						test.deepEqual(mailboxStub.removeFlags.getCall(0).args[3],[flags]);
            test.done();
        }).bind(this));
    },
		


    "STORE +PROPERTY should call mailbox.addProperties": function(test) {
        var folder = "INBOX", range = "2:6", name = "X-GM-LABELS", props = "foo", cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT "+folder,
            "A3 STORE "+range+" +"+name+" ("+props+")",
            "ZZ LOGOUT"
        ], expect = {};
				expect[name] = [props];
				mailboxStub.addProperties.reset();
        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
						test.equal(mailboxStub.addProperties.getCall(0).args[0],folder);
						test.equal(mailboxStub.addProperties.getCall(0).args[1],range);
						test.equal(mailboxStub.addProperties.getCall(0).args[2],false);
						test.deepEqual(mailboxStub.addProperties.getCall(0).args[3],expect);
            test.done();
        }).bind(this));
    },

    "UID STORE +PROPERTY should call mailbox.addProperties": function(test) {
        var folder = "INBOX", range = "2:6", name = "X-GM-LABELS", props = "foo", cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT "+folder,
            "A3 UID STORE "+range+" +"+name+" ("+props+")",
            "ZZ LOGOUT"
		    ], expect = {};
				expect[name] = [props];
				mailboxStub.addProperties.reset();
        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
						test.equal(mailboxStub.addProperties.getCall(0).args[0],folder);
						test.equal(mailboxStub.addProperties.getCall(0).args[1],range);
						test.equal(mailboxStub.addProperties.getCall(0).args[2],true);
						test.deepEqual(mailboxStub.addProperties.getCall(0).args[3],expect);
            test.done();
        }).bind(this));
    },

    "STORE PROPERTY should call mailbox.replaceProperties": function(test) {
        var folder = "INBOX", range = "2:6", name = "X-GM-LABELS", props = "foo", cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT "+folder,
            "A3 STORE "+range+" "+name+" ("+props+")",
            "ZZ LOGOUT"
		    ], expect = {};
				expect[name] = [props];
				mailboxStub.replaceProperties.reset();
        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
						test.equal(mailboxStub.replaceProperties.getCall(0).args[0],folder);
						test.equal(mailboxStub.replaceProperties.getCall(0).args[1],range);
						test.equal(mailboxStub.replaceProperties.getCall(0).args[2],false);
						test.deepEqual(mailboxStub.replaceProperties.getCall(0).args[3],expect);
            test.done();
        }).bind(this));
    },

    "UID STORE PROPERTY should call mailbox.replaceProperties": function(test) {
        var folder = "INBOX", range = "2:6", name = "X-GM-LABELS", props = "foo", cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT "+folder,
            "A3 UID STORE "+range+" "+name+" ("+props+")",
            "ZZ LOGOUT"
		    ], expect = {};
				expect[name] = [props];
				mailboxStub.replaceProperties.reset();
        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
						test.equal(mailboxStub.replaceProperties.getCall(0).args[0],folder);
						test.equal(mailboxStub.replaceProperties.getCall(0).args[1],range);
						test.equal(mailboxStub.replaceProperties.getCall(0).args[2],true);
						test.deepEqual(mailboxStub.replaceProperties.getCall(0).args[3],expect);
            test.done();
        }).bind(this));
    },

    "STORE -PROPERTY should call mailbox.removeProperties": function(test) {
        var folder = "INBOX", range = "2:6", name = "X-GM-LABELS", props = "foo", cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT "+folder,
            "A3 STORE "+range+" -"+name+" ("+props+")",
            "ZZ LOGOUT"
	    ], expect = {};
			expect[name] = [props];
				mailboxStub.removeProperties.reset();
        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
						test.equal(mailboxStub.removeProperties.getCall(0).args[0],folder);
						test.equal(mailboxStub.removeProperties.getCall(0).args[1],range);
						test.equal(mailboxStub.removeProperties.getCall(0).args[2],false);
						test.deepEqual(mailboxStub.removeProperties.getCall(0).args[3],expect);
            test.done();
        }).bind(this));
    },

    "UID STORE -PROPERTY should call mailbox.removeProperties": function(test) {
        var folder = "INBOX", range = "2:6", name = "X-GM-LABELS", props = "foo", cmds = ["A1 LOGIN testuser testpass",
            "A2 SELECT "+folder,
            "A3 UID STORE "+range+" -"+name+" ("+props+")",
            "ZZ LOGOUT"
		    ], expect = {};
				expect[name] = [props];
				mailboxStub.removeProperties.reset();
        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
						test.equal(mailboxStub.removeProperties.getCall(0).args[0],folder);
						test.equal(mailboxStub.removeProperties.getCall(0).args[1],range);
						test.equal(mailboxStub.removeProperties.getCall(0).args[2],true);
						test.deepEqual(mailboxStub.removeProperties.getCall(0).args[3],expect);
            test.done();
        }).bind(this));
    }	
};

