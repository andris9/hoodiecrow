'use strict';

// LIST-EXTENDED, RFC 5258 (https://www.rfc-editor.org/rfc/rfc5258.txt). The storage follows the
// mailbox hierarchy of the examples in RFC 5258 section 5

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');

const LOGIN = 'A1 LOGIN testuser testpass';

const storage = () => ({
    INBOX: {
        subscribed: true,
        messages: [{ raw: 'Subject: hello\r\n\r\nWorld' }]
    },
    '': {
        separator: '/',
        folders: {
            Fruit: {
                subscribed: false,
                folders: {
                    Apple: { subscribed: false },
                    Banana: { subscribed: true },
                    // RFC 5258 example 2: subscribed, but does not exist
                    Peach: { subscribed: true, flags: ['\\Noselect'] }
                }
            },
            Tofu: { subscribed: false },
            Vegetable: {
                subscribed: true,
                folders: {
                    Broccoli: { subscribed: true },
                    Corn: { subscribed: false }
                }
            },
            Drafts: { subscribed: false, flags: ['\\NoInferiors'], 'special-use': '\\Drafts' },
            Sent: { subscribed: true, 'special-use': '\\Sent' }
        }
    }
});

// LIST responses of a transcript, in order, as [attributes, name, extended data]
const listed = resp =>
    [...resp.matchAll(/^\* LIST \(([^)]*)\) "\/" "([^"]*)"(?: (.*))?\r$/gm)].map(match => [
        match[1]
            .split(' ')
            .filter(flag => flag)
            .sort()
            .join(' '),
        match[2],
        match[3] || ''
    ]);

// the untagged responses of one command, followed by its tagged response
const section = (resp, tag) => {
    const match = resp.match(new RegExp('(?:^|\\n)((?:\\* [^\\r]*\\r\\n)*' + tag + ' [^\\r]*\\r\\n)'));
    assert.ok(match, 'no response for ' + tag + '\n' + resp);
    return match[1];
};

const names = resp => listed(resp).map(entry => entry[1]);

const byName = resp => Object.fromEntries(listed(resp).map(entry => [entry[1], entry]));

describe('LIST-EXTENDED', () => {
    const ctx = setupServer(() => ({ plugins: ['LIST-EXTENDED'], storage: storage() }));

    const run = (commands, callback) => ctx.run([LOGIN, ...commands, 'ZZ LOGOUT'], resp => callback(resp.toString('binary')));

    it('advertises the LIST-EXTENDED capability', (t, done) => {
        run(['A2 CAPABILITY'], resp => {
            assert.match(resp, /^\* CAPABILITY .*\bLIST-EXTENDED\b/m);
            done();
        });
    });

    it('keeps the RFC 3501 LIST unchanged', (t, done) => {
        run(['A2 LIST "" "*"', 'A3 LIST "" ""'], resp => {
            const entries = byName(resp);
            // \Noselect is not turned into \NonExistent and there is no \Subscribed
            assert.deepStrictEqual(entries['Fruit/Peach'].slice(0, 1), ['\\HasNoChildren \\Noselect']);
            assert.deepStrictEqual(entries.Vegetable.slice(0, 1), ['\\HasChildren']);
            // RFC 3501 section 6.3.8: an empty mailbox name returns the hierarchy delimiter
            assert.match(resp, /^\* LIST \(\\Noselect\) "\/" ""\r\nA3 OK/m);
            done();
        });
    });

    it('lists the existing mailboxes with empty selection options (RFC 5258 section 3)', (t, done) => {
        run(['A2 LIST () "" "*"'], resp => {
            assert.deepStrictEqual(names(resp), [
                'INBOX',
                'Fruit',
                'Fruit/Apple',
                'Fruit/Banana',
                'Tofu',
                'Vegetable',
                'Vegetable/Broccoli',
                'Vegetable/Corn',
                'Drafts',
                'Sent'
            ]);
            assert.match(resp, /^A2 OK/m);
            done();
        });
    });

    it('does not treat an empty pattern as a delimiter request (RFC 5258 section 3)', (t, done) => {
        run(['A2 LIST () "" ""', 'A3 LIST "" ("" "Tofu")'], resp => {
            assert.match(resp, /^A1 OK.*\r\nA2 OK/m);
            assert.deepStrictEqual(names(resp), ['Tofu']);
            done();
        });
    });

    it('lists a mailbox that matches several patterns once (RFC 5258 section 3, example 7)', (t, done) => {
        run(['A2 LIST "" ("INBOX" "Vegetable/%" "Vegetable/Corn" "inbox")'], resp => {
            assert.deepStrictEqual(names(resp), ['INBOX', 'Vegetable/Broccoli', 'Vegetable/Corn']);
            done();
        });
    });

    it('applies the reference to every pattern', (t, done) => {
        run(['A2 LIST "Vegetable/" ("Corn" "B%")'], resp => {
            // in the order of the patterns
            assert.deepStrictEqual(names(resp), ['Vegetable/Corn', 'Vegetable/Broccoli']);
            done();
        });
    });

    it('lists subscribed names with LIST (SUBSCRIBED) (RFC 5258 section 3.1, example 2)', (t, done) => {
        run(['A2 LIST (SUBSCRIBED) "" "*"'], resp => {
            assert.deepStrictEqual(listed(resp), [
                ['\\HasNoChildren \\Subscribed', 'INBOX', ''],
                ['\\HasNoChildren \\Subscribed', 'Fruit/Banana', ''],
                ['\\HasNoChildren \\NonExistent \\Subscribed', 'Fruit/Peach', ''],
                ['\\HasChildren \\Subscribed', 'Vegetable', ''],
                ['\\HasNoChildren \\Subscribed', 'Vegetable/Broccoli', ''],
                ['\\HasNoChildren \\Subscribed', 'Sent', '']
            ]);
            // \NonExistent replaces \Noselect, only one mbx-list-sflag is allowed
            assert.doesNotMatch(resp, /\\Noselect/);
            done();
        });
    });

    it('returns subscription state with RETURN (SUBSCRIBED) (RFC 5258 section 3.2, example 6)', (t, done) => {
        run(['A2 LIST "" "*" RETURN (SUBSCRIBED)'], resp => {
            const entries = byName(resp);
            assert.strictEqual(entries.Fruit[0], '\\HasChildren');
            assert.strictEqual(entries['Fruit/Banana'][0], '\\HasNoChildren \\Subscribed');
            // return options do not add mailboxes: Fruit/Peach does not exist
            assert.ok(!entries['Fruit/Peach'], resp);
            assert.strictEqual(listed(resp).length, 10);
            done();
        });
    });

    it('returns children attributes with RETURN (CHILDREN) (RFC 5258 section 4, example 3)', (t, done) => {
        run(['A2 LIST () "" "%" RETURN (CHILDREN)'], resp => {
            assert.deepStrictEqual(listed(resp), [
                ['\\HasNoChildren', 'INBOX', ''],
                ['\\HasChildren', 'Fruit', ''],
                ['\\HasNoChildren', 'Tofu', ''],
                ['\\HasChildren', 'Vegetable', ''],
                // RFC 3348 section 3: \HasNoChildren is redundant with \Noinferiors
                ['\\NoInferiors', 'Drafts', ''],
                ['\\HasNoChildren', 'Sent', '']
            ]);
            done();
        });
    });

    it('accepts REMOTE, there are no remote mailboxes (RFC 5258 section 3.1)', (t, done) => {
        run(['A2 LIST (REMOTE) "" "%"', 'A3 LIST () "" "%"'], resp => {
            const parts = resp.split(/^A2 OK.*\r\n/m);
            assert.deepStrictEqual(names(parts[0]), names(parts[1]));
            assert.strictEqual(names(parts[0]).length, 6);
            done();
        });
    });

    it('returns CHILDINFO with RECURSIVEMATCH (RFC 5258 section 3.5, example 8)', (t, done) => {
        run(['A2 LIST (SUBSCRIBED RECURSIVEMATCH) "" "%"'], resp => {
            assert.deepStrictEqual(listed(resp), [
                ['\\HasNoChildren \\Subscribed', 'INBOX', ''],
                // not subscribed, but a subscribed child is not listed
                ['\\HasChildren', 'Fruit', '("CHILDINFO" ("SUBSCRIBED"))'],
                // subscribed and has a subscribed child
                ['\\HasChildren \\Subscribed', 'Vegetable', '("CHILDINFO" ("SUBSCRIBED"))'],
                ['\\HasNoChildren \\Subscribed', 'Sent', '']
            ]);
            done();
        });
    });

    it('suppresses redundant CHILDINFO for mailboxes that do not match (RFC 5258 section 3.5)', (t, done) => {
        run(['A2 LIST (RECURSIVEMATCH SUBSCRIBED) "" "*"'], resp => {
            const entries = byName(resp);
            // every subscribed child of Fruit is listed itself
            assert.ok(!entries.Fruit, resp);
            assert.strictEqual(entries.Vegetable[2], '("CHILDINFO" ("SUBSCRIBED"))');
            assert.strictEqual(entries['Fruit/Banana'][2], '');
            done();
        });
    });

    it('returns CHILDINFO even when the matching child does not match the pattern (RFC 5258 example 9)', (t, done) => {
        run(['A2 LIST (SUBSCRIBED RECURSIVEMATCH) "" "Fruit"', 'A3 LIST (SUBSCRIBED RECURSIVEMATCH) "" "Tofu"'], resp => {
            assert.match(resp, /^\* LIST \(\\HasChildren\) "\/" "Fruit" \("CHILDINFO" \("SUBSCRIBED"\)\)\r\nA2 OK/m);
            assert.match(resp, /^A2 OK.*\r\nA3 OK/m);
            done();
        });
    });

    it('lists a deleted mailbox with children as \\NonExistent (RFC 5258 section 3.5)', (t, done) => {
        run(
            [
                'A2 CREATE Old/Child',
                'A3 SUBSCRIBE Old',
                'A4 DELETE Old',
                'A5 LIST () "" "Old"',
                'A6 LIST (SUBSCRIBED) "" "Old"',
                'A7 LIST (SUBSCRIBED RECURSIVEMATCH) "" "%"',
                'A8 LIST "" "Old"'
            ],
            resp => {
                assert.match(section(resp, 'A5'), /^\* LIST \(\\NonExistent \\HasChildren\) "\/" "Old"\r\nA5 OK/);
                assert.match(section(resp, 'A6'), /^\* LIST \(\\NonExistent \\Subscribed \\HasChildren\) "\/" "Old"\r\nA6 OK/);
                // no CHILDINFO, Old/Child is not subscribed
                assert.deepStrictEqual(byName(section(resp, 'A7')).Old, ['\\HasChildren \\NonExistent \\Subscribed', 'Old', '']);
                // plain LIST still reports \Noselect
                assert.match(section(resp, 'A8'), /^\* LIST \(\\HasChildren \\Noselect\) "\/" "Old"\r\nA8 OK/);
                done();
            }
        );
    });

    it('returns CHILDINFO for a mailbox that does not exist (RFC 5258 section 3.5 table)', (t, done) => {
        run(['A2 CREATE Old/Child', 'A3 SUBSCRIBE Old/Child', 'A4 DELETE Old', 'A5 LIST (SUBSCRIBED RECURSIVEMATCH) "" "Old"'], resp => {
            assert.match(resp, /^\* LIST \(\\NonExistent \\HasChildren\) "\/" "Old" \("CHILDINFO" \("SUBSCRIBED"\)\)\r\nA5 OK/m);
            done();
        });
    });

    it('treats options case insensitively and repeated options once (RFC 5258 section 3)', (t, done) => {
        run(['A2 LIST (subscribed SUBSCRIBED) "" "Vegetable" return (children CHILDREN subscribed)'], resp => {
            assert.match(resp, /^\* LIST \(\\Subscribed \\HasChildren\) "\/" "Vegetable"\r\nA2 OK/m);
            done();
        });
    });

    it('accepts an empty RETURN list', (t, done) => {
        run(['A2 LIST "" "Tofu" RETURN ()'], resp => {
            assert.match(resp, /^\* LIST \(\\HasNoChildren\) "\/" "Tofu"\r\nA2 OK/m);
            done();
        });
    });

    it('rejects options it does not know (RFC 5258 section 3)', (t, done) => {
        run(['A2 LIST (FOO) "" "%"', 'A3 LIST "" "%" RETURN (FOO)', 'A4 LIST (SPECIAL-USE) "" "%"', 'A5 LIST "" "%" RETURN (STATUS (MESSAGES))'], resp => {
            assert.match(resp, /^A2 BAD /m);
            assert.match(resp, /^A3 BAD /m);
            // SPECIAL-USE and LIST-STATUS are not loaded
            assert.match(resp, /^A4 BAD /m);
            assert.match(resp, /^A5 BAD /m);
            assert.doesNotMatch(resp, /^\* LIST/m);
            done();
        });
    });

    it('rejects RECURSIVEMATCH without a base option (RFC 5258 section 3.1)', (t, done) => {
        run(['A2 LIST (RECURSIVEMATCH) "" "*"', 'A3 LIST (REMOTE RECURSIVEMATCH) "" "*"', 'A4 LIST (REMOTE RECURSIVEMATCH SUBSCRIBED) "" "*"'], resp => {
            assert.match(resp, /^A2 BAD /m);
            assert.match(resp, /^A3 BAD /m);
            assert.match(resp, /^A4 OK /m);
            done();
        });
    });
});

describe('LIST-EXTENDED with SPECIAL-USE', () => {
    for (const plugins of [
        ['LIST-EXTENDED', 'SPECIAL-USE'],
        ['SPECIAL-USE', 'LIST-EXTENDED']
    ]) {
        describe(plugins.join(', '), () => {
            const ctx = setupServer(() => {
                const special = storage();
                Object.assign(special[''].folders.Fruit.folders.Apple, { subscribed: true, 'special-use': '\\Archive' });
                return { plugins, storage: special };
            });

            const run = (commands, callback) => ctx.run([LOGIN, ...commands, 'ZZ LOGOUT'], resp => callback(resp.toString('binary')));

            it('lists only special-use mailboxes with LIST (SPECIAL-USE) (RFC 6154 section 2, example 5.2)', (t, done) => {
                run(['A2 LIST (SPECIAL-USE) "" "*"'], resp => {
                    assert.deepStrictEqual(listed(resp), [
                        ['\\Archive \\HasNoChildren', 'Fruit/Apple', ''],
                        ['\\Drafts \\NoInferiors', 'Drafts', ''],
                        ['\\HasNoChildren \\Sent', 'Sent', '']
                    ]);
                    done();
                });
            });

            it('returns special-use attributes with RETURN (SPECIAL-USE) (RFC 6154 section 2)', (t, done) => {
                run(['A2 LIST "" "%" RETURN (SPECIAL-USE CHILDREN)'], resp => {
                    assert.strictEqual(listed(resp).length, 6);
                    assert.strictEqual(byName(resp).Sent[0], '\\HasNoChildren \\Sent');
                    assert.strictEqual(byName(resp).Tofu[0], '\\HasNoChildren');
                    done();
                });
            });

            it('combines SPECIAL-USE with other selection options', (t, done) => {
                run(['A2 LIST (SPECIAL-USE SUBSCRIBED) "" "*"', 'A3 LIST (SUBSCRIBED SPECIAL-USE RECURSIVEMATCH) "" "%"'], resp => {
                    const [a2, a3] = resp.split(/^A2 OK.*\r\n/m);
                    // a mailbox must match every selection option (RFC 5258 section 3)
                    assert.deepStrictEqual(names(a2), ['Fruit/Apple', 'Sent']);
                    assert.match(a2, /^\* LIST \(\\Subscribed \\HasNoChildren \\Sent\) "\/" "Sent"\r\n/m);
                    // CHILDINFO only names the list-select-base-opt options, SPECIAL-USE is independent
                    assert.deepStrictEqual(listed(a3), [
                        ['\\HasChildren', 'Fruit', '("CHILDINFO" ("SUBSCRIBED"))'],
                        ['\\HasNoChildren \\Sent \\Subscribed', 'Sent', '']
                    ]);
                    done();
                });
            });

            it('rejects SPECIAL-USE with RECURSIVEMATCH and no base option (RFC 6154 section 6, RFC 5258 section 6)', (t, done) => {
                run(['A2 LIST (SPECIAL-USE RECURSIVEMATCH) "" "*"'], resp => {
                    assert.match(resp, /^A2 BAD /m);
                    done();
                });
            });

            it('keeps the RFC 3501 LIST unchanged', (t, done) => {
                run(['A2 LIST "" "%"'], resp => {
                    assert.strictEqual(byName(resp).Sent[0], '\\HasNoChildren \\Sent');
                    assert.strictEqual(listed(resp).length, 6);
                    done();
                });
            });
        });
    }
});

describe('LIST without LIST-EXTENDED', () => {
    const ctx = setupServer(() => ({ storage: storage() }));

    it('rejects the extended syntax', (t, done) => {
        ctx.run([LOGIN, 'A2 CAPABILITY', 'A3 LIST () "" "%"', 'A4 LIST "" ("INBOX")', 'A5 LIST "" "%" RETURN (CHILDREN)', 'ZZ LOGOUT'], resp => {
            resp = resp.toString();
            assert.doesNotMatch(resp, /LIST-EXTENDED/);
            assert.match(resp, /^A3 BAD /m);
            assert.match(resp, /^A4 BAD /m);
            assert.match(resp, /^A5 BAD /m);
            done();
        });
    });
});
