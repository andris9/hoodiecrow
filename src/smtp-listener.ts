import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import type { IMAPServer } from './types.js';

/**
 * Starts an SMTP server that appends every received message to the INBOX
 * of the given ImapKit IMAP server. Any sender, recipient and credentials
 * are accepted.
 *
 * @param {Number} smtpPort - port to listen on for SMTP commands
 * @param {Object} imapServer - the ImapKit IMAP server
 * @param {Function} [callback] - function executed when SMTP server is listening
 * @return {SMTPServer} the SMTP server instance, use `close()` to stop it
 */
export function startSMTPServer(smtpPort: number, imapServer: IMAPServer, callback?: (() => void) | null): SMTPServer {
    const credentials = imapServer.getCredentials();

    const server = new SMTPServer({
        banner: 'ImapKit',
        key: credentials.key,
        cert: credentials.cert,
        authOptional: true,
        logger: false,
        onAuth(auth, session, done) {
            done(null, { user: auth.username });
        },
        onData(stream, session, done) {
            const chunks: Buffer[] = [];
            stream.on('data', (chunk: Buffer) => chunks.push(chunk));
            stream.on('error', done);
            stream.on('end', () => {
                // smtp-server has already removed the dot-stuffing (RFC 5321 section 4.5.2)
                imapServer.appendMessage('INBOX', [], false, Buffer.concat(chunks).toString('binary'));
                done();
            });
        }
    });

    server.on('error', (err: Error) => {
        if (imapServer.options.debug) {
            console.error('SMTP server error: %s', err.message);
        }
    });

    server.listen(smtpPort, () => {
        console.log('Incoming SMTP server up and running on port %s', (server.server.address() as AddressInfo).port);
        callback?.();
    });

    return server;
}
