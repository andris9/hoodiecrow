import { describe, it } from 'node:test';
import assert from 'node:assert';
import { splitResponses, splitAtLiterals } from '../src/framing.js';
import { hasSequenceSetKey } from '../src/commands/handlers/search.js';
import { monthIndex, isRealDate } from '../src/dates.js';
import imapkit from '../src/server.js';
import type { FrameIncomplete } from '../src/framing.js';
import type { Attribute } from '../src/types.js';

describe('Response framing', () => {
    it('splits strings and buffers into responses with literals', () => {
        const data = '* 1 FETCH (BODY[] {4}\r\na\r\nb UID 1)\r\nA1 OK done\n* partial';
        for (const input of [data, Buffer.from(data, 'binary')]) {
            const framed = splitResponses(input);
            assert.strictEqual(framed.responses.length, 2);
            assert.deepStrictEqual(framed.responses[0].literals, [{ start: 23, end: 27, literal8: false }]);
            // lenient: a bare LF ends a line too
            assert.strictEqual(framed.responses[1].lines[0].end, framed.responses[1].lines[0].lf);
            assert.strictEqual(framed.end, data.indexOf('* partial'));
            assert.strictEqual((framed.incomplete as FrameIncomplete).reason, 'line');
        }
    });

    it('reports where an incomplete response stops', () => {
        assert.deepStrictEqual(splitResponses('* 1 FETCH (BINARY[] ~{5}\r\nab').incomplete, {
            reason: 'literal',
            size: 5,
            available: 2,
            lines: [{ start: 0, end: 24, lf: 25 }]
        });
        assert.strictEqual((splitResponses('* 1 FETCH (BODY[] {2}\r\nab').incomplete as FrameIncomplete).reason, 'response');
        assert.strictEqual(splitResponses('* OK done\r\n').incomplete, false);
    });

    it('splits commands after synchronizing literals only and skips literal data', () => {
        assert.deepStrictEqual(splitAtLiterals('A1 LOGIN {2}\r\nab {3+}\r\n{1}\r\n'), ['A1 LOGIN {2}\r\n', 'ab {3+}\r\n{1}\r\n']);
        assert.deepStrictEqual(splitAtLiterals('A1 NOOP\r\n'), ['A1 NOOP\r\n']);
        const chunks = splitAtLiterals(Buffer.from('A1 X {1}\r\n~{1}\r\n'));
        assert.ok(chunks.every(chunk => Buffer.isBuffer(chunk)));
        assert.deepStrictEqual(
            chunks.map(chunk => chunk.toString()),
            ['A1 X {1}\r\n', '~{1}\r\n']
        );
    });
});

describe('Sequence numbers in SEARCH criteria', () => {
    const server = imapkit({ plugins: ['X-GM-EXT-1'] });
    const atoms = (list: Attribute[]): Attribute[] => list.map(item => (Array.isArray(item) ? atoms(item) : { type: 'ATOM', value: item }));
    const uses = (list: Attribute[]) => hasSequenceSetKey(server, atoms(list));

    it('finds sequence set keys', () => {
        assert.strictEqual(uses(['1:3']), true);
        assert.strictEqual(uses(['NOT', '2']), true);
        assert.strictEqual(uses(['OR', 'SEEN', '*']), true);
        assert.strictEqual(uses(['UNSEEN', ['FLAGGED', '1,2']]), true);
    });

    it('ignores key arguments', () => {
        assert.strictEqual(uses(['UID', '1:3']), false);
        assert.strictEqual(uses(['CHARSET', 'UTF-8', 'HEADER', '1', '2', 'LARGER', '100']), false);
        assert.strictEqual(uses(['OR', 'SMALLER', '5', 'NOT', 'SUBJECT', '7']), false);
        // plugin keys take arguments too
        assert.strictEqual(uses(['X-GM-MSGID', '123']), false);
    });
});

describe('Dates', () => {
    it('knows month names and real dates', () => {
        assert.strictEqual(monthIndex('feb'), 1);
        assert.strictEqual(monthIndex('Foo'), -1);
        assert.strictEqual(isRealDate(29, 1, 2024), true);
        assert.strictEqual(isRealDate(29, 1, 2023), false);
        assert.strictEqual(isRealDate(1, -1, 2023), false);
        assert.strictEqual(isRealDate(0, 0, 2023), false);
    });
});
