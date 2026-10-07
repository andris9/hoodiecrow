'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { setupServer } = require('./helpers');
const { validateResponses } = require('./helpers/validate-responses');

// Sends raw input that no compliant client would send and returns everything until the server closes
const rawRun = (port, input, callback) => {
    const socket = net.connect(port, 'localhost');
    let resp = '';
    socket.on('data', chunk => {
        resp += chunk.toString('binary');
    });
    socket.on('close', () => callback(resp));
    socket.once('data', () => socket.write(input, 'binary'));
};

describe('Responses to malformed input stay parseable', () => {
    const ctx = setupServer(() => ({ storage: { INBOX: { messages: [{ raw: 'Subject: hello\r\n\r\nWorld' }] } } }));

    it('answers a line with an invalid tag untagged', (t, done) => {
        // "*" is a list-wildcard and TAB is a CTL, neither may appear in a tag (RFC 3501 section 9)
        rawRun(ctx.server.address().port, 'C1:* NOOP\r\nC1\tNOOP\r\n NOOP\r\nA1 LOGOUT\r\n', resp => {
            validateResponses(resp);
            assert.ok(resp.indexOf('C1:* BAD') < 0, resp);
            assert.ok(resp.indexOf('C1\tNOOP BAD') < 0 && resp.indexOf('C1 BAD') < 0, resp);
            assert.ok(resp.indexOf('NOOP BAD') < 0, resp);
            assert.strictEqual(resp.match(/\r\n\* BAD Error parsing command\r\n/g).length, 3, resp);
            done();
        });
    });

    it('does not answer a refused literal with a tag the client did not send', (t, done) => {
        rawRun(ctx.server.address().port, 'C1{99999999}\r\nA1 LOGOUT\r\n', resp => {
            validateResponses(resp);
            assert.ok(resp.indexOf('\r\n* BAD Literal too large\r\n') >= 0, resp);
            done();
        });
    });

    it('replaces 8-bit octets echoed from client input', (t, done) => {
        // the mock client writes binary strings, so the literal holds 5 octets
        ctx.run(['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH {5}\r\nh\xe9llo', 'A4 LOGOUT'], resp => {
            resp = resp.toString('binary');
            assert.ok(/\r\nA3 BAD [^\r\n]*h\?+llo\r\n/.test(resp), resp);
            done();
        });
    });

    it('adds text to status responses that only have a response code', (t, done) => {
        ctx.run(['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 LOGOUT'], resp => {
            resp = resp.toString('binary');
            assert.ok(/\r\n\* OK \[UIDNEXT 2\] \S/.test(resp), resp);
            done();
        });
    });
});
