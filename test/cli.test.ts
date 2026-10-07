// The imapkit command (bin/imapkit.js), which runs the built package in dist/

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(__dirname, '..', 'bin', 'imapkit.js');
const built = fs.existsSync(path.join(__dirname, '..', 'dist', 'esm', 'index.js'));

describe('imapkit command', { skip: !built && 'run npm run build first' }, () => {
    it('lists the plugins in --help', () => {
        const output = execFileSync(process.execPath, [bin, '--help'], { encoding: 'utf-8' });
        assert.match(output, /^ IDLE\s+Adds IDLE \[RFC2177\] capability$/m);
        assert.match(output, /^ X-GM-EXT-1\s+/m);
        assert.doesNotMatch(output, /__PLUGINS__|__VERSION__/);
    });

    /** a free port for the server */
    function freePort(): Promise<number> {
        return new Promise<number>(resolve => {
            const probe = net.createServer().listen(0, () => {
                const address = probe.address() as net.AddressInfo;
                probe.close(() => resolve(address.port));
            });
        });
    }

    /** resolves once the command listens */
    function listening(child: ReturnType<typeof spawn>): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            let output = '';
            child.stdout?.on('data', chunk => {
                output += chunk;
                if (/listening on port/.test(output)) {
                    resolve();
                }
            });
            child.once('exit', code => reject(new Error('imapkit exited with ' + code)));
        });
    }

    /** sends A1 CAPABILITY after the greeting and resolves with everything received until the tagged response */
    function capability(port: number): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const socket = net.connect(port, 'localhost');
            let received = '';
            socket.on('data', chunk => {
                received += chunk.toString('binary');
                if (/^\* (OK|PREAUTH)/.test(received) && !received.includes('A1 ')) {
                    socket.write('A1 CAPABILITY\r\n');
                }
                if (/^A1 /m.test(received)) {
                    socket.end();
                    resolve(received);
                }
            });
            socket.on('error', reject);
        });
    }

    it('starts a server that answers IMAP', async () => {
        const port = await freePort();
        const child = spawn(process.execPath, [bin, '-p', String(port), '--plugin=IDLE,MOVE'], { stdio: ['ignore', 'pipe', 'inherit'] });
        try {
            await listening(child);
            const transcript = await capability(port);
            assert.match(transcript, /^\* CAPABILITY .*\bIDLE\b.*\bMOVE\b/m);
            assert.match(transcript, /^A1 OK/m);
        } finally {
            child.kill();
        }
    });

    it('loads script rules with --script', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imapkit-script-'));
        const file = path.join(dir, 'script.json');
        fs.writeFileSync(
            file,
            JSON.stringify([
                { on: 'greeting', send: '* PREAUTH scripted\r\n' },
                { on: 'response', command: 'CAPABILITY', untagged: false, send: '$TAG NO [UNAVAILABLE] scripted\r\n' }
            ])
        );
        const port = await freePort();
        const child = spawn(process.execPath, [bin, '-p', String(port), '--script=' + file], { stdio: ['ignore', 'pipe', 'inherit'] });
        try {
            await listening(child);
            const transcript = await capability(port);
            assert.match(transcript, /^\* PREAUTH scripted\r\n/);
            assert.match(transcript, /^A1 NO \[UNAVAILABLE\] scripted\r\n/m);
        } finally {
            child.kill();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
