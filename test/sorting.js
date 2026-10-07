'use strict';

// Unit tests of the SORT and THREAD message values in lib/sorting.js (RFC 5256, RFC 5957)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { decodeHeader, collationKey, baseSubject, sentTime, arrivalTime, addressMailbox, displayAddress, parseMessageIds } = require('../lib/sorting');

const message = (raw, internaldate) => ({ raw, internaldate: internaldate || '01-Jan-2020 00:00:00 +0000' });

describe('RFC 2047 header decoding', () => {
    const cases = [
        ['plain text', 'plain text'],
        ['=?UTF-8?Q?J=C3=B5geva?=', 'Jõgeva'],
        ['=?utf-8?b?w4FsdmFy?=', 'Álvar'],
        ['=?ISO-8859-1?Q?=E9t=E9_x?=', 'été x'],
        // RFC 2047 section 6.2: white space between adjacent encoded words is dropped
        ['=?UTF-8?Q?a?= =?UTF-8?Q?b?=  c', 'ab  c'],
        // a character split over two encoded words
        ['=?UTF-8?Q?=C3?=\r\n =?UTF-8?Q?=A4?=', 'ä'],
        // different charsets are decoded separately
        ['=?UTF-8?Q?=C3=A4?= =?ISO-8859-1?Q?=E4?=', 'ää'],
        // RFC 2231 section 5 language suffix
        ['=?US-ASCII*EN?Q?hi?=', 'hi'],
        // unknown charsets stay encoded
        ['=?X-UNKNOWN?Q?abc?=', '=?X-UNKNOWN?Q?abc?='],
        // raw 8-bit text is read as UTF-8
        [Buffer.from('café', 'utf-8').toString('binary'), 'café'],
        ['', '']
    ];
    for (const [input, expected] of cases) {
        it('decodes ' + JSON.stringify(input), () => {
            assert.strictEqual(decodeHeader(input), expected);
        });
    }
});

describe('i;unicode-casemap collation (RFC 5051)', () => {
    const same = (a, b) => assert.strictEqual(Buffer.compare(collationKey(a), collationKey(b)), 0, a + ' = ' + b);
    const before = (a, b) => assert.ok(Buffer.compare(collationKey(a), collationKey(b)) < 0, a + ' < ' + b);

    it('ignores case', () => {
        same('hello', 'HELLO');
        same('été', 'ÉTÉ');
    });

    it('titlecases and decomposes (RFC 5051 section 2 example)', () => {
        // U+01C4 becomes U+0044 U+007A U+030C
        assert.deepStrictEqual(collationKey('Ǆ'), Buffer.from('Dž', 'utf-8'));
        same('ǆ', 'Ǆ');
        same('ᾀ', 'ᾈ');
    });

    it('keeps characters without a single code point uppercase mapping', () => {
        before('SS', 'ß');
        // compatibility decomposition after titlecasing, so the ligature becomes lowercase "fi"
        assert.deepStrictEqual(collationKey('ﬁ'), Buffer.from('fi'));
    });

    it('orders by code point, the empty string first', () => {
        before('', 'a');
        before('a', 'b');
        // diacritics are decomposed, so they sort with the base letter
        before('a', 'ä');
        before('ä', 'B');
        // UTF-8 order, not UTF-16 order: U+FF5E sorts before U+1F600
        before('～', '\u{1f600}');
    });
});

describe('Base subject (RFC 5256 section 2.1)', () => {
    const cases = [
        ['Hello world', 'Hello world', false],
        ['Re: Hello world', 'Hello world', true],
        ['RE: re: Fwd: fw: FWD: hello', 'hello', true],
        ['re:re:RE: x', 'x', true],
        ['Re  [x]  : x', 'x', true],
        ['FWD[x]: x', 'x', true],
        ['[list] Re: [blob] hello', 'hello', true],
        ['[a][b]', '[b]', false],
        ['[blob only]', '[blob only]', false],
        ['Re: [blob] ', '[blob]', true],
        ['hello (fwd)', 'hello', true],
        ['  hello  (fwd) (FWD)  ', 'hello', true],
        ['hello(fwd)', 'hello', true],
        ['[fwd: hello]', 'hello', true],
        ['[Fwd: Re: [fwd: hello (fwd)]]', 'hello', true],
        ['[fwd: hello', '[fwd: hello', false],
        ['Fwd: [fwd: hello world]', 'hello world', true],
        ['tab\there\r\n  folded', 'tab here folded', false],
        ['Reply: hello', 'Reply: hello', false],
        ['Re:', '', true],
        ['', '', false],
        ['=?UTF-8?Q?Re=3A_caf=C3=A9?=', 'café', true]
    ];
    for (const [subject, base, isReply] of cases) {
        it(JSON.stringify(subject) + ' is ' + JSON.stringify(base), () => {
            assert.deepStrictEqual(baseSubject(subject), { subject: base, isReply });
        });
    }

    it('handles a missing subject', () => {
        assert.deepStrictEqual(baseSubject(undefined), { subject: '', isReply: false });
    });
});

describe('Sent date (RFC 5256 section 2.2)', () => {
    const date = (header, internaldate) => sentTime(message('Date: ' + header + '\r\n\r\n', internaldate));

    it('normalizes to UTC', () => {
        // the example of section 2.2
        assert.strictEqual(date('31 Dec 2000 16:01:33 -0800'), Date.UTC(2001, 0, 1, 0, 1, 33));
        assert.strictEqual(date('Mon, 1 Jan 2001 00:01:33 +0000'), Date.UTC(2001, 0, 1, 0, 1, 33));
    });

    it('reads obsolete forms (RFC 5322 section 4.3)', () => {
        assert.strictEqual(date('1 Jan 01 10:00 PST'), Date.UTC(2001, 0, 1, 18, 0, 0));
        assert.strictEqual(date('1 Jan 99 10:00 GMT'), Date.UTC(1999, 0, 1, 10, 0, 0));
        assert.strictEqual(date('1 Jan 101 10:00 EDT'), Date.UTC(2001, 0, 1, 14, 0, 0));
        assert.strictEqual(date('Mon (comment), 1 Jan 2001 10 : 00 : 05 +0100'), Date.UTC(2001, 0, 1, 9, 0, 5));
    });

    it('treats an invalid zone as UTC', () => {
        assert.strictEqual(date('1 Jan 2001 10:00:00 +2360'), Date.UTC(2001, 0, 1, 10, 0, 0));
        assert.strictEqual(date('1 Jan 2001 10:00:00 Z'), Date.UTC(2001, 0, 1, 10, 0, 0));
        assert.strictEqual(date('1 Jan 2001 10:00:00'), Date.UTC(2001, 0, 1, 10, 0, 0));
    });

    it('treats an invalid or missing time as 00:00:00', () => {
        assert.strictEqual(date('1 Jan 2001 25:61:00 +0000'), Date.UTC(2001, 0, 1));
        assert.strictEqual(date('1 Jan 2001'), Date.UTC(2001, 0, 1));
    });

    it('uses the internal date if the Date header is missing or has no valid date', () => {
        const internal = Date.UTC(2020, 5, 3, 12, 0, 0);
        assert.strictEqual(date('garbage', '03-Jun-2020 14:00:00 +0200'), internal);
        assert.strictEqual(date('31 Feb 2001 10:00:00 +0000', '03-Jun-2020 14:00:00 +0200'), internal);
        assert.strictEqual(sentTime(message('Subject: x\r\n\r\n', '03-Jun-2020 14:00:00 +0200')), internal);
    });

    it('reads the internal date with its zone', () => {
        assert.strictEqual(arrivalTime(message('', '03-Jun-2020 14:00:00 -0130')), Date.UTC(2020, 5, 3, 15, 30, 0));
        assert.strictEqual(arrivalTime({ raw: '', internaldate: 'bogus' }), 0);
    });
});

describe('Date parsing shared by SEARCH and SORT (lib/dates.js)', () => {
    const { parseHeaderDate, parseDateTime, toTimestamp, dateKey } = require('../lib/dates');

    // RFC 5256 section 2.2: SEARCH uses the date as written (RFC 3501 section 6.4.4), SORT the date and time in UTC
    it('keeps the written date for SEARCH and the UTC time for SORT', () => {
        const date = parseHeaderDate('Sun, 31 Dec 2000 16:01:33 -0800 (PST)');
        assert.strictEqual(dateKey(date.day, date.month, date.year), '2000-12-31');
        assert.strictEqual(toTimestamp(date), Date.UTC(2001, 0, 1, 0, 1, 33));
    });

    it('refuses impossible dates and month names that RFC 5322 section 3.3 does not know', () => {
        assert.strictEqual(parseHeaderDate('31 Feb 2001 10:00:00 +0000'), null);
        assert.strictEqual(parseHeaderDate('5 September 2001'), null);
        assert.strictEqual(parseDateTime('31-Feb-2001 10:00:00 +0000'), null);
    });

    it('reads a date-time with or without the time', () => {
        assert.deepStrictEqual(parseDateTime('14-Sep-2013 21:22:28 -0300'), {
            day: 14,
            month: 8,
            year: 2013,
            hours: 21,
            minutes: 22,
            seconds: 28,
            zone: '-0300'
        });
        assert.deepStrictEqual(parseDateTime(' 4-sep-2013'), { day: 4, month: 8, year: 2013 });
    });
});

describe('Address sort values', () => {
    const raw = ['From: =?UTF-8?Q?=C3=84nne?= <Anne@a.example>, bob@b.example', 'To: Group: amy@h.example, al@h.example;', 'Cc: localuser', '', ''].join(
        '\r\n'
    );

    it('uses the addr-mailbox of the first address (RFC 5256 section 3)', () => {
        assert.strictEqual(addressMailbox(message(raw), 'from'), 'Anne');
        // the first address of a group is the group name in the envelope (RFC 3501 section 7.4.2)
        assert.strictEqual(addressMailbox(message(raw), 'to'), 'Group');
        assert.strictEqual(addressMailbox(message(raw), 'cc'), 'localuser');
        assert.strictEqual(addressMailbox(message('Subject: x\r\n\r\n'), 'from'), '');
    });

    it('uses the decoded display name or the address (RFC 5957 section 3)', () => {
        assert.strictEqual(displayAddress(message(raw), 'from'), 'Änne');
        assert.strictEqual(displayAddress(message('From: a@b.example\r\n\r\n'), 'from'), 'a@b.example');
        assert.strictEqual(displayAddress(message('From: "" <a@b.example>\r\n\r\n'), 'from'), 'a@b.example');
        assert.strictEqual(displayAddress(message('To: Group: amy@h.example;\r\n\r\n'), 'to'), 'Group');
        assert.strictEqual(displayAddress(message('Subject: x\r\n\r\n'), 'to'), '');
    });
});

describe('Message IDs (RFC 5256 section 3, REFERENCES)', () => {
    const cases = [
        ['<a@b>', ['a@b']],
        ['<a@b> <c@d>\r\n <e@f>', ['a@b', 'c@d', 'e@f']],
        // the RFC 5256 example: quoting does not matter
        ['<"01KF8JCEOCBS0045PS"@xxx.yyy.com>', ['01KF8JCEOCBS0045PS@xxx.yyy.com']],
        ['<"a\\"b"@c>', ['a"b@c']],
        ['< a @ b > (comment <x@y>)', ['a@b']],
        ['foo bar <a@b> <c@d>', ['a@b', 'c@d']],
        ['"quoted <x@y>" <a@b>', ['a@b']],
        ['(nested (comment) <x@y>) <a@b>', ['a@b']],
        ['<noat> <@b> <a@> <a@b>', ['a@b']],
        ['<a@[127.0.0.1]>', ['a@[127.0.0.1]']],
        ['garbage', []],
        [undefined, []],
        [
            ['<a@b>', '<c@d>'],
            ['a@b', 'c@d']
        ]
    ];
    for (const [value, expected] of cases) {
        it('parses ' + JSON.stringify(value), () => {
            assert.deepStrictEqual(parseMessageIds(value), expected);
        });
    }
});
