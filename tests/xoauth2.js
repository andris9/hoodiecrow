var hoodiecrow = require("../lib/server"),
    mockClient = require("../lib/mock-client");

var IMAP_PORT = 4143,
    instance = 0;

module.exports["XOAUTH2"] = {
    setUp: function(done) {
        this.server = hoodiecrow({
            plugins: ["SASL-IR", "XOAUTH2"]
        });

        this.server.listen(IMAP_PORT, (function() {
            done();
        }).bind(this));
    },

    tearDown: function(done) {
        this.server.close((function() {
            done();
        }).bind(this));
    },

    "Invalid argument": function(test) {
        var cmds = [
            "A1 AUTHENTICATE XOAUTH2 zzzzz",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\nA1 NO") >= 0);
            test.done();
        }).bind(this));
    },

    "Unknown user": function(test) {
        var cmds = [
            "A1 AUTHENTICATE XOAUTH2 " + new Buffer(["user=unknown", "auth=Bearer zzz", "", ""].join("\x01")).toString("base64"),
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\nA1 NO") >= 0);
            test.done();
        }).bind(this));
    },

    "Known user, invalid token": function(test) {
        var cmds = [
            "A1 AUTHENTICATE XOAUTH2 " + new Buffer(["user=testuser", "auth=Bearer zzz", "", ""].join("\x01")).toString("base64"),
            "",
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\nA1 NO") >= 0);
            test.ok(resp.indexOf("\r\n+ eyJzdGF0dXMiOiI0MDAiLCJzY2hlbWVzIjoiQmVhcmVyIiwic2NvcGUiOiJodHRwczovL21haWwuZ29vZ2xlLmNvbS8ifQ==\r\n") >= 0);
            test.done();
        }).bind(this));
    },

    "Login success": function(test) {
        var cmds = [
            "A1 AUTHENTICATE XOAUTH2 " + new Buffer(["user=testuser", "auth=Bearer testtoken", "", ""].join("\x01")).toString("base64"),
            "ZZ LOGOUT"
        ];

        mockClient(IMAP_PORT, "localhost", cmds, false, (function(resp) {
            resp = resp.toString();
            test.ok(resp.indexOf("\nA1 OK") >= 0);
            test.done();
        }).bind(this));
    }
}