// Limits and checks of the numbers in the IMAP grammar

// RFC 3501 and RFC 9051 section 9: number and nz-number are unsigned 32-bit integers
const MAX_NUMBER = 4294967295;
// RFC 9051 section 9: number64 is an unsigned 63-bit integer, so is mod-sequence-value (RFC 7162 section 7)
const MAX_NUMBER64 = 2n ** 63n - 1n;

/**
 * Checks if a value is a number by the grammar: 1*DIGIT, up to a limit
 *
 * @param {*} value Value to check, only strings can match
 * @param {Number|BigInt} [max] Largest allowed value, MAX_NUMBER by default
 * @return {Boolean} true if the value is a number within the limit
 */
function isNumber(value: unknown, max?: number | bigint): boolean {
    const limit = String(max === undefined ? MAX_NUMBER : max);
    // a longer string of digits is too large anyway, so no BigInt is built from it
    if (typeof value !== 'string' || !/^\d+$/.test(value) || value.replace(/^0+(?=\d)/, '').length > limit.length) {
        return false;
    }
    return BigInt(value) <= BigInt(limit);
}

/**
 * Checks if a value is a non-zero number (nz-number, nz-number64): digit-nz *DIGIT, up to a limit
 *
 * @param {*} value Value to check, only strings can match
 * @param {Number|BigInt} [max] Largest allowed value, MAX_NUMBER by default
 * @return {Boolean} true if the value is a non-zero number within the limit
 */
function isNzNumber(value: unknown, max?: number | bigint): boolean {
    return isNumber(value, max) && /^[1-9]/.test(value as string);
}

/**
 * Checks if a value is a sequence set (RFC 3501 and RFC 9051 section 9): seq-number or seq-range items
 * separated by commas, seq-number = nz-number / "*"
 *
 * @param {*} value Value to check, only strings can match
 * @param {Boolean} [noStar] If true, "*" is not allowed (e.g. known-uids of RFC 7162 section 7)
 * @return {Boolean} true if the value is a valid sequence set
 */
function isSequenceSet(value: unknown, noStar?: boolean): boolean {
    if (typeof value !== 'string' || !/^[\d*]+(:[\d*]+)?(,[\d*]+(:[\d*]+)?)*$/.test(value)) {
        return false;
    }
    return value.split(/[,:]/).every(part => (part === '*' ? !noStar : isNzNumber(part)));
}

export { MAX_NUMBER, MAX_NUMBER64, isNumber, isNzNumber, isSequenceSet };
