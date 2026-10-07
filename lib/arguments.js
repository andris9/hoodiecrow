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

// characters that end an atom in a command line (RFC 3501 section 9 atom-specials, and "[" "]" of sections)
const ATOM_END = /[\s()[\]{"%*\\<]/;

/**
 * Lists how the client spelled the NIL atoms of a command line, in order. Quoted strings and literals are skipped
 *
 * @param {String} data Raw command line with its literals
 * @return {Array} spellings, e.g. ["nil", "NIL"]
 */
function nilSpellings(data) {
    const result = [];
    let i = 0;
    while (i < data.length) {
        const ch = data.charAt(i);
        if (ch === '"') {
            for (i++; i < data.length && data.charAt(i) !== '"'; i++) {
                if (data.charAt(i) === '\\') {
                    i++;
                }
            }
            i++;
            continue;
        }
        const literal = (ch === '{' || ch === '~') && data.substr(i, 32).match(/^~?\{(\d+)\+?\}\r\n/);
        if (literal) {
            i += literal[0].length + Number(literal[1]);
            continue;
        }
        if (ATOM_END.test(ch)) {
            i++;
            continue;
        }
        let end = i;
        while (end < data.length && !ATOM_END.test(data.charAt(end))) {
            end++;
        }
        const token = data.substring(i, end);
        if (/^nil$/i.test(token)) {
            result.push(token);
        }
        i = end;
    }
    return result;
}

/**
 * The parser turns every NIL atom into null, as in an nstring. Where the grammar has an astring (mailbox names, user
 * names, search strings, ...) NIL is an ordinary atom, so these nulls are turned back into atoms with the spelling
 * the client used
 *
 * @param {Object} parsed Parsed command, changed in place
 * @param {String} data Raw command line with its literals
 * @param {Function} select `(path)` returns true for the nulls to restore, `path` lists the indexes from the
 *   top-level arguments down, e.g. [2, 0] for the first item of a list in the third argument
 */
function restoreNilAtoms(parsed, data, select) {
    if (!parsed.attributes || !/nil/i.test(data || '')) {
        return;
    }
    // every null in the order the parser met them, sections included
    const nulls = [];
    const walk = (list, path) => {
        list.forEach((item, i) => {
            if (item === null) {
                nulls.push({ list, index: i, path: path.concat(i) });
            } else if (Array.isArray(item)) {
                walk(item, path.concat(i));
            } else if (item && Array.isArray(item.section)) {
                walk(item.section, path.concat(i, 'section'));
            }
        });
    };
    walk(parsed.attributes, []);
    if (!nulls.length) {
        return;
    }
    // the tag and the command name come first, so the arguments are the last NIL atoms of the line
    const spellings = nilSpellings(data).slice(-nulls.length);
    nulls.forEach((entry, i) => {
        if (select(entry.path)) {
            entry.list[entry.index] = { type: 'ATOM', value: spellings.length === nulls.length ? spellings[i] : 'NIL' };
        }
    });
}

module.exports = { isAtom, isAstring, restoreNilAtoms };
