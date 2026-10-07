'use strict';

// Checks of parsed command arguments (imap-handler parser output)

/**
 * Checks if a parsed argument is an atom, optionally a specific one
 *
 * @param {Object} value Parsed argument
 * @param {String} [name] Upper case atom to match, the value is compared case-insensitively
 * @return {Boolean} true for an atom (with that name)
 */
function isAtom(value, name) {
    return !!value && !Array.isArray(value) && value.type === 'ATOM' && (name === undefined || String(value.value).toUpperCase() === name);
}

/**
 * Checks if a parsed argument is an astring (RFC 3501 section 9): an atom, a quoted string or a literal. An
 * atom the parser split into a section or partial range (like BODY[1]<0.5>) is not
 *
 * @param {Object} value Parsed argument
 * @return {Boolean} true for an astring
 */
function isAstring(value) {
    return !!value && !Array.isArray(value) && ['ATOM', 'STRING', 'LITERAL'].indexOf(value.type) >= 0 && !value.section && !value.partial;
}

module.exports = { isAtom, isAstring };
