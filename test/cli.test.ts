// The imapkit command (bin/imapkit.js), which runs the built package in dist/

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
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

    it('starts a server that answers IMAP', async () => {
        // a free port for the server
        const port = await new Promise<number>(resolve => {
            const probe = net.createServer().listen(0, () => {
                const address = probe.address() as net.AddressInfo;
                probe.close(() => resolve(address.port));
            });
        });
        const child = spawn(process.execPath, [bin, '-p', String(port), '--plugin=IDLE,MOVE'], { stdio: ['ignore', 'pipe', 'inherit'] });
        try {
            await new Promise<void>((resolve, reject) => {
                let output = '';
                child.stdout.on('data', chunk => {
                    output += chunk;
                    if (/listening on port/.test(output)) {
                        resolve();
                    }
                });
                child.once('exit', code => reject(new Error('imapkit exited with ' + code)));
            });
            const transcript = await new Promise<string>((resolve, reject) => {
                const socket = net.connect(port, 'localhost');
                let received = '';
                socket.on('data', chunk => {
                    received += chunk.toString('binary');
                    if (received.startsWith('* OK') && !received.includes('A1 ')) {
                        socket.write('A1 CAPABILITY\r\n');
                    }
                    if (/^A1 /m.test(received)) {
                        socket.end();
                        resolve(received);
                    }
                });
                socket.on('error', reject);
            });
            assert.match(transcript, /^\* CAPABILITY .*\bIDLE\b.*\bMOVE\b/m);
            assert.match(transcript, /^A1 OK/m);
        } finally {
            child.kill();
        }
    });
});
