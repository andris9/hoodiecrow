'use strict';

// AUTHENTICATE OAUTHBEARER, RFC 7628 (https://www.rfc-editor.org/rfc/rfc7628.txt), with the GS2
// header of RFC 5801 section 4 and SASL-IR (RFC 4959)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { setupServer } = require('./helpers');
const { parseClientResponse } = require('../lib/plugins/oauthbearer');

const b64 = str => Buffer.from(str, 'binary').toString('base64');
// the client response of RFC 7628 section 4.1, ^A is %x01
const response = (header, pairs) => b64(header + '\x01' + pairs.map(pair => pair + '\x01').join('') + '\x01');
const VALID = response('n,a=testuser,', ['host=localhost', 'port=143', 'auth=Bearer testtoken']);

const decodeChallenge = resp => {
    const match = resp.match(/^\+ (\S+)\r\n/m);
    return match && JSON.parse(Buffer.from(match[1], 'base64').toString());
};

describe('AUTHENTICATE OAUTHBEARER', () => {
    const ctx = setupServer(() => ({
        plugins: ['OAUTHBEARER', 'SASL-IR'],
        users: {
            testuser: { password: 'testpass', xoauth2: { accessToken: 'testtoken' } },
            'other,user': { password: 'x', xoauth2: { accessToken: 'othertoken' } }
        }
    }));

    // runs the commands, then checks the tagged result of each tag
    const run = (commands, expected, check) => (t, done) => {
        ctx.run([...commands, 'ZZ SELECT INBOX'], resp => {
            resp = resp.toString('binary');
            for (const tag of Object.keys(expected)) {
                const match = resp.match(new RegExp('^' + tag + ' (OK|NO|BAD)\\b', 'm'));
                assert.ok(match, 'no tagged response for ' + tag + '\n' + resp);
                assert.strictEqual(match[1], expected[tag], tag + ' answered ' + match[1] + '\n' + resp);
            }
            if (check) {
                check(resp);
            }
            done();
        });
    };

    it('is advertised before login only', (t, done) => {
        ctx.run(['A1 CAPABILITY', 'A2 LOGIN testuser testpass', 'A3 CAPABILITY'], resp => {
            resp = resp.toString('binary');
            const capabilities = resp.match(/^\* CAPABILITY .*$/gm);
            assert.match(capabilities[0], / AUTH=OAUTHBEARER( |$)/);
            assert.doesNotMatch(capabilities[1], /AUTH=OAUTHBEARER/);
            done();
        });
    });

    // RFC 7628 section 4.1
    it('logs in with an initial response', run(['A1 AUTHENTICATE OAUTHBEARER ' + VALID], { A1: 'OK', ZZ: 'OK' }));

    it(
        'logs in without an authzid, the token tells the user',
        run(['A1 AUTHENTICATE OAUTHBEARER ' + response('n,,', ['auth=Bearer testtoken'])], { A1: 'OK' })
    );

    it(
        'decodes =2C and =3D in the authzid (RFC 5801 section 4)',
        run(['A1 AUTHENTICATE OAUTHBEARER ' + response('n,a=other=2Cuser,', ['auth=Bearer othertoken'])], { A1: 'OK' })
    );

    it(
        'accepts the "F" and "y" flags, a case insensitive scheme name and unknown keys',
        run(['A1 AUTHENTICATE OAUTHBEARER ' + response('F,y,a=testuser,', ['qs=', 'auth=bEaReR testtoken', 'mthd=POST'])], { A1: 'OK' })
    );

    // without SASL-IR the client response follows an empty continuation request
    it(
        'logs in without an initial response',
        run(['A1 AUTHENTICATE OAUTHBEARER', VALID], { A1: 'OK', ZZ: 'OK' }, resp => {
            assert.match(resp, /^\+ \r\n/m);
        })
    );

    it('can be cancelled at the continuation request', run(['A1 AUTHENTICATE OAUTHBEARER', '*'], { A1: 'BAD', ZZ: 'BAD' }));

    // RFC 7628 sections 3.2.2 and 3.2.3: an error result in JSON, a dummy %x01 response, then NO
    it(
        'sends an error result for a wrong token and fails after the %x01 response',
        run(['A1 AUTHENTICATE OAUTHBEARER ' + response('n,a=testuser,', ['auth=Bearer wrongtoken']), 'AQ=='], { A1: 'NO', ZZ: 'BAD' }, resp => {
            assert.deepStrictEqual(decodeChallenge(resp), { status: 'invalid_token' });
        })
    );

    it(
        'sends an error result for an empty token (RFC 7628 section 4.3)',
        run(['A1 AUTHENTICATE OAUTHBEARER ' + response('n,a=testuser,', ['host=localhost', 'port=143', 'auth=']), 'AQ=='], { A1: 'NO' }, resp => {
            assert.deepStrictEqual(decodeChallenge(resp), { status: 'invalid_token' });
        })
    );

    it(
        'sends an error result for the token of another user',
        run(['A1 AUTHENTICATE OAUTHBEARER ' + response('n,a=testuser,', ['auth=Bearer othertoken']), 'AQ=='], { A1: 'NO' })
    );

    it(
        'sends an error result for an unknown user',
        run(['A1 AUTHENTICATE OAUTHBEARER ' + response('n,a=nobody,', ['auth=Bearer testtoken']), 'AQ=='], { A1: 'NO' })
    );

    const invalidRequests = [
        ['a missing auth value', response('n,a=testuser,', ['host=localhost'])],
        ['another auth scheme', response('n,a=testuser,', ['auth=Basic dGVzdA=='])],
        ['a port with a leading zero', response('n,a=testuser,', ['port=0143', 'auth=Bearer testtoken'])],
        // RFC 5801 section 5: the server MUST fail when the client used channel binding it does not support
        ['channel binding', response('p=tls-unique,a=testuser,', ['auth=Bearer testtoken'])]
    ];
    for (const [description, input] of invalidRequests) {
        it(
            'sends an invalid_request error result for ' + description,
            run(['A1 AUTHENTICATE OAUTHBEARER ' + input, 'AQ=='], { A1: 'NO' }, resp => {
                assert.deepStrictEqual(decodeChallenge(resp), { status: 'invalid_request' });
            })
        );
    }

    // RFC 3501 section 6.2.2: a cancelled exchange is answered with BAD
    it('can be cancelled at the error result', run(['A1 AUTHENTICATE OAUTHBEARER ' + response('n,,', ['auth=Bearer wrong']), '*'], { A1: 'BAD' }));

    // RFC 7628 section 3.2.3: the client MUST send a single %x01 or cancel
    it(
        'refuses anything but %x01 after the error result',
        run(['A1 AUTHENTICATE OAUTHBEARER ' + response('n,,', ['auth=Bearer wrong']), b64('\x01\x01')], { A1: 'BAD' })
    );

    it('refuses invalid base64 after the error result', run(['A1 AUTHENTICATE OAUTHBEARER ' + response('n,,', ['auth=Bearer wrong']), 'AQ'], { A1: 'BAD' }));

    // RFC 7628 section 3.1: a single kvsep is only valid after an error, the server may just fail
    it('fails a first message of a single %x01', run(['A1 AUTHENTICATE OAUTHBEARER AQ=='], { A1: 'NO' }));

    const malformed = [
        ['without a GS2 header', b64('auth=Bearer testtoken\x01\x01')],
        ['with an invalid channel binding flag', response('x,a=testuser,', ['auth=Bearer testtoken'])],
        ['with an invalid escape in the authzid', response('n,a=test=41user,', ['auth=Bearer testtoken'])],
        ['with invalid UTF-8 in the authzid', response('n,a=\xff,', ['auth=Bearer testtoken'])],
        ['without the closing %x01', b64('n,,\x01auth=Bearer testtoken\x01')],
        ['without the %x01 after a pair', b64('n,,\x01auth=Bearer testtoken\x01host=x\x01')],
        ['with a key that is not ALPHA', response('n,,', ['au-th=x', 'auth=Bearer testtoken'])],
        ['with 8-bit data in a value', response('n,,', ['host=\xe9', 'auth=Bearer testtoken'])],
        ['as an empty response', '=']
    ];
    for (const [description, input] of malformed) {
        it('refuses a client response ' + description, run(['A1 AUTHENTICATE OAUTHBEARER ' + input], { A1: 'BAD' }));
    }

    it('refuses invalid base64', run(['A1 AUTHENTICATE OAUTHBEARER abc'], { A1: 'BAD' }));
    it('refuses extra arguments', run(['A1 AUTHENTICATE OAUTHBEARER ' + VALID + ' x'], { A1: 'BAD' }));
    it('can not be used after login', run(['A1 LOGIN testuser testpass', 'A2 AUTHENTICATE OAUTHBEARER ' + VALID], { A1: 'OK', A2: 'BAD' }));
});

describe('AUTHENTICATE OAUTHBEARER without SASL-IR', () => {
    const ctx = setupServer(() => ({ plugins: ['OAUTHBEARER'] }));

    // RFC 4959 section 3: an initial response needs the SASL-IR capability
    it('refuses an initial response', (t, done) => {
        ctx.run(['A1 AUTHENTICATE OAUTHBEARER ' + VALID, 'A2 AUTHENTICATE OAUTHBEARER', VALID], resp => {
            resp = resp.toString('binary');
            assert.match(resp, /^A1 BAD /m);
            assert.match(resp, /^A2 OK /m);
            done();
        });
    });
});

describe('OAUTHBEARER client response parser', () => {
    it('parses the example of RFC 7628 section 4.1', () => {
        const parsed = parseClientResponse(
            Buffer.from(
                Buffer.from(
                    'bixhPXVzZXJAZXhhbXBsZS5jb20sAWhvc3Q9c2VydmVyLmV4YW1wbGUuY29tAXBvcnQ9MTQzAWF1dGg9QmVhcmVyIHZGOWRmdDRxbVRjMk52YjNSbGNrQmhiSFJoZG1semRHRXVZMjl0Q2c9PQEB',
                    'base64'
                )
            )
        );
        assert.deepStrictEqual(parsed, {
            channelBinding: false,
            authzid: 'user@example.com',
            pairs: Object.assign(Object.create(null), {
                host: 'server.example.com',
                port: '143',
                auth: 'Bearer vF9dft4qmTc2Nvb3RlckBhbHRhdmlzdGEuY29tCg=='
            })
        });
    });
});
