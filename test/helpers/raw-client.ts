import net from 'node:net';

/** A connection that records the server output as it is, without the response grammar guardrail */
export interface RawClient {
    socket: net.Socket;
    /** every read, with the milliseconds since the connection was opened */
    reads: { time: number; data: string }[];
    /** everything received so far, as a binary string */
    output(): string;
    /** sends octets as they are */
    send(data: string | Buffer): void;
    /** resolves with the output once it matches, or rejects after the timeout */
    waitFor(pattern: RegExp, timeout?: number): Promise<string>;
    /** resolves with the output once the server closed the connection, `error` is the socket error if there was one */
    closed(): Promise<{ output: string; error: Error | null }>;
    close(): void;
}

/**
 * Opens a connection for tests of scripted faults, where the server deliberately sends output that a compliant
 * client (and the guardrail of test/helpers/validate-responses.ts) would refuse
 *
 * @param {Number} port Server port
 * @return {Promise} the client once the socket is connected
 */
export function connectRaw(port: number): Promise<RawClient> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, 'localhost');
        const started = Date.now();
        const reads: { time: number; data: string }[] = [];
        let buffer = '';
        let ended = false;
        let error: Error | null = null;
        const listeners = new Set<() => void>();
        const notify = () => listeners.forEach(listener => listener());

        socket.on('data', chunk => {
            const data = chunk.toString('binary');
            reads.push({ time: Date.now() - started, data });
            buffer += data;
            notify();
        });
        socket.on('error', err => {
            error = err;
        });
        const closed = new Promise<{ output: string; error: Error | null }>(resolveClosed => {
            socket.on('close', () => {
                ended = true;
                notify();
                resolveClosed({ output: buffer, error });
            });
        });

        const client: RawClient = {
            socket,
            reads,
            output: () => buffer,
            send: data => {
                socket.write(typeof data === 'string' ? Buffer.from(data, 'binary') : data);
            },
            waitFor: (pattern, timeout = 2000) =>
                new Promise((resolveWait, rejectWait) => {
                    const check = () => {
                        if (pattern.test(buffer)) {
                            done();
                            resolveWait(buffer);
                        } else if (ended) {
                            done();
                            rejectWait(new Error('Connection closed before ' + pattern + ' matched:\n' + JSON.stringify(buffer)));
                        }
                    };
                    const timer = setTimeout(() => {
                        done();
                        rejectWait(new Error('Timeout waiting for ' + pattern + ', received:\n' + JSON.stringify(buffer)));
                    }, timeout);
                    const done = () => {
                        clearTimeout(timer);
                        listeners.delete(check);
                    };
                    listeners.add(check);
                    check();
                }),
            closed: () => closed,
            close: () => {
                socket.destroy();
            }
        };

        socket.once('connect', () => resolve(client));
        socket.once('error', reject);
    });
}
