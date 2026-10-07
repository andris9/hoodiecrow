import { describe, it } from 'node:test';
import assert from 'node:assert';
import net from 'node:net';
import { setupServer } from './helpers/index.js';

interface Waiter {
    str: string;
    done: () => void;
}

interface Client {
    output: string;
    waiters: Waiter[];
    send(line: string): void;
    waitFor(str: string, done: () => void): void;
    check(): void;
    close(): void;
}

// Minimal client that lets the test run code between commands
function connect(port: number, callback: (client: Client) => void): Client {
    const socket = net.connect(port, 'localhost');
    const client: Client = {
        output: '',
        waiters: [],
        send(line) {
            socket.write(line + '\r\n');
        },
        // calls back once the output contains the string
        waitFor(str, done) {
            client.waiters.push({ str, done });
            client.check();
        },
        check() {
            client.waiters = client.waiters.filter(waiter => {
                if (client.output.indexOf(waiter.str) >= 0) {
                    setImmediate(waiter.done);
                    return false;
                }
                return true;
            });
        },
        close() {
            socket.end();
        }
    };
    socket.on('data', chunk => {
        client.output += chunk.toString('binary');
        client.check();
    });
    socket.once('connect', () => callback(client));
    return client;
}

describe('IDLE', () => {
    const ctx = setupServer(() => ({
        plugins: ['IDLE'],
        storage: {
            INBOX: {
                messages: [{ raw: 'Subject: hello 1\r\n\r\nWorld 1!' }]
            }
        }
    }));

    it('pushes notifications only while idling', (t, done) => {
        connect(ctx.port, client => {
            client.send('A1 LOGIN testuser testpass');
            client.send('A2 SELECT INBOX');
            client.waitFor('A2 OK', () => {
                client.send('A3 IDLE');
                client.waitFor('+ idling', () => {
                    ctx.server.appendMessage('INBOX', [], false, 'Subject: hello 2\r\n\r\nWorld 2!');
                    client.waitFor('* 2 EXISTS', () => {
                        client.send('DONE');
                        client.waitFor('A3 OK', () => {
                            ctx.server.appendMessage('INBOX', [], false, 'Subject: hello 3\r\n\r\nWorld 3!');
                            setTimeout(() => {
                                // no command in progress, so the EXISTS response must wait
                                if (client.output.indexOf('* 3 EXISTS') >= 0) {
                                    client.close();
                                    return done(new Error('EXISTS was sent with no command in progress'));
                                }
                                client.send('A4 NOOP');
                                client.waitFor('A4 OK', () => {
                                    assert.ok(client.output.indexOf('* 3 EXISTS\r\nA4 OK') >= 0, client.output);
                                    client.close();
                                    done();
                                });
                            }, 50);
                        });
                    });
                });
            });
        });
    });

    it('rejects input other than DONE', (t, done) => {
        connect(ctx.port, client => {
            client.send('A1 LOGIN testuser testpass');
            client.send('A2 IDLE');
            client.waitFor('+ idling', () => {
                client.send('A3 NOOP');
                client.waitFor('A2 BAD', () => {
                    client.close();
                    done();
                });
            });
        });
    });
});
