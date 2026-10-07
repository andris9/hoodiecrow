'use strict';

const zlib = require('zlib');

// Z_SYNC_FLUSH ends with an empty stored block, LEN 0 and NLEN 0xFFFF (RFC 1951 section 3.2.4)
const SYNC_MARKER = Buffer.from([0x00, 0x00, 0xff, 0xff]);
// Z_FINISH right after a flush is an empty final block with fixed Huffman codes
const EMPTY_FINAL_BLOCK = Buffer.from([0x03, 0x00]);

/**
 * One end of a COMPRESS=DEFLATE layer (RFC 4978): raw DEFLATE (RFC 1951, no zlib header or
 * checksum) in both directions. The server plugin uses it, and so do the clients of the tests and
 * the compare tool.
 *
 * Either direction can be terminated, which UNAUTHENTICATE requires (RFC 8437 section 4.1). Output
 * terminates with a final DEFLATE block, data written after that goes out uncompressed once the
 * compressed data is out. Input terminates where the peer ended its compression: at the end of
 * its DEFLATE stream if it sent a final block, otherwise at the end of the sync flush that
 * carried the last compressed data. The input is split at sync flush markers to find that point.
 */
class DeflateLayer {
    /**
     * @param {Object} options
     * @param {Function} options.writeRaw `(buffer)` sends octets to the peer
     * @param {Function} options.onData `(buffer)` gets the input, decompressed while compression is active
     * @param {Function} [options.onError] `(err)` called when the input is not valid DEFLATE data
     */
    constructor(options) {
        this.writeRaw = options.writeRaw;
        this.onData = options.onData;
        this.onError = options.onError || (() => false);

        // outgoing data is compressed
        this.active = true;
        // incoming data is compressed
        this.inputActive = true;

        this._deflate = zlib.createDeflateRaw();
        this._deflate.on('data', chunk => this.writeRaw(chunk));
        this._deflate.on('error', err => this.onError(err));
        // writes that wait for the final compressed data, null when nothing is waiting
        this._held = null;
        this._endCallbacks = [];
        this._flushScheduled = false;

        this._inflate = zlib.createInflateRaw({ flush: zlib.constants.Z_SYNC_FLUSH });
        this._inflate.on('data', chunk => {
            // anything the peer compressed after it ended its compression is dropped
            if (this.inputActive) {
                this.onData(chunk);
            }
        });
        this._inflate.on('error', err => {
            this.inputActive = false;
            this._pieces = [];
            this._busy = false;
            this.onError(err);
            this._next();
        });
        // input waiting for the inflater, split at sync flush markers
        this._pieces = [];
        this._busy = false;
        // octets given to the inflater
        this._fed = 0;
        // the peer may still send the empty final block of its DEFLATE stream
        this._expectFinal = false;
        // called once the received data is processed
        this._idleCallbacks = [];
    }

    /**
     * Sends data to the peer, compressed while compression is active
     *
     * @param {Buffer} data Data to send
     */
    write(data) {
        if (this._held) {
            this._held.push(data);
            return;
        }
        if (!this.active) {
            this.writeRaw(data);
            return;
        }
        this._deflate.write(data);
        if (!this._flushScheduled) {
            // everything written in one go, like a burst of responses, is flushed together, so the peer
            // gets it right away instead of when the compressor buffer fills up (RFC 4978 section 4)
            this._flushScheduled = true;
            process.nextTick(() => {
                this._flushScheduled = false;
                if (this.active && !this._deflate.destroyed) {
                    this._deflate.flush(zlib.constants.Z_SYNC_FLUSH);
                }
            });
        }
    }

    /**
     * Terminates the outgoing compression with a final DEFLATE block. Later writes are sent
     * uncompressed, after the compressed data.
     *
     * @param {Function} [callback] Called once the compressed data is written out
     */
    end(callback) {
        if (callback) {
            this._endCallbacks.push(callback);
        }
        if (!this.active) {
            if (!this._held) {
                this._runCallbacks('_endCallbacks');
            }
            return;
        }
        this.active = false;
        this._held = [];
        this._deflate.once('end', () => {
            const held = this._held;
            this._held = null;
            held.forEach(data => this.writeRaw(data));
            this._runCallbacks('_endCallbacks');
        });
        this._deflate.end();
    }

    // calls the callbacks of a list once, callbacks added meanwhile wait for the next run
    _runCallbacks(key) {
        const callbacks = this[key];
        this[key] = [];
        callbacks.forEach(callback => callback());
    }

    /**
     * Handles octets received from the peer
     *
     * @param {Buffer} chunk Received data
     */
    receive(chunk) {
        if (!this.inputActive && !this._busy && !this._pieces.length) {
            this._receivePlain(chunk);
            return;
        }
        let start = 0;
        let pos;
        while ((pos = chunk.indexOf(SYNC_MARKER, start)) >= 0) {
            this._pieces.push(chunk.subarray(start, pos + SYNC_MARKER.length));
            start = pos + SYNC_MARKER.length;
        }
        if (start < chunk.length) {
            this._pieces.push(chunk.subarray(start));
        }
        this._next();
    }

    /**
     * Tells the layer that the peer terminates its compression after the data decompressed so far
     * (RFC 8437 section 4.1). Call it from onData, the rest of the input is then passed on as is.
     */
    endInput() {
        this.inputActive = false;
    }

    /**
     * Calls back once all received data is passed on
     *
     * @param {Function} callback Function to call
     */
    whenIdle(callback) {
        this._idleCallbacks.push(callback);
        this._next();
    }

    _next() {
        if (this._busy) {
            return;
        }
        if (!this._pieces.length) {
            this._runCallbacks('_idleCallbacks');
            return;
        }
        if (!this.inputActive) {
            const rest = Buffer.concat(this._pieces);
            this._pieces = [];
            this._receivePlain(rest);
            this._next();
            return;
        }

        const piece = this._pieces.shift();
        this._busy = true;
        this._fed += piece.length;
        this._inflate.write(piece, () => {
            this._busy = false;
            // octets the inflater did not use follow the end of the peer's DEFLATE stream
            const unused = this._fed - this._inflate.bytesWritten;
            if (unused > 0 || this._inflate.readableEnded) {
                this.inputActive = false;
                if (unused > 0) {
                    this._pieces.unshift(piece.subarray(piece.length - unused));
                }
            } else if (!this.inputActive) {
                // the input ended at a sync flush, the final block may still follow
                this._expectFinal = true;
            }
            this._next();
        });
    }

    _receivePlain(chunk) {
        if (this._expectFinal) {
            this._expectFinal = false;
            if (chunk.subarray(0, EMPTY_FINAL_BLOCK.length).equals(EMPTY_FINAL_BLOCK)) {
                chunk = chunk.subarray(EMPTY_FINAL_BLOCK.length);
            }
        }
        if (chunk.length) {
            this.onData(chunk);
        }
    }

    /**
     * Frees the compressor and the decompressor
     */
    destroy() {
        this.active = this.inputActive = false;
        this._pieces = [];
        this._deflate.destroy();
        this._inflate.destroy();
    }
}

module.exports = DeflateLayer;
