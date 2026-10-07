'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');

describe('Responses to malformed input stay parseable', () => {
    const ctx = setupServer(() => ({ storage: { INBOX: { messages: [{ raw: 'Subject: hello\r\n\r\nWorld' }] } } }));

    it('answers a line with an invalid tag untagged', (t, done) => {
        // "*" is a list-wildcard and TAB is a CTL, neither may appear in a tag (RFC 3501 section 9)
        ctx.run(['C1:* NOOP', 'C1\tNOOP', ' NOOP', 'A1 LOGOUT'], resp => {
            resp = resp.toString('binary');
            assert.ok(resp.indexOf('C1:* BAD') < 0, resp);
            assert.ok(resp.indexOf('C1\tNOOP BAD') < 0 && resp.indexOf('C1 BAD') < 0, resp);
            assert.ok(resp.indexOf('NOOP BAD') < 0, resp);
            assert.strictEqual(resp.match(/\r\n\* BAD Error parsing command\r\n/g).length, 3, resp);
            done();
        });
    });

    it('does not answer a refused literal with a tag the client did not send', (t, done) => {
        ctx.run(['C1{99999999}', 'A1 LOGOUT'], resp => {
            resp = resp.toString('binary');
            assert.ok(resp.indexOf('\r\n* BAD Literal too large\r\n') >= 0, resp);
            done();
        });
    });

    it('replaces 8-bit octets echoed from client input', (t, done) => {
        // mock-client writes UTF-8, so the literal holds 6 octets
        ctx.run(['A1 LOGIN testuser testpass', 'A2 SELECT INBOX', 'A3 SEARCH {6}\r\nh\xe9llo', 'A4 LOGOUT'], resp => {
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
