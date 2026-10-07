import { getMessageData, partsOf } from '../mimeparser.js';
import type { MimeNode } from '../mimeparser.js';
import { isAtom } from '../arguments.js';
import type { Attribute, Callback, CommandHandler, IMAPConnection, IMAPError, IMAPServer, Message, ParsedCommand } from '../types.js';

/**
 * @help Adds PREVIEW [RFC8970] capability
 * @help Previews come from the first text/plain or text/html body part,
 * @help or from the "preview" property of a message in storage.
 * @help PREVIEW (LAZY) returns NIL until a preview has been generated
 *
 * PREVIEW: https://www.rfc-editor.org/rfc/rfc8970
 *
 * Message storage property:
 * - preview: preview text to return instead of a generated one
 */
export default function previewPlugin(server: IMAPServer) {
    server.registerCapability('PREVIEW');

    // Generated previews, so PREVIEW (LAZY) knows which ones are available without "undue delay"
    const generated = new WeakMap();

    // The preview that is available without generating it: the storage value or an earlier generated one
    const readyPreview = (message: Message) => {
        if (typeof message.preview === 'string') {
            // RFC 8970 3.3: the MUST NOT limits apply to the value from storage as well
            return finishPreview(message.preview, MAX_PREVIEW_LENGTH);
        }
        const cached = generated.get(message);
        return cached && cached.source === message.raw ? cached.preview : undefined;
    };

    server.fetchHandlers.PREVIEW = function (connection: IMAPConnection, message: Message, query: any) {
        let preview = readyPreview(message);
        if (preview === undefined) {
            // RFC 8970 4.1: with LAZY the server returns NIL when the preview is not readily available. Here that
            // means a preview that has not been generated yet by a FETCH without LAZY (Dovecot behaves the same way)
            if (query.previewLazy) {
                return null;
            }
            preview = generatePreview(getMessageData(message).tree);
            generated.set(message, { source: message.raw, preview });
        }
        // RFC 8970 3.3: UTF-8, sent as a literal by the compiler when it holds 8-bit characters
        return Buffer.from(preview, 'utf8').toString('binary');
    };

    // RFC 8970 6: fetch-att =/ "PREVIEW" [SP "(" preview-mod *(SP preview-mod) ")"]. The parser returns the
    // modifiers as a list that follows the PREVIEW atom, so fold them into the atom before FETCH sees them
    ['FETCH', 'UID FETCH'].forEach(command => {
        const prevHandler = server.getCommandHandler(command) as CommandHandler;
        server.setCommandHandler(command, (connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
            try {
                foldModifiers(parsed);
            } catch (E) {
                connection.sendStatus(parsed, data, 'BAD', (E as IMAPError).message, false, 'PREVIEW FAILED');
                return callback();
            }
            prevHandler(connection, parsed, data, callback);
        });
    });
}

// RFC 8970 3.3: the server SHOULD limit previews to 200 characters and MUST NOT exceed 256
const PREVIEW_LENGTH = 200;
const MAX_PREVIEW_LENGTH = 256;

// Input of preview generation is limited to the start of the part, enough for a 200 character preview
const MAX_INPUT = 64 * 1024;

const isModifierList = (list: any[]) => Array.isArray(list) && list.length > 0 && list.every(item => isAtom(item, 'LAZY'));

/**
 * Returns the PREVIEW item with its modifiers. RFC 8970 6: preview-mod = "LAZY", at least one is required
 *
 * @param {Object} item PREVIEW atom
 * @param {Array} list Parsed list that follows PREVIEW
 * @return {Object} PREVIEW atom with the previewLazy flag
 */
function withModifiers(item: Attribute, list: any[]) {
    if (!list.length) {
        throw new Error('PREVIEW modifier list can not be empty');
    }
    if (!isModifierList(list)) {
        throw new Error('Unknown PREVIEW modifier');
    }
    return Object.assign({}, item, { previewLazy: true });
}

/**
 * Turns `PREVIEW (LAZY)` in the FETCH arguments into a single PREVIEW item with the previewLazy flag
 *
 * @param {Object} parsed Parsed command
 */
function foldModifiers(parsed: ParsedCommand) {
    const attributes = parsed.attributes;
    if (!Array.isArray(attributes)) {
        return;
    }

    const items = attributes[1];
    if (Array.isArray(items)) {
        // inside the item list every list that follows PREVIEW is a modifier list
        for (let i = items.length - 2; i >= 0; i--) {
            if (isAtom(items[i], 'PREVIEW') && Array.isArray(items[i + 1])) {
                items[i] = withModifiers(items[i], items[i + 1]);
                items.splice(i + 1, 1);
            }
        }
        return;
    }

    // A single PREVIEW item may be followed by both its modifiers and the FETCH modifiers of other extensions
    // (RFC 7162 CHANGEDSINCE), so "FETCH 1 PREVIEW (X)" is a preview modifier only if it looks like one or if
    // another list follows
    if (isAtom(items, 'PREVIEW') && Array.isArray(attributes[2]) && (attributes.length > 3 || isModifierList(attributes[2]))) {
        attributes[1] = withModifiers(items, attributes[2]);
        attributes.splice(2, 1);
    }
}

/**
 * Generates the preview text of a message (RFC 8970 3.3) from the first text/plain or text/html part
 *
 * @param {Object} tree Root node of the MIME tree
 * @return {String} Preview, an empty string if there is no text to show
 */
function generatePreview(tree: MimeNode) {
    const part = findTextPart(tree);
    if (!part) {
        // RFC 8970 3.2: the server MUST return an empty string when there is no meaningful preview
        return '';
    }

    const text = decodeBody(part);
    if (text === false) {
        return '';
    }

    return finishPreview(part.parsedHeader['content-type'].subtype === 'html' ? htmlToText(text) : plainToText(text), PREVIEW_LENGTH);
}

/**
 * Finds the part to build the preview from. Attachments, attached messages and encrypted content are skipped.
 * In a multipart/alternative a text/plain part is preferred over text/html
 *
 * @param {Object} node Tree node
 * @return {Object|Boolean} Part node or false
 */
function findTextPart(node: MimeNode): MimeNode | false {
    // the parser fills in the RFC 2045 5.2 and RFC 2046 5.1.5 default content types
    const { type, subtype } = node.parsedHeader['content-type'];
    const disposition = node.parsedHeader['content-disposition'];

    if (disposition && disposition.type === 'attachment') {
        return false;
    }

    if (type === 'multipart') {
        if (subtype === 'encrypted') {
            return false;
        }
        const parts = partsOf(node) || [];
        if (subtype === 'alternative') {
            const candidates = parts.map(findTextPart).filter((part): part is MimeNode => !!part);
            return candidates.find(part => part.parsedHeader['content-type'].subtype === 'plain') || candidates[0] || false;
        }
        for (const part of parts) {
            const found = findTextPart(part);
            if (found) {
                return found;
            }
        }
        return false;
    }

    return type === 'text' && (subtype === 'plain' || subtype === 'html') ? node : false;
}

/**
 * Decodes the content transfer encoding and the charset of the start of a part
 *
 * @param {Object} node Part node
 * @return {String|Boolean} Unicode text, or false for an unknown transfer encoding
 */
function decodeBody(node: MimeNode) {
    const encoding = String(node.parsedHeader['content-transfer-encoding'] || '7bit').toLowerCase();
    const body = node.body;
    let octets;

    switch (encoding) {
        case '7bit':
        case '8bit':
        case 'binary':
            octets = Buffer.from(body.slice(0, MAX_INPUT), 'binary');
            break;
        case 'base64':
            // Buffer skips characters outside the base64 alphabet, the cut keeps whole 4 character groups
            octets = Buffer.from(body.slice(0, (MAX_INPUT * 4) / 3), 'base64');
            break;
        case 'quoted-printable':
            octets = decodeQuotedPrintable(body.slice(0, MAX_INPUT));
            break;
        default:
            return false;
    }

    const charset = String(node.parsedHeader['content-type'].params.charset || '')
        .trim()
        .toLowerCase();

    // Like Dovecot, a missing, US-ASCII or unsupported charset is decoded as UTF-8, invalid octets become U+FFFD
    let decoder;
    if (charset && !['us-ascii', 'ascii'].includes(charset)) {
        try {
            decoder = new TextDecoder(charset);
        } catch {
            // unknown charset label
        }
    }
    return (decoder || new TextDecoder('utf-8')).decode(octets);
}

/**
 * Decodes quoted-printable content (RFC 2045 6.7). Malformed escapes are kept as they are
 *
 * @param {String} body Binary string
 * @return {Buffer} Decoded octets
 */
function decodeQuotedPrintable(body: string) {
    // trailing whitespace of encoded lines is padding (RFC 2045 6.7 rule 3). Trimmed with a loop, a regex would
    // backtrack over long runs of whitespace. Line breaks are CRLF after getMessageData()
    const decoded = body
        .split('\r\n')
        .map((line: string) => {
            let end = line.length;
            while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) {
                end--;
            }
            return line.slice(0, end);
        })
        .join('\r\n')
        .replace(/=\r\n/g, '')
        .replace(/=([0-9A-Fa-f]{2})/g, (match: string, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    return Buffer.from(decoded, 'binary');
}

/**
 * Plain text without quoted lines. Like Dovecot, lines that start with ">" are left out unless nothing else is left
 *
 * @param {String} text Decoded text
 * @return {String} Text
 */
function plainToText(text: string) {
    const unquoted = text
        .split(/\r?\n/)
        .filter(line => !/^>/.test(line))
        .join('\n');
    return unquoted.trim() ? unquoted : text;
}

// Inline elements are removed without a trace, every other tag separates words like a space
const INLINE_ELEMENTS = new Set([
    'a',
    'abbr',
    'b',
    'bdi',
    'bdo',
    'big',
    'cite',
    'code',
    'del',
    'dfn',
    'em',
    'font',
    'i',
    'ins',
    'kbd',
    'mark',
    'q',
    's',
    'samp',
    'small',
    'span',
    'strike',
    'strong',
    'sub',
    'sup',
    'time',
    'tt',
    'u',
    'var',
    'wbr'
]);

// HTML 4 character entity references for U+00A0 to U+00FF, in code point order
const LATIN1_ENTITIES =
    'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para ' +
    'middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute ' +
    'Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute ' +
    'THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ' +
    'ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml';

const NAMED_ENTITIES = Object.assign(Object.fromEntries(LATIN1_ENTITIES.split(' ').map((name, i) => [name, String.fromCharCode(0xa0 + i)])), {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    trade: '\u2122',
    hellip: '\u2026',
    mdash: '\u2014',
    ndash: '\u2013',
    lsquo: '\u2018',
    rsquo: '\u2019',
    ldquo: '\u201c',
    rdquo: '\u201d',
    bull: '\u2022',
    euro: '\u20ac',
    zwnj: '\u200c',
    zwj: '\u200d'
});

/**
 * Converts HTML into plain text: markup, comments and non-rendered elements (head, script, style) are removed,
 * character references are decoded. Like quoted lines of plain text, blockquote elements are left out unless
 * nothing else is left
 *
 * @param {String} html Decoded HTML
 * @return {String} Text
 */
function htmlToText(html: string) {
    html = html.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ').replace(/<(head|script|style|title|template)\b[^<>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ');

    const text = markupToText(removeBlockquotes(html));
    return text.trim() ? text : markupToText(html);
}

/**
 * Removes blockquote elements, nested ones included, in a single pass
 *
 * @param {String} html HTML
 * @return {String} HTML without blockquotes
 */
function removeBlockquotes(html: string) {
    const re = /<(\/?)blockquote\b[^<>]*>?/gi;
    let output = '';
    let depth = 0;
    let pos = 0;
    let match;
    while ((match = re.exec(html))) {
        if (!depth) {
            output += html.slice(pos, match.index) + ' ';
        }
        depth = match[1] ? Math.max(depth - 1, 0) : depth + 1;
        pos = re.lastIndex;
    }
    return depth ? output : output + html.slice(pos);
}

/**
 * Removes tags and decodes character references
 *
 * @param {String} html HTML without comments and non-rendered elements
 * @return {String} Text
 */
function markupToText(html: string) {
    return html
        .replace(/<!\[CDATA\[([\s\S]*?)(?:\]\]>|$)/g, '$1')
        .replace(/<\/?([A-Za-z][A-Za-z0-9-]*)(?![A-Za-z0-9-])[^<>]*>|<[!?][^<>]*>/g, (match: string, name: string) =>
            name && INLINE_ELEMENTS.has(name.toLowerCase()) ? '' : ' '
        )
        .replace(/&(#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/g, (match: string, ref: string) => {
            if (ref[0] === '#') {
                const code = /^#x/i.test(ref) ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
                // NUL, surrogates and values outside Unicode are not characters
                return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : '\ufffd';
            }
            return Object.hasOwn(NAMED_ENTITIES, ref) ? NAMED_ENTITIES[ref] : match;
        });
}

/**
 * Normalizes preview text: control characters are removed, whitespace runs become a single space (so there are no
 * CR or LF characters) and the text is cut to at most `length` characters (code points, RFC 8970 3.3)
 *
 * @param {String} text Text
 * @param {Number} length Maximum number of characters
 * @return {String} Preview
 */
function finishPreview(text: string, length: number) {
    const normalized = text
        .replace(/[^\P{Cc}\t\n\v\f\r]|\u00ad/gu, '')
        .replace(/[\s\u200b]+/g, ' ')
        .trim();
    return Array.from(normalized).slice(0, length).join('').trimEnd();
}

export { generatePreview, finishPreview };
