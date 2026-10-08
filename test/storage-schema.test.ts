// The storage option is checked when a server is built: typos and wrong types fail with the path of the problem.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import imapkit, { storageSchema, validateStorage } from '../src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('storage validation', () => {
    const refused: [string, unknown, RegExp][] = [
        ['a storage that is not an object', [], /at the top level: storage is an object/],
        ['"message" for "messages"', { INBOX: { message: [] } }, /at "INBOX": unknown key "message", did you mean "messages"\?/],
        ['"folder" for "folders"', { '': { folder: {} } }, /at "": unknown key "folder", did you mean "folders"\?/],
        ['"uidValidity" for "uidvalidity"', { INBOX: { uidValidity: 5 } }, /did you mean "uidvalidity"\?/],
        [
            '"flag" in a message',
            { INBOX: { messages: [{ raw: 'x', flag: ['\\Seen'] }] } },
            /at "INBOX"\.messages\[0\]: unknown key "flag", did you mean "flags"\?/
        ],
        ['messages that are not a list', { INBOX: { messages: {} } }, /"INBOX"\.messages: must be a list/],
        ['a message that is a number', { INBOX: { messages: [5] } }, /messages\[0\]: a message is a string or an object/],
        ['a UID of 0', { INBOX: { messages: [{ raw: 'x', uid: 0 }] } }, /messages\[0\]\.uid: must be an integer/],
        ['flags that are not strings', { INBOX: { messages: [{ raw: 'x', flags: [1] }] } }, /\.flags: must be a flag or a list of flags/],
        ['a numeric internal date', { INBOX: { messages: [{ raw: 'x', internaldate: 5 }] } }, /\.internaldate: must be a date-time string or a Date/],
        // RFC 3501 section 9: date-time = DQUOTE date-day-fixed "-" date-month "-" date-year SP time SP zone DQUOTE
        [
            'an RFC 5322 date as the internal date',
            { INBOX: { messages: [{ raw: 'x', internaldate: 'Thu, 1 Jan 2026 10:00:00 +0000' }] } },
            /"INBOX"\.messages\[0\]\.internaldate: must be a date-time string like "14-Sep-2013 21:22:28 -0300" or a Date/
        ],
        [
            'an internal date without a zone',
            { INBOX: { messages: [{ raw: 'x', internaldate: '01-Jan-2026 10:00:00' }] } },
            /\.internaldate: must be a date-time/
        ],
        [
            'an internal date that does not exist',
            { INBOX: { messages: [{ raw: 'x', internaldate: '31-Feb-2026 10:00:00 +0000' }] } },
            /\.internaldate: must be a date-time/
        ],
        [
            'an internal date with a time out of range',
            { INBOX: { messages: [{ raw: 'x', internaldate: '01-Jan-2026 24:00:00 +0000' }] } },
            /\.internaldate: must be a date-time/
        ],
        ['an empty internal date', { INBOX: { messages: [{ raw: 'x', internaldate: '' }] } }, /\.internaldate: must be a date-time/],
        ['an invalid Date as the internal date', { INBOX: { messages: [{ raw: 'x', internaldate: new Date('x') }] } }, /\.internaldate: must be a date-time/],
        // RFC 8514 section 4.2: the save date is a date-time too
        [
            'an RFC 5322 date as the save date',
            { '': { folders: { A: { messages: [{ raw: 'x', SAVEDATE: 'Thu, 1 Jan 2026 10:00:00 +0000' }] } } } },
            /""\.folders\["A"\]\.messages\[0\]\.SAVEDATE: must be a date-time string like "14-Sep-2013 21:22:28 -0300" or a Date/
        ],
        ['a numeric save date', { INBOX: { messages: [{ raw: 'x', SAVEDATE: 5 }] } }, /\.SAVEDATE: must be a date-time/],
        ['a raw source that is a number', { INBOX: { messages: [{ raw: 5 }] } }, /\.raw: must be a string/],
        ['recent that is not a boolean', { INBOX: { messages: [{ raw: 'x', recent: 'yes' }] } }, /\.recent: must be true or false/],
        ['a UIDVALIDITY above 32 bits', { INBOX: { uidvalidity: 2 ** 32 } }, /"INBOX"\.uidvalidity: must be an integer/],
        ['mailbox flags that are a string', { INBOX: { flags: '\\Noselect' } }, /"INBOX"\.flags: must be a list of strings/],
        ['subscribed that is a string', { INBOX: { subscribed: 'yes' } }, /\.subscribed: must be true or false/],
        ['folders that are a list', { '': { folders: [] } }, /"".folders: must be an object of mailboxes/],
        ['a nested typo', { '': { folders: { A: { folders: { B: { mesages: [] } } } } } }, /at ""\.folders\["A"\]\.folders\["B"\]: unknown key "mesages"/],
        ['a mailbox that is not an object', { '': { folders: { A: 'x' } } }, /folders\["A"\]: a mailbox is an object/],
        ['a long separator', { '': { separator: '//' } }, /"".separator: must be a single character/],
        ['an unknown namespace type', { '#x/': { type: 'public' } }, /"#x\/".type: must be "personal", "user" or "shared"/]
    ];
    for (const [name, storage, error] of refused) {
        it('refuses ' + name, () => {
            assert.throws(() => validateStorage(storage), error);
        });
    }

    it('fails when the server is built', () => {
        assert.throws(() => imapkit({ storage: { INBOX: { message: [] } } as never }), /Invalid storage at "INBOX"/);
        assert.throws(
            () => imapkit({ storage: { INBOX: { messages: [{ raw: 'x', internaldate: 'Thu, 1 Jan 2026 10:00:00 +0000' }] } } }),
            /Invalid storage at "INBOX"\.messages\[0\]\.internaldate/
        );
    });

    it('accepts date-time strings in any month case, Dates and no internal date', () => {
        validateStorage({
            INBOX: {
                messages: [
                    { raw: 'x', internaldate: '14-Sep-2013 21:22:28 -0300' },
                    { raw: 'x', internaldate: ' 1-jan-2026 00:00:60 +0000' },
                    { raw: 'x', internaldate: new Date(0) as never },
                    { raw: 'x', internaldate: false },
                    { raw: 'x', SAVEDATE: '29-Feb-2024 23:59:59 +1400' } as never,
                    { raw: 'x' }
                ]
            }
        });
    });

    it('allows the data of plugins and raw sources as strings or Buffers', () => {
        validateStorage({
            INBOX: {
                acl: { anyone: 'lr' },
                metadata: { '/shared/comment': 'x' },
                'special-use': '\\Sent',
                HIGHESTMODSEQ: 5,
                messages: [
                    'Subject: raw\r\n\r\n',
                    { raw: Buffer.from('x') as never, MODSEQ: 3, 'X-GM-LABELS': ['a'], flags: '\\Seen', internaldate: new Date() as never }
                ]
            },
            '': { separator: '/', type: 'personal', folders: { Sent: { uidvalidity: 1, subscribed: false } } }
        });
    });

    it('accepts the snapshot of a server with plugin data', () => {
        const server = imapkit({ plugins: ['ACL', 'CONDSTORE', 'METADATA', 'OBJECTID', 'X-GM-EXT-1'] });
        server.control.addMessage('INBOX', { raw: 'Subject: x\r\n\r\nx\r\n', flags: ['\\Seen'] });
        server.control.createMailbox('Work/Sub');
        server.control.setAcl('Work', 'other', 'lr');
        server.control.setMetadata('Work', { '/shared/comment': 'work' });
        server.control.resetUidValidity('INBOX', { uids: 'offset' });
        validateStorage(server.control.snapshot());
    });

    it('accepts the storage files of the repository', () => {
        const files = fs.readdirSync(path.join(root, 'compare')).filter(name => name.endsWith('.json'));
        assert.ok(files.length > 0);
        files.forEach(name => validateStorage(JSON.parse(fs.readFileSync(path.join(root, 'compare', name), 'utf8'))));
    });

    it('describes the same shape as a JSON Schema', () => {
        assert.strictEqual(storageSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
        assert.deepStrictEqual(Object.keys(storageSchema.$defs), ['message', 'mailbox', 'namespace']);
        // the schema is plain JSON
        assert.deepStrictEqual(JSON.parse(JSON.stringify(storageSchema)), storageSchema);
    });
});
