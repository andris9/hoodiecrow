'use strict';

// Modified BASE64 alphabet of RFC 3501 section 5.1.3 ("," instead of "/")
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+,';

/**
 * Checks a mailbox name against the modified UTF-7 rules of RFC 3501 section 5.1.3:
 * printable US-ASCII represents itself, "&" is written as "&-", everything else
 * is encoded in modified BASE64 between "&" and "-", without superfluous shifts
 * and without encoding printable US-ASCII.
 *
 * @param {String} name Mailbox name as a binary string
 * @return {String|Boolean} Description of the problem, or false if the name is valid
 */
module.exports = function validateMailboxName(name) {
    if (typeof name !== 'string') {
        return 'Invalid mailbox name';
    }

    let i = 0;
    while (i < name.length) {
        const code = name.charCodeAt(i);

        if (code < 0x20 || code > 0x7e) {
            return 'Mailbox name must use modified UTF-7 for non-ASCII characters (RFC 3501 section 5.1.3)';
        }

        if (name.charAt(i) !== '&') {
            i++;
            continue;
        }

        if (name.charAt(i + 1) === '-') {
            // "&-" is the "&" character
            i += 2;
            continue;
        }

        const end = name.indexOf('-', i + 1);
        if (end < 0) {
            return 'Modified BASE64 in mailbox name must end with "-" (RFC 3501 section 5.1.3)';
        }

        const error = checkBase64(name.slice(i + 1, end));
        if (error) {
            return error;
        }

        if (name.charAt(end + 1) === '&' && name.charAt(end + 2) !== '-') {
            return 'Mailbox name contains a superfluous shift (RFC 3501 section 5.1.3)';
        }

        i = end + 1;
    }

    return false;
};

function checkBase64(encoded) {
    let bits = 0;
    let bitCount = 0;
    const units = [];

    for (let i = 0; i < encoded.length; i++) {
        const value = BASE64_CHARS.indexOf(encoded.charAt(i));
        if (value < 0) {
            return 'Invalid modified BASE64 in mailbox name (RFC 3501 section 5.1.3)';
        }
        bits = (bits << 6) | value;
        bitCount += 6;
        if (bitCount >= 16) {
            bitCount -= 16;
            units.push((bits >> bitCount) & 0xffff);
            bits &= (1 << bitCount) - 1;
        }
    }

    // leftover bits are padding and must be zero, and must not hold a partial character
    if (!units.length || bitCount >= 6 || bits !== 0) {
        return 'Invalid modified BASE64 in mailbox name (RFC 3501 section 5.1.3)';
    }

    for (let i = 0; i < units.length; i++) {
        const unit = units[i];
        if (unit >= 0x20 && unit <= 0x7e) {
            return 'Modified BASE64 must not encode printable US-ASCII (RFC 3501 section 5.1.3)';
        }
        if (unit >= 0xd800 && unit <= 0xdbff) {
            if (!(units[i + 1] >= 0xdc00 && units[i + 1] <= 0xdfff)) {
                return 'Invalid UTF-16 in mailbox name';
            }
            i++;
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
            return 'Invalid UTF-16 in mailbox name';
        }
    }

    return false;
}

/**
 * Encodes a unicode mailbox name in modified UTF-7 (RFC 3501 section 5.1.3)
 *
 * @param {String} name Unicode mailbox name
 * @return {String} Modified UTF-7 mailbox name
 */
module.exports.encodeMailboxName = function encodeMailboxName(name) {
    return name
        .replace(/&/g, '&-')
        .replace(/[^\x20-\x7e]+/g, chunk => '&' + Buffer.from(chunk, 'utf16le').swap16().toString('base64').replace(/=+$/, '').replace(/\//g, ',') + '-');
};
