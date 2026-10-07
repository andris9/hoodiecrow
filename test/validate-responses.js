'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { validateResponses, splitResponses } = require('./helpers/validate-responses');

describe('Response grammar guardrail', () => {
    const valid = [
        '* OK Hoodiecrow ready\r\n',
        'A1 OK [READ-WRITE] SELECT completed\r\n',
        '* OK [PERMANENTFLAGS (\\Seen \\*)] Flags permitted\r\n',
        '* 0 EXISTS\r\n* 0 RECENT\r\n',
        '* 1 FETCH (UID 1 FLAGS (\\Seen))\r\n',
        '* 1 FETCH (BODY[] {3}\r\nabc UID 4)\r\n',
        '* 1 FETCH (BODY[HEADER] {2}\r\nab BODY[TEXT] {0}\r\n)\r\n',
        '* 1 FETCH (BINARY[] ~{3}\r\na\x00c)\r\n',
        '* SEARCH\r\n* SEARCH 1 2 3\r\n* SEARCH 1 (MODSEQ 5)\r\n',
        // RFC 4466 section 2.6.2, RFC 4731 section 4
        '* ESEARCH\r\n* ESEARCH (TAG "A1")\r\n* ESEARCH (TAG "A1") UID MIN 1 MAX 3 ALL 1:3,5 COUNT 4 MODSEQ 7\r\n',
        '* ESEARCH COUNT 0\r\n* ESEARCH (TAG "A1") X-FOO (1 2)\r\n',
        '+ idling\r\n',
        '+ \r\n',
        '* XTOYBIRD ok\r\n'
    ];

    valid.forEach(transcript => {
        it('accepts ' + JSON.stringify(transcript), async () => {
            await validateResponses(transcript);
        });
    });

    const invalid = [
        ['* OK ready\n', /bare LF/],
        ['* OK re\rady\r\n', /bare CR/],
        ['* OK ready', /not terminated/],
        ['* 1 FETCH (BODY[] {10}\r\nabc)\r\n', /cut short/],
        ['+\r\n', /must start with "\+ "/],
        ['A1 OK\r\n', /SP and text/],
        ['A1 OK [READ-WRITE]\r\n', /SP and text/],
        ['A1 OK [READ-WRITE\r\n', /closing|ImapFlow/],
        ['A+1 OK done\r\n', /tag OK/],
        ['A1 MAYBE done\r\n', /tag OK/],
        ['* 0 FETCH (UID 1)\r\n', /nz-number/],
        ['* 0 EXPUNGE\r\n', /nz-number/],
        ['* 1 FETCH (UID 1 FLAGS)\r\n', /pairs/],
        ['* 1 FETCH UID 1\r\n', /parenthesized/],
        ['* 1 FETCH (UID\r\n', /ImapFlow/],
        ['* SEARCH 0\r\n', /nz-numbers/],
        ['* ESEARCH (TAG A1) COUNT 1\r\n', /correlator/],
        ['* ESEARCH (TAG "A1") UID COUNT\r\n', /pairs/],
        ['* ESEARCH MIN 0\r\n', /MIN has an invalid value/],
        ['* ESEARCH ALL 1:*\r\n', /ALL has an invalid value/],
        ['* ESEARCH COUNT 1 COUNT 1\r\n', /more than once/],
        ['* ESEARCH 1 2\r\n', /tagged-ext-label/],
        ['* FROBNICATE 1\r\n', /Unknown untagged/],
        ['* OK caf\xe9\r\n', /8-bit/],
        ['* 1 FETCH (BODY[] {3}\r\na\x00c)\r\n', /NUL/]
    ];

    invalid.forEach(([transcript, error]) => {
        it('rejects ' + JSON.stringify(transcript), async () => {
            await assert.rejects(validateResponses(transcript), error);
        });
    });

    it('keeps literals with their response', () => {
        const responses = splitResponses('* 1 FETCH (BODY[] {4}\r\na\r\nb) UID 1)\r\nA1 OK done\r\n');
        assert.strictEqual(responses.length, 2);
        assert.strictEqual(responses[0].literals[0].toString(), 'a\r\nb');
    });
});
