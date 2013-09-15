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

    "NOOP": function(test){
        var cmds = [
                "A1 NOOP",
                "ZZ LOGOUT"];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf("\nA1 OK") >= 0);
            test.done();
        }).bind(this));
    },

    "CHECK": function(test){
        var cmds = [
                "A1 CHECK",
                "ZZ LOGOUT"];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp){
            resp = resp.toString();
            test.ok(resp.indexOf("\nA1 OK") >= 0);
            test.done();
        }).bind(this));
    }
}