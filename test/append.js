'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { setupServer } = require('./helpers');

describe('Normal login', () => {
    const ctx = setupServer();

    it('Append simple', (t, done) => {
        const message = 'From: sender <sender@example.com>\r\nTo: receiver@example.com\r\nSubject: HELLO!\r\n\r\nWORLD!';
        const cmds = [
            'A1 CAPABILITY',
            'A2 LOGIN testuser testpass',
            'A3 SELECT INBOX',
            'A4 APPEND INBOX {' + message.length + '}\r\n' + message,
            'A5 FETCH 1 BODY[HEADER.FIELDS (Subject)]',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA2 OK') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('\nA4 OK') >= 0);
            assert.ok(resp.indexOf('\nA5 OK') >= 0);
            assert.ok(resp.indexOf('\nSubject: HELLO!') >= 0);
            done();
        });
    });

    it('Append flags', (t, done) => {
        const message = 'From: sender <sender@example.com>\r\nTo: receiver@example.com\r\nSubject: HELLO!\r\n\r\nWORLD!';
        const cmds = [
            'A1 CAPABILITY',
            'A2 LOGIN testuser testpass',
            'A3 SELECT INBOX',
            'A4 APPEND INBOX (MyFlag) {' + message.length + '}\r\n' + message,
            'A5 FETCH 1 (FLAGS BODY[HEADER.FIELDS (Subject)])',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA2 OK') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('\nA4 OK') >= 0);
            assert.ok(resp.indexOf('\nA5 OK') >= 0);
            assert.ok(resp.indexOf('MyFlag') >= 0);
            assert.ok(resp.indexOf('\nSubject: HELLO!') >= 0);
            done();
        });
    });

    it('Append internaldate', (t, done) => {
        const message = 'From: sender <sender@example.com>\r\nTo: receiver@example.com\r\nSubject: HELLO!\r\n\r\nWORLD!';
        const cmds = [
            'A1 CAPABILITY',
            'A2 LOGIN testuser testpass',
            'A3 SELECT INBOX',
            'A4 APPEND INBOX "14-Sep-2013 21:22:28 -0300" {' + message.length + '}\r\n' + message,
            'A5 FETCH 1 (INTERNALDATE BODY[HEADER.FIELDS (Subject)])',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA2 OK') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('\nA4 OK') >= 0);
            assert.ok(resp.indexOf('\nA5 OK') >= 0);
            assert.ok(resp.indexOf('14-Sep-2013 21:22:28 -0300') >= 0);
            assert.ok(resp.indexOf('\nSubject: HELLO!') >= 0);
            done();
        });
    });

    it('Append full', (t, done) => {
        const message = 'From: sender <sender@example.com>\r\nTo: receiver@example.com\r\nSubject: HELLO!\r\n\r\nWORLD!';
        const cmds = [
            'A1 CAPABILITY',
            'A2 LOGIN testuser testpass',
            'A3 SELECT INBOX',
            'A4 APPEND INBOX (MyFlag) "14-Sep-2013 21:22:28 -0300" {' + message.length + '}\r\n' + message,
            'A5 FETCH 1 (FLAGS INTERNALDATE BODY[HEADER.FIELDS (Subject)])',
            'ZZ LOGOUT'
        ];

        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.ok(resp.indexOf('\nA2 OK') >= 0);
            assert.ok(resp.indexOf('\nA3 OK') >= 0);
            assert.ok(resp.indexOf('\nA4 OK') >= 0);
            assert.ok(resp.indexOf('\nA5 OK') >= 0);
            assert.ok(resp.indexOf('MyFlag') >= 0);
            assert.ok(resp.indexOf('14-Sep-2013 21:22:28 -0300') >= 0);
            assert.ok(resp.indexOf('\nSubject: HELLO!') >= 0);
            done();
        });
    });
});

describe('APPEND to a missing mailbox', () => {
    const ctx = setupServer(() => ({
        storage: {
            INBOX: {},
            '': { folders: { Parent: { flags: ['\\Noselect'], folders: { Child: {} } } } }
        }
    }));

    // RFC 3502 section 6.3.11 example A004 and RFC 3501 section 6.3.11: NO [TRYCREATE] before the literal is sent
    it('is refused before the continuation request', (t, done) => {
        const cmds = [
            'A1 LOGIN testuser testpass',
            'A2 APPEND Missing (\\Seen) {3}\r\nabc',
            'A3 APPEND Parent {3}\r\nabc',
            'A4 APPEND nil {3}\r\nabc',
            'ZZ LOGOUT'
        ];
        ctx.run(cmds, resp => {
            resp = resp.toString();
            assert.match(resp, /^A2 NO \[TRYCREATE\] Target mailbox does not exist\r$/m);
            assert.match(resp, /^A3 NO \[TRYCREATE\] Target mailbox is not selectable\r$/m);
            assert.match(resp, /^A4 NO \[TRYCREATE\] /m);
            assert.doesNotMatch(resp, /^\+ /m);
            done();
        });
    });

    it('waits for earlier commands that could create the mailbox', (t, done) => {
        const socket = net.connect(ctx.server.address().port, 'localhost');
        let resp = '';
        let sent = false;
        socket.on('data', chunk => {
            resp += chunk.toString();
            if (!sent && /^\+ /m.test(resp)) {
                sent = true;
                socket.write('abc\r\nA3 LOGOUT\r\n');
            }
        });
        socket.on('close', () => {
            assert.match(resp, /^A1 OK /m);
            assert.match(resp, /^A2 OK /m);
            done();
        });
        socket.write('L1 LOGIN testuser testpass\r\nA1 CREATE New\r\nA2 APPEND New {3}\r\n');
    });
});
