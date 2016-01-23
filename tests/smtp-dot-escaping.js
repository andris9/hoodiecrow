
var hoodiecrow = require('../lib/server'),
    smtpServer = require('../lib/hoodiecrowSMTPServer'),
    mockClient = require('../lib/mock-client');

var IMAP_PORT = 4143,
    SMTP_PORT = 4025,
    instance = 0;


module.exports["Email sent containing escaped dots"] = {
    setUp: function(done) {
        this.server = hoodiecrow();
        this.instanceId = ++instance;

        this.server.listen(IMAP_PORT, (function() {
            this.smtpServer = smtpServer.startSMTPServer(SMTP_PORT, this.server, function() {
                done();
            });
        }).bind(this));

    },

    tearDown: function(done) {
        this.server.close((function() {
            this.smtpServer.server.end((function() {
                done();
            }).bind(this));
        }).bind(this));
    },
    "Handles escaped dots": function(test) {
        var message = "This is an RFC Test for my mail server\r\n.. This double dot should be single in the received mail\r\n..\r\nThe previous line should only be a dot\r\n.\r\n";
        var smtpCmds = ["HELO SMTP",
            "MAIL FROM: <sender@example.com>",
            "RCPT TO: <receiver@example.com>",
            "DATA",
            message,
            "QUIT"
        ];

        mockClient(SMTP_PORT, "localhost", smtpCmds, false, (function(resp) {
            var resultingMessage = this.server.getMailbox('inbox').messages[0];
            test.ok(resultingMessage);
            messageLines = resultingMessage.raw.split('\r\n');
            test.strictEqual('This is an RFC Test for my mail server', messageLines[1]);
            test.strictEqual('. This double dot should be single in the received mail', messageLines[2]);
            test.strictEqual('.', messageLines[3]);
            test.strictEqual('The previous line should only be a dot', messageLines[4]);
            test.done();
        }).bind(this));
    }
}
