import { states } from '../command-states.js';
import DeflateLayer from '../deflate-layer.js';
import type { Callback, IMAPConnection, IMAPError, IMAPServer, ParsedCommand } from '../types.js';

/**
 * @help Adds COMPRESS=DEFLATE [RFC4978] capability
 * @help Raw DEFLATE in both directions after the tagged OK,
 * @help every burst of responses ends with a sync flush
 */

export default function compressPlugin(server: IMAPServer) {
    server.registerCapability('COMPRESS=DEFLATE');

    const isActive = (connection: IMAPConnection): connection is IMAPConnection & { transport: DeflateLayer } =>
        connection.transport instanceof DeflateLayer && connection.transport.active;

    // RFC 8437 section 4.1: after UNAUTHENTICATE the server ends its compression after the CRLF of
    // the OK, and the client after the CRLF of the command, so anything it compressed later is dropped
    server.resetHandlers.push((connection: IMAPConnection) => {
        if (isActive(connection)) {
            connection.discardInput();
            connection.transport.endInput();
            connection.transport.end();
        }
    });

    server.setCommandHandler(
        'COMPRESS',
        (connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
            const args = parsed.attributes || [];

            // RFC 4978 section 5: compress = "COMPRESS" SP algorithm, algorithm = "DEFLATE"
            if (args.length !== 1 || !args[0] || args[0].type !== 'ATOM') {
                connection.sendStatus(parsed, data, 'BAD', 'COMPRESS expects a compression mechanism');
                return callback();
            }

            if (args[0].value.toUpperCase() !== 'DEFLATE') {
                connection.sendStatus(parsed, data, 'BAD', 'Unknown compression mechanism');
                return callback();
            }

            // RFC 4978 section 3: BAD if COMPRESS is already active, NO is for compression by another
            // layer, such as TLS, which ImapKit never negotiates. Dovecot answers NO here
            if (isActive(connection)) {
                connection.sendStatus(parsed, data, 'BAD', 'DEFLATE active via COMPRESS', 'COMPRESSIONACTIVE');
                return callback();
            }

            connection.sendStatus(parsed, data, 'OK', 'DEFLATE active');

            if (connection.transport) {
                // the layer of an earlier session, it passes data on as is since UNAUTHENTICATE
                connection.transport.destroy();
            }
            // compression starts right after the CRLF of the tagged OK
            connection.transport = new DeflateLayer({
                // the layer writes only Buffers to the server, strings come from the clients that share it
                writeRaw: (chunk: Buffer | string) => connection.writeRaw(chunk),
                onData: (chunk: Buffer) => connection.onData(chunk),
                onError: (err: IMAPError) => {
                    // the input can not be decompressed, so there is nothing left to talk about
                    if (connection.options.debug) {
                        console.log('COMPRESS error: %s', err.message);
                    }
                    connection.sendStatus({ tag: '*' }, null, 'BYE', 'Invalid compressed data', false, 'COMPRESS ERROR');
                    connection.end();
                }
            });

            return callback();
        },
        // RFC 4978 section 3: the client MUST NOT send further commands until it has seen the result of COMPRESS.
        // Those commands would be uncompressed, and after an OK the server expects compressed input
        { states: states.AUTHENTICATED, noPipelining: true }
    );
}
