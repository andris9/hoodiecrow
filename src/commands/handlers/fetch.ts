import { getMessageData, resolveNode, embeddedMessage, headerSection, render } from '../../mimeparser.js';
import type { MimeNode } from '../../mimeparser.js';
import bodystructure from '../../bodystructure.js';
import envelope from '../../envelope.js';
import type { Attribute, FetchHandler, IMAPConnection, Message } from '../../types.js';

const fetchHandlers: Record<string, FetchHandler> = {};

export default fetchHandlers;
// not an IMAP item, so not enumerable among the handlers
Object.defineProperty(fetchHandlers, 'applyPartial', { value: applyPartial });

fetchHandlers.UID = function (connection: IMAPConnection, message: Message) {
    return message.uid;
};

fetchHandlers.FLAGS = function (connection: IMAPConnection, message: Message) {
    return connection.getFlags(message).map(flag => {
        return {
            type: 'ATOM',
            value: flag
        };
    });
};

fetchHandlers.BODYSTRUCTURE = function (connection: IMAPConnection, message: Message) {
    return bodystructure(getMessageData(message).tree, {
        upperCaseKeys: true,
        skipContentLocation: true,
        messageGlobal: connection.messageGlobal
    });
};

fetchHandlers.ENVELOPE = function (connection: IMAPConnection, message: Message) {
    return envelope(getMessageData(message).tree.parsedHeader);
};

fetchHandlers['BODY.PEEK'] = function (connection: IMAPConnection, message: Message, query: Attribute) {
    if (!query.section) {
        throw new Error('BODY.PEEK requires ans argument list');
    }
    return fetchHandlers.BODY(connection, message, query);
};

/**
 * Lists the header field names of a HEADER.FIELDS or HEADER.FIELDS.NOT section
 */
function getFieldNames(query: Attribute, key: string): string[] {
    if (query.section.length !== 2 || !Array.isArray(query.section[1]) || !query.section[1].length) {
        throw new Error(key + ' expects a list of header fields');
    }
    return query.section[1].map((queryKey: Attribute) => {
        if (['ATOM', 'STRING', 'LITERAL'].indexOf(queryKey.type) < 0) {
            throw new Error('Invalid header field name in list');
        }
        queryKey.type = 'ATOM'; // ensure that literals are not passed back in the response
        return queryKey.value.toUpperCase();
    });
}

/**
 * Returns the contents of a BODY[<section>]
 *
 * @param {Object} data Message data from getMessageData()
 * @param {Object} query Parsed fetch item
 * @param {Boolean} [global] message/global parts encapsulate a message, see IMAPConnection#messageGlobal
 * @return {String} Section contents
 */
function getSection(data: { raw: string; tree: MimeNode }, query: Attribute, global: boolean): string {
    if (!query.section.length) {
        return data.raw;
    }

    if (query.section[0].type !== 'ATOM') {
        throw new Error('Invalid BODY[<section>] identifier' + (query.section[0].value ? ' ' + query.section[0].type : ''));
    }

    // RFC 3501 9: section-part = nz-number *("." nz-number), optionally followed by a section-msgtext
    // (or MIME for a part)
    const match = (query.section[0].value || '')
        .toUpperCase()
        .match(/^((?:[1-9]\d*)(?:\.[1-9]\d*)*)?(?:(?:^|\.)(HEADER|HEADER\.FIELDS|HEADER\.FIELDS\.NOT|TEXT|MIME))?$/);
    if (!match || (match[2] === 'MIME' && !match[1])) {
        throw new Error('Invalid BODY[<section>] identifier ' + query.section[0].value);
    }

    const path = match[1] || '';
    const key = match[2] || '';
    let fields: string[] = [];

    if (['HEADER.FIELDS', 'HEADER.FIELDS.NOT'].indexOf(key) >= 0) {
        fields = getFieldNames(query, key);
    } else if (query.section.length > 1) {
        throw new Error((key || 'Part number') + ' does not take any arguments');
    }

    // RFC 3501 6.4.5: a part that does not exist is returned as an empty string
    const node = path ? resolveNode(data.tree, path, global) : data.tree;
    if (!node) {
        return '';
    }

    // HEADER and TEXT with a part number refer to the encapsulated message of a message/rfc822 part
    // (and message/global in IMAP4rev2, RFC 9051 section 6.4.5.1), not to the part itself
    const message = path ? embeddedMessage(node, global) : node;

    switch (key) {
        case '':
            // BODY[1.2.3] is a part without its MIME header
            return render(node, true);

        case 'MIME':
            return headerSection(node);

        case 'TEXT':
            return message ? render(message, true) : '';

        case 'HEADER':
            return message ? headerSection(message) : '';

        default: {
            // HEADER.FIELDS and HEADER.FIELDS.NOT
            if (!message) {
                return '';
            }
            const wanted = key === 'HEADER.FIELDS';
            let value = '';
            (message.header || []).forEach((line: string) => {
                const name = line.split(':')[0].toUpperCase().trim();
                if (fields.indexOf(name) >= 0 === wanted) {
                    value += line + '\r\n';
                }
            });
            return value + '\r\n';
        }
    }
}

/**
 * Applies the partial range of a BODY[]<start.length> or BINARY[]<start.length> item
 *
 * @param {String} value Section contents
 * @param {Array} [partial] Parsed partial range
 * @return {String} The requested slice, or the whole value without a range
 */
function applyPartial(value: string, partial: number[] | null | undefined): string {
    if (!partial) {
        return value;
    }
    // RFC 3501 9: partial = "<" number "." nz-number ">"
    if (partial.length !== 2 || !(partial[1] > 0)) {
        throw new Error('Invalid partial range, expecting <start.length>');
    }
    return value.substr(partial[0], partial[1]);
}

fetchHandlers.BODY = function (connection: IMAPConnection, message: Message, query: Attribute) {
    const data = getMessageData(message);

    if (!query.section) {
        if (query.partial) {
            throw new Error('BODY without a section does not take a partial range');
        }
        return bodystructure(data.tree, {
            body: true,
            upperCaseKeys: true,
            messageGlobal: connection.messageGlobal
        });
    }

    return {
        type: 'LITERAL',
        value: applyPartial(getSection(data, query, connection.messageGlobal), query.partial)
    };
};

fetchHandlers.INTERNALDATE = function (connection: IMAPConnection, message: Message) {
    return message.internaldate;
};

fetchHandlers.RFC822 = function (connection: IMAPConnection, message: Message) {
    return {
        type: 'LITERAL',
        value: getMessageData(message).raw
    };
};

// RFC 3501 6.4.5: RFC822 and RFC822.TEXT set \Seen, RFC822.HEADER is BODY.PEEK[HEADER] and does not
fetchHandlers.RFC822.setsSeen = true;

fetchHandlers['RFC822.SIZE'] = function (connection: IMAPConnection, message: Message) {
    return getMessageData(message).raw.length;
};

fetchHandlers['RFC822.HEADER'] = function (connection: IMAPConnection, message: Message) {
    return {
        type: 'LITERAL',
        value: headerSection(getMessageData(message).tree)
    };
};

fetchHandlers['RFC822.TEXT'] = function (connection: IMAPConnection, message: Message) {
    return {
        type: 'LITERAL',
        value: render(getMessageData(message).tree, true)
    };
};
fetchHandlers['RFC822.TEXT'].setsSeen = true;

export { applyPartial };
