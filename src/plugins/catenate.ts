import imapHandler from 'imap-handler';
import { appendError, badArgument } from '../commands/append.js';
import fetchHandlers from '../commands/handlers/fetch.js';
import { getMessageData, resolveNode } from '../mimeparser.js';
import { encodeMailboxName } from '../mailbox-name.js';
import { isNumber, isNzNumber } from '../numbers.js';
import type { Attribute, IMAPConnection, IMAPServer, Message } from '../types.js';

/**
 * @help Adds CATENATE [RFC4469] and URL-PARTIAL [RFC5550] capabilities
 * @help Only absolute-path URLs are accepted, eg. "/INBOX/;UID=1/;SECTION=1"
 *
 * CATENATE: https://www.rfc-editor.org/rfc/rfc4469
 *
 * APPEND (and REPLACE) can build a message from literals and IMAP URLs of messages or
 * message parts on this server. Only absolute-path URLs are accepted, for example
 * "/INBOX;UIDVALIDITY=1/;UID=2/;SECTION=1.MIME/;PARTIAL=0.100" (RFC 5092). Other URLs,
 * and URLs that do not resolve, fail with NO [BADURL]. A message larger than the
 * literal size limit fails with NO [TOOBIG].
 */
export default function catenatePlugin(server: IMAPServer) {
    server.registerCapability('CATENATE');
    // RFC 5550 section 5.7.1: ;PARTIAL= is supported in the URLs of CATENATE
    server.registerCapability('URL-PARTIAL');

    // RFC 4469 section 5: append-data =/ "CATENATE" SP "(" cat-part *(SP cat-part) ")"
    // cat-part = text-literal / url, text-literal = "TEXT" SP literal, url = "URL" SP astring
    server.appendDataHandlers.CATENATE = (connection: IMAPConnection, list: any[]) => {
        if (!Array.isArray(list) || !list.length || list.length % 2) {
            throw badArgument('CATENATE expects a list of TEXT literals and URLs');
        }

        const parts: ({ text: string } | { url: string })[] = [];
        for (let i = 0; i < list.length; i += 2) {
            const label = list[i] && list[i].type === 'ATOM' ? String(list[i].value).toUpperCase() : '';
            const value = list[i + 1];
            if (label === 'TEXT' && value && value.type === 'LITERAL') {
                parts.push({ text: value.value });
            } else if (label === 'URL' && value && ['ATOM', 'STRING', 'LITERAL'].indexOf(value.type) >= 0) {
                parts.push({ url: value.value });
            } else {
                throw badArgument('Invalid CATENATE part ' + (i / 2 + 1));
            }
        }

        // the message is built once the target mailbox is known to exist
        return () => {
            const maxSize = connection.getMaxLiteralSize();
            let raw = '';
            for (const part of parts) {
                raw += 'text' in part ? part.text : resolveUrl(connection, part.url);
                // RFC 4469 section 4.2: TOOBIG for a message over the server's size limit
                if (raw.length > maxSize) {
                    throw appendError('Catenated message is too large', 'TOOBIG');
                }
            }
            return raw;
        };
    };
}

// RFC 5092 section 11: bchar (achar / ":" / "@" / "/"), and ";" that starts the URL parameters
const URL_CHARS = /^[A-Za-z0-9\-._~!$'()*+,&=:@/;%]*$/;

// RFC 5092 section 11: iabsolute-path = "/" imessagepart, where
// imessagepart = enc-mailbox [uidvalidity] iuid [isection] [ipartial] (URLAUTH is not supported)
const MESSAGE_PART = /^\/([^;]+?)(?:;UIDVALIDITY=([^/;]*))?\/;UID=([^/;]*)(?:\/;SECTION=([^/;]*))?(?:\/;PARTIAL=([^/;]*))?$/i;

/**
 * Creates a BADURL error (RFC 4469 section 4.1). url-resp-text is any TEXT-CHAR except "]", so other
 * octets of an invalid URL are percent-encoded
 *
 * @param {String} url URL as the client sent it
 * @param {String} text Human readable text
 * @return {Error} Error object
 */
function badUrl(url: string, text: string) {
    if (!url) {
        // url-resp-text can not be empty
        return appendError(text);
    }
    const value = url.replace(/[^\x20-\x5c\x5e-\x7e]/g, chr => '%' + chr.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
    return appendError(text, 'BADURL', [{ type: 'TEXT', value }]);
}

/**
 * Removes "." and ".." segments from a path (RFC 3986 section 5.2.4), as relative IMAP URLs are
 * resolved by the generic URI rules (RFC 5092 section 7)
 *
 * @param {String} path Path that starts with "/"
 * @return {String} Path without dot segments
 */
function removeDotSegments(path: string) {
    const segments = path.split('/').slice(1);
    const output: string[] = [];
    segments.forEach((segment, i: number) => {
        const last = i === segments.length - 1;
        if (segment === '.' || segment === '..') {
            if (segment === '..') {
                output.pop();
            }
            if (last) {
                output.push('');
            }
            return;
        }
        output.push(segment);
    });
    return '/' + output.join('/');
}

/**
 * Decodes percent-encoded octets
 *
 * @param {String} value Percent-encoded string
 * @return {String} Binary string
 */
function percentDecode(value: string): string {
    return value.replace(/%([0-9a-f]{2})/gi, (match: string, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Returns the octets of a message part as BODY.PEEK[<section>] would, or false if the section is
 * invalid or the part does not exist
 *
 * @param {Object} connection IMAPConnection
 * @param {Object} message Message object
 * @param {String} section Decoded section-spec
 * @return {String|Boolean} Section contents
 */
function getSection(connection: IMAPConnection, message: Message, section: string): string | false {
    if (!section || !/^[\x20-\x7e]+$/.test(section)) {
        return false;
    }

    // reuse the FETCH grammar for section-spec
    let query: Attribute;
    try {
        const parsed: Attribute = imapHandler.parser('X FETCH 1 BODY.PEEK[' + section + ']');
        query = parsed.attributes.length === 2 && !parsed.attributes[1].partial && parsed.attributes[1];
    } catch {
        return false;
    }
    if (!query || !query.section || !query.section.length || query.section[0].type !== 'ATOM') {
        return false;
    }

    // FETCH returns an empty string for a part that does not exist, a URL for it is invalid (RFC 4469 section 4.1)
    const sectionId = String(query.section[0].value).toUpperCase();
    const path = (sectionId.match(/^[1-9]\d*(?:\.[1-9]\d*)*/) || [''])[0];
    if (path) {
        const node = resolveNode(getMessageData(message).tree, path);
        const key = sectionId.substr(path.length + 1);
        // HEADER and TEXT with a part number refer to the message in a message/rfc822 part
        if (!node || (key && key !== 'MIME' && !node.message)) {
            return false;
        }
    }

    try {
        return fetchHandlers.BODY(connection, message, { section: query.section }).value;
    } catch {
        return false;
    }
}

/**
 * Returns the octets an IMAP URL refers to. RFC 4469 section 3: only URLs of messages or message
 * parts in the current session are supported, relative to "imap://user@server/". RFC 5092 section 7.2
 * forbids relative-path references, so only absolute-path references ("/" imessagepart) are accepted
 *
 * @param {Object} connection IMAPConnection
 * @param {String} url IMAP URL
 * @return {String} Binary string
 */
function resolveUrl(connection: IMAPConnection, url: string) {
    if (!url) {
        throw badUrl(url, 'Empty URL does not refer to a message');
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.substr(0, 2) === '//') {
        throw badUrl(url, 'Only absolute-path URLs of this server are supported, e.g. /INBOX/;UID=1');
    }
    if (url.charAt(0) !== '/') {
        throw badUrl(url, 'Relative-path URLs are not allowed (RFC 5092 section 7.2)');
    }
    if (!URL_CHARS.test(url) || /%(?![0-9a-f]{2})/i.test(url)) {
        throw badUrl(url, 'Invalid characters in URL');
    }

    const match = removeDotSegments(url).match(MESSAGE_PART);
    if (!match) {
        throw badUrl(url, 'URL does not refer to a message or a message part');
    }
    const [, encMailbox, uidvalidity, uid, encSection, partial] = match;

    // RFC 5092 section 11: uidvalidity and iuid-only are nz-number values (32-bit, RFC 3501 section 9)
    if ((uidvalidity !== undefined && !isNzNumber(uidvalidity)) || !isNzNumber(uid)) {
        throw badUrl(url, 'Invalid UIDVALIDITY or UID in URL');
    }

    // RFC 5092 section 8: mailbox names are percent-encoded UTF-8
    let name: string;
    try {
        name = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(percentDecode(encMailbox), 'binary'));
    } catch {
        throw badUrl(url, 'Mailbox name in URL is not valid UTF-8');
    }

    const mailbox = connection.server.getMailbox(encodeMailboxName(name));
    if (!mailbox || mailbox.flags.indexOf('\\Noselect') >= 0) {
        throw badUrl(url, 'Mailbox does not exist');
    }

    // plugins can refuse to read the mailbox, e.g. ACL without the "r" right
    for (const check of connection.server.urlAccessChecks) {
        const refusal = check(connection, mailbox, url);
        if (refusal) {
            throw badUrl(url, refusal.text || 'Permission denied');
        }
    }

    // RFC 5092 section 5: a stale URL behaves as if the mailbox does not exist
    if (uidvalidity !== undefined && Number(uidvalidity) !== mailbox.uidvalidity) {
        throw badUrl(url, 'UIDVALIDITY does not match');
    }

    const message = mailbox.messages.find((item: Message) => item.uid === Number(uid));
    if (!message) {
        throw badUrl(url, 'Message does not exist');
    }

    // RFC 5092 section 6: no section is the whole message, BODY.PEEK[], so \Seen is not set
    let value: string | false = message.raw;
    if (encSection !== undefined) {
        value = getSection(connection, message, percentDecode(encSection));
        if (value === false) {
            throw badUrl(url, 'Invalid section or the message part does not exist');
        }
    }

    if (partial !== undefined) {
        // RFC 5092 section 11: partial-range = number ["." nz-number], offset and length in octets, both 32-bit
        // (RFC 3501 section 9)
        const range = partial.match(/^(\d+)(?:\.(\d+))?$/);
        if (!range || !isNumber(range[1]) || (range[2] !== undefined && !isNzNumber(range[2]))) {
            throw badUrl(url, 'Invalid partial range');
        }
        value = value.substr(Number(range[1]), range[2] ? Number(range[2]) : undefined);
    }

    return value;
}
