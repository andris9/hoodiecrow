'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
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
