var toybird = require("../lib/server"),
    mockClient = require("../lib/mock-client");

var IMAP_PORT = 4143,
    instance = 0;

module.exports["Auth Plain disabled"] = {
    setUp: function(done){
        this.server = toybird();

        this.instanceId = ++instance;
        this.server.listen(IMAP_PORT, (function(){
            done();
        }).bind(this));
    },

    tearDown: function(done){
        this.server.close((function(){
            done();
        }).bind(this));
    },

    "AUTH FAILS": function(test){
        var cmds = ["A1 CAPABILITY",
                "A2 AUTHENTICATE PLAIN",
                "ZZ LOGOUT"];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf(" AUTH=PLAIN") < 0);
            test.ok(resp.indexOf("\nA2 BAD") >= 0);
            test.done();
        }).bind(this));
    }
}

module.exports["Auth Plain enabled"] = {
    setUp: function(done){
        this.server = toybird({
            plugins: ["AUTH-PLAIN"]
        });

        this.instanceId = ++instance;
        this.server.listen(IMAP_PORT, (function(){
            done();
        }).bind(this));
    },

    tearDown: function(done){
        this.server.close((function(){
            done();
        }).bind(this));
    },

    "Invalid Login": function(test){
        var cmds = [
                "A1 CAPABILITY",
                "A2 AUTHENTICATE PLAIN",
                new Buffer("\x00wrong\x00pass", "utf-8").toString("base64"),
                "ZZ LOGOUT"];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf(" AUTH=PLAIN") >= 0);
            test.ok(resp.indexOf("\nA2 NO") >= 0);
            test.done();
        }).bind(this));
    },

    "Login Success": function(test){
        var cmds = ["A1 CAPABILITY",
                "A2 AUTHENTICATE PLAIN",
                new Buffer("\x00testuser\x00testpass", "utf-8").toString("base64"),
                "ZZ LOGOUT"];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf("\nA2 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "Invalid SASL-IR Login": function(test){
        var cmds = [
                "A1 CAPABILITY",
                "A2 AUTHENTICATE PLAIN " + new Buffer("\x00testuser\x00testpass", "utf-8").toString("base64"),
                "ZZ LOGOUT"];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf(" AUTH=PLAIN") >= 0);
            test.ok(!resp.match(/^\* CAPABILITY\b.*?\bSASL\-IR\b/m));
            test.ok(resp.indexOf("\nA2 BAD") >= 0);
            test.done();
        }).bind(this));
    }
};

module.exports["Auth Plain with SASL-IR"] = {
    setUp: function(done){
        this.server = toybird({
            plugins: ["SASL-IR", "AUTH-PLAIN"]
        });

        this.instanceId = ++instance;
        this.server.listen(IMAP_PORT, (function(){
            done();
        }).bind(this));
    },

    tearDown: function(done){
        this.server.close((function(){
            done();
        }).bind(this));
    },

    "Invalid Login": function(test){
        var cmds = [
                "A1 CAPABILITY",
                "A2 AUTHENTICATE PLAIN " + new Buffer("\x00wrong\x00pass", "utf-8").toString("base64"),
                "ZZ LOGOUT"];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp){
            resp = resp.toString();
            test.ok(resp.match(/^\* CAPABILITY\b.*?\bSASL\-IR\b/m));
            test.ok(resp.indexOf(" AUTH=PLAIN") >= 0);
            test.ok(resp.indexOf("\nA2 NO") >= 0);
            test.done();
        }).bind(this));
    },

    "Login Success": function(test){
        var cmds = ["A1 CAPABILITY",
                "A2 AUTHENTICATE PLAIN",
                new Buffer("\x00testuser\x00testpass", "utf-8").toString("base64"),
                "ZZ LOGOUT"];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp){
            resp = resp.toString();
            test.ok(resp.match(/^\* CAPABILITY\b.*?\bSASL\-IR\b/m));
            test.ok(resp.indexOf("\nA2 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "Successful SASL-IR Login": function(test){
        var cmds = [
                "A1 CAPABILITY",
                "A2 AUTHENTICATE PLAIN " + new Buffer("\x00testuser\x00testpass", "utf-8").toString("base64"),
                "ZZ LOGOUT"];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf(" AUTH=PLAIN") >= 0);
            test.ok(resp.match(/^\* CAPABILITY\b.*?\bSASL\-IR\b/m));
            test.ok(resp.indexOf("\nA2 OK") >= 0);
            test.done();
        }).bind(this));
    }
}
