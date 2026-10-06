'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const {
    parseScenario,
    buildPayload,
    splitAtLiterals,
    normalizeResponse,
    normalizeResponses,
    sameStep,
    collectSeed,
    runTarget,
    startHoodiecrow,
    sessionLines
} = require('../compare/compare');

const compareDir = path.join(__dirname, '..', 'compare');

describe('Dovecot comparison tool', () => {
    it('parses scenario lines into steps', () => {
        const steps = parseScenario(['# comment', '', 'SELECT INBOX', '2: NOOP', '2:> DONE', '!wait 50'].join('\n'));

        assert.deepStrictEqual(
            steps.map(step => [step.type, step.session, step.tag, step.text || step.ms]),
            [
                ['command', 1, 'A1', 'A1 SELECT INBOX'],
                ['command', 2, 'A2', 'A2 NOOP'],
                ['raw', 2, null, 'DONE'],
                ['wait', undefined, undefined, 50]
            ]
        );
        assert.throws(() => parseScenario('!sleep 5'), /unknown directive/);
    });

    it('builds payloads with escapes, credentials and file literals', () => {
        const vars = { user: 'u', pass: 'p' };

        assert.strictEqual(buildPayload('A1 LOGIN $USER $PASS', vars, compareDir).toString(), 'A1 LOGIN u p\r\n');
        assert.strictEqual(buildPayload('A1 SELECT {5}\\r\\nINBOX', vars, compareDir).toString(), 'A1 SELECT {5}\r\nINBOX\r\n');

        const payload = buildPayload('A1 APPEND INBOX {file+:messages/simple.eml}', vars, compareDir).toString();
        const match = payload.match(/^A1 APPEND INBOX \{(\d+)\+\}\r\n([\s\S]*)\r\n$/);
        assert.ok(match);
        assert.strictEqual(Buffer.byteLength(match[2]), Number(match[1]));
        assert.ok(!/[^\r]\n/.test(match[2]), 'line endings are converted to CRLF');
    });

    it('splits payloads after synchronizing literals only', () => {
        const chunks = splitAtLiterals(Buffer.from('A1 X {3}\r\n{1}\r\n {2+}\r\nab {0}\r\n\r\n')).map(chunk => chunk.toString());

        assert.deepStrictEqual(chunks, ['A1 X {3}\r\n', '{1}\r\n {2+}\r\nab {0}\r\n', '\r\n']);
    });

    it('normalizes responses that legitimately differ', () => {
        assert.strictEqual(normalizeResponse('A1 OK [READ-WRITE] Select completed (0.001 + 0.000 + 0.001 secs).'), 'A1 OK [READ-WRITE]');
        assert.strictEqual(
            normalizeResponse('A1 OK [READ-WRITE] Select completed (0.001 + 0.000 secs).', { keepText: true }),
            'A1 OK [READ-WRITE] Select completed.'
        );
        assert.strictEqual(normalizeResponse('* OK [UIDVALIDITY 1791313744] UIDs valid'), '* OK [UIDVALIDITY <n>]');
        assert.strictEqual(normalizeResponse('A1 OK [COPYUID 12 1:2 3:4] Done'), 'A1 OK [COPYUID <n> 1:2 3:4]');
        assert.strictEqual(normalizeResponse('+ idling'), '+ <text>');
        assert.strictEqual(normalizeResponse('+ '), '+ ');
        assert.strictEqual(normalizeResponse('* LIST (\\HasNoChildren \\Drafts) "/" "INBOX"'), '* LIST (\\Drafts \\HasNoChildren) "/" INBOX');
        assert.strictEqual(normalizeResponse('* LIST () "/" "a b"'), '* LIST () "/" "a b"');
        assert.strictEqual(normalizeResponse('* 1 FETCH (FLAGS (\\Seen \\Answered))'), '* 1 FETCH (FLAGS (\\Answered \\Seen))');
        assert.strictEqual(normalizeResponse('* 1 FETCH (FLAGS (\\Seen \\Answered))', { exact: true }), '* 1 FETCH (FLAGS (\\Seen \\Answered))');

        assert.deepStrictEqual(normalizeResponses([Buffer.from('* LIST () "/" b'), Buffer.from('* LIST () "/" a'), Buffer.from('A1 OK x')]), [
            '* LIST () "/" a',
            '* LIST () "/" b',
            'A1 OK'
        ]);
    });

    it('compares steps including notes', () => {
        const step = (lines, notes) => ({ responses: { 1: lines.map(line => Buffer.from(line)) }, notes: notes || [] });

        assert.ok(sameStep(step(['A1 OK Completed']), step(['A1 OK NOOP completed (0.001 + 0.000 secs).'])));
        assert.ok(!sameStep(step(['A1 OK Completed']), step(['A1 NO Failed'])));
        assert.ok(!sameStep(step([], ['connection closed']), step([])));
    });

    it('collects seed data without modifying the storage', () => {
        const storage = {
            INBOX: { messages: [{ raw: 'Subject: a\r\n\r\nA', flags: ['\\Seen', '\\Recent'] }] },
            '': { separator: '/', folders: { Parent: { flags: ['\\Noselect'], folders: { Child: {} } } } },
            '#news.': { type: 'shared', separator: '.', folders: { Shared: {} } }
        };
        const copy = structuredClone(storage);
        const seed = collectSeed(storage);

        assert.deepStrictEqual(storage, copy);
        assert.deepStrictEqual(
            seed.folders.map(folder => folder.path),
            ['INBOX', 'Parent/Child']
        );
        assert.deepStrictEqual(seed.folders[0].messages[0].flags, ['\\Seen']);
        assert.strictEqual(seed.folders[0].messages[0].uid, 1);
        assert.strictEqual(seed.warnings.length, 1);
    });

    it('runs a scenario against hoodiecrow', async () => {
        const server = await startHoodiecrow({ INBOX: { messages: ['Subject: a\r\n\r\nA'] } }, ['IDLE']);
        try {
            const steps = parseScenario(
                ['1: SELECT {5}\\r\\nINBOX', '1: IDLE', '2: APPEND INBOX {file:messages/simple.eml}', '1:> DONE', '2: LOGOUT', '2: NOOP'].join('\n')
            );
            const result = await runTarget({ name: 'hoodiecrow', host: '127.0.0.1', port: server.address().port, user: 'testuser', pass: 'testpass' }, steps, {
                timeout: 2000,
                settle: 20,
                baseDir: compareDir
            });
            const text = result.steps.map(step => sessionLines(step.responses, true).join('\n'));

            assert.match(text[0], /^\[1\] \+ /);
            assert.match(text[0], /\[1\] \* 1 EXISTS/);
            assert.match(text[0], /\[1\] A1 OK \[READ-WRITE\]/);
            assert.match(text[1], /\[1\] \+ idling/);
            assert.match(text[2], /\[1\] \* 2 EXISTS/);
            assert.match(text[2], /\[2\] A3 OK APPEND/);
            // the raw DONE line waits for the tagged response of the IDLE command it ends
            assert.match(text[3], /\[1\] A2 OK IDLE terminated/);
            assert.deepStrictEqual(result.steps[3].notes, []);
            assert.match(text[4], /\[2\] \* BYE/);
            assert.deepStrictEqual(result.steps[5].notes, ['connection closed']);
            assert.strictEqual(result.setup.length, 4, 'greeting and login of both sessions are kept apart');
        } finally {
            server.close();
        }
    });
});
