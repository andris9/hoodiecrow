'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const mockClient = require('../lib/mock-client');
const smtpServer = require('../lib/hoodiecrowSMTPServer');
const { setupServer } = require('./helpers');

describe('Email sent containing escaped dots', () => {
    const ctx = setupServer();

    beforeEach((t, done) => {
        ctx.smtpServer = smtpServer.startSMTPServer(0, ctx.server, done);
    });

    afterEach((t, done) => {
        ctx.smtpServer.close(done);
    });

    it('Handles escaped dots', (t, done) => {
        const message =
            'This is an RFC Test for my mail server\r\n.. This double dot should be single in the received mail\r\n..\r\nThe previous line should only be a dot\r\n.\r\n';
        const smtpCmds = ['HELO SMTP', 'MAIL FROM: <sender@example.com>', 'RCPT TO: <receiver@example.com>', 'DATA', message, 'QUIT'];

        mockClient(ctx.smtpServer.server.address().port, 'localhost', smtpCmds, false, () => {
            const resultingMessage = ctx.server.getMailbox('inbox').messages[0];
            assert.ok(resultingMessage);
            assert.strictEqual(
                resultingMessage.raw,
                'This is an RFC Test for my mail server\r\n. This double dot should be single in the received mail\r\n.\r\nThe previous line should only be a dot\r\n'
            );
            done();
        });
    });
});
