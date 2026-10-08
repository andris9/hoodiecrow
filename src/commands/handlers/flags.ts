import type { IMAPServer } from '../../types.js';

// RFC 3501 9: flag-keyword = atom = 1*ATOM-CHAR, so a keyword can not contain atom-specials:
// "(" / ")" / "{" / SP / CTL / list-wildcards / quoted-specials / resp-specials. 8-bit octets are
// allowed, the parser accepts them in atoms as well
// eslint-disable-next-line no-control-regex
const INVALID_KEYWORD_CHAR = /[\x00-\x1f\x7f (){%*"\\\]]/;

/**
 * System flags are case-insensitive, so "\seen" becomes "\Seen"
 *
 * @param {String} flag Flag value
 * @return {String} Normalized flag
 */
function normalizeSystemFlag(flag: string) {
    if (flag.charAt(0) === '\\') {
        flag = flag.charAt(0) + flag.charAt(1).toUpperCase() + flag.substr(2).toLowerCase();
    }
    return flag;
}

/**
 * Throws if a flag can not be stored: an unknown system flag (including \Recent) or an invalid keyword
 *
 * @param {Object} server IMAP server, its systemFlags are the system flags that can be stored
 * @param {String} flag Normalized flag value
 */
function checkSystemFlags(server: IMAPServer, flag: string) {
    if (flag.charAt(0) === '\\') {
        if (server.systemFlags.indexOf(flag) < 0) {
            throw new Error('Invalid system flag ' + flag);
        }
    } else if (!flag || INVALID_KEYWORD_CHAR.test(flag)) {
        throw new Error('Invalid flag keyword ' + JSON.stringify(flag));
    }
}

export { INVALID_KEYWORD_CHAR, normalizeSystemFlag, checkSystemFlags };
