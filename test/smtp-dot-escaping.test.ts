import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import net from 'node:net';
import * as smtpServer from '../src/smtp-listener.js';
import { setupServer } from './helpers/index.js';
import type { AddressInfo } from 'node:net';

describe('Email sent containing escaped dots', () => {
    const ctx = setupServer();

    let smtp: ReturnType<typeof smtpServer.startSMTPServer>;

    beforeEach(
        () =>
            new Promise<void>(resolve => {
                smtp = smtpServer.startSMTPServer(0, ctx.server, () => resolve());
            })
    );

    afterEach(() => new Promise<void>(resolve => smtp.close(() => resolve())));

    it('Handles escaped dots', (t, done) => {
        const message =
            'This is an RFC Test for my mail server\r\n.. This double dot should be single in the received mail\r\n..\r\nThe previous line should only be a dot\r\n.\r\n';
        const smtpCmds = ['HELO SMTP', 'MAIL FROM: <sender@example.com>', 'RCPT TO: <receiver@example.com>', 'DATA', message, 'QUIT'];

        // a minimal SMTP client: send the next line after each final reply line ("250 ...", not "250-...")
        const socket = net.connect((smtp.server.address() as AddressInfo).port, 'localhost');
        let buffer = '';
        socket.on('data', chunk => {
            buffer += chunk.toString('binary');
            let lineEnd;
            while ((lineEnd = buffer.indexOf('\r\n')) >= 0) {
                const line = buffer.slice(0, lineEnd);
                buffer = buffer.slice(lineEnd + 2);
                if (/^\d{3} /.test(line) && smtpCmds.length) {
                    const cmd = smtpCmds.shift();
                    socket.write(cmd + (cmd === message ? '' : '\r\n'), 'binary');
                }
            }
        });
        socket.on('close', () => {
            const resultingMessage = ctx.server.getMailbox('inbox')!.messages[0];
            assert.ok(resultingMessage);
            assert.strictEqual(
                resultingMessage.raw,
                'This is an RFC Test for my mail server\r\n. This double dot should be single in the received mail\r\n.\r\nThe previous line should only be a dot\r\n'
            );
            done();
        });
    });
});
