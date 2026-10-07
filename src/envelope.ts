// This module converts message structure into an ENVELOPE object

import type { ParsedAddress } from './addressparser.js';
import type { ParsedHeader } from './mimeparser.js';

/** An address of the ENVELOPE (RFC 3501 section 9): name, source route, mailbox and host, all NIL for a group end */
export type EnvelopeAddress = [name: string | null, adl: null, mailbox: string | null, host: string | null];

/** The fields of the ENVELOPE (RFC 3501 section 7.4.2), in order */
export type Envelope = [
    date: string | null,
    subject: string | null,
    from: EnvelopeAddress[] | null,
    sender: EnvelopeAddress[] | null,
    replyTo: EnvelopeAddress[] | null,
    to: EnvelopeAddress[] | null,
    cc: EnvelopeAddress[] | null,
    bcc: EnvelopeAddress[] | null,
    inReplyTo: string | null,
    messageId: string | null
];

/**
 * Convert a message object to an ENVELOPE object
 *
 * @param {Object} header Parsed header of a mime tree node
 * @return {Object} ENVELOPE compatible object
 */
export default function envelope(header: ParsedHeader): Envelope {
    // RFC 3501 9: env-date and env-subject are nstring, NIL when the header is missing
    const subject = header.subject;
    return [
        header.date || null,
        typeof subject === 'string' ? subject : null,
        processAddress(header.from),
        processAddress(header.sender, header.from),
        processAddress(header['reply-to'], header.from),
        processAddress(header.to),
        processAddress(header.cc),
        processAddress(header.bcc),
        // If this is an embedded MESSAGE/RFC822, then Gmail seems to
        // have a bug here, it states '"NIL"' as the value, not 'NIL'
        header['in-reply-to'] || null,
        header['message-id'] || null
    ];
}

/**
 * Converts an address object to a list of arrays
 * [{name: "User Name", addres:"user@example.com"}] -> [["User Name", null, "user", "example.com"]]
 *
 * @param {Array} arr An array of address objects
 * @return {Array} A list of addresses
 */
function processAddress(arr: ParsedAddress | ParsedAddress[] | undefined, def?: ParsedAddress | ParsedAddress[]): EnvelopeAddress[] | null {
    let list = ([] as ParsedAddress[]).concat(arr || []);
    if (!list.length) {
        list = ([] as ParsedAddress[]).concat(def || []);
    }
    if (!list.length) {
        return null;
    }
    let result: EnvelopeAddress[] = [];
    list.forEach(addr => {
        if (addr.group) {
            // Handle group syntax
            result.push([null, null, addr.name || '', null]);
            result = result.concat(processAddress(addr.group) || []);
            result.push([null, null, null, null]);
            return;
        }

        let name = addr.name || null;
        let address = addr.address || '';

        if (!address && name) {
            // a bare word ("To: localuser") is the mailbox, not the name
            address = name;
            name = null;
        }

        if (!address) {
            return;
        }

        const at = address.lastIndexOf('@');
        const user = at >= 0 ? address.substr(0, at) : address;
        // RFC 3501 7.4.2 reserves a NIL host for group markers, so an address without a domain gets
        // the placeholder host that Dovecot uses for the same input
        const domain = (at >= 0 ? address.substr(at + 1) : '') || 'MISSING_DOMAIN';

        result.push([name, null, user || null, domain]);
    });

    // env-from = "(" 1*address ")", there is no SP between the addresses (RFC 3501 section 9)
    Object.defineProperty(result, 'adjacentLists', { value: true });
    return result.length ? result : null;
}

export { processAddress };
