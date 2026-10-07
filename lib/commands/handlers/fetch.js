'use strict';

const fetchHandlers = {};
const mimeParser = require('../../mimeparser');
const bodystructure = require('../../bodystructure');
const envelope = require('../../envelope');

const { getMessageData, resolveNode, headerSection, render } = mimeParser;

module.exports = fetchHandlers;

fetchHandlers.UID = function (connection, message) {
    return message.uid;
};

fetchHandlers.FLAGS = function (connection, message) {
    return connection.getFlags(message).map(flag => {
        return {
            type: 'ATOM',
            value: flag
        };
    });
};

fetchHandlers.BODYSTRUCTURE = function (connection, message) {
    return bodystructure(getMessageData(message).tree, {
        upperCaseKeys: true,
        skipContentLocation: true
    });
};

fetchHandlers.ENVELOPE = function (connection, message) {
    return envelope(getMessageData(message).tree.parsedHeader);
};

fetchHandlers['BODY.PEEK'] = function (connection, message, query) {
    if (!query.section) {
        throw new Error('BODY.PEEK requires ans argument list');
    }
    return fetchHandlers.BODY(connection, message, query);
};

/**
 * Lists the header field names of a HEADER.FIELDS or HEADER.FIELDS.NOT section
 */
function getFieldNames(query, key) {
    if (query.section.length !== 2 || !Array.isArray(query.section[1]) || !query.section[1].length) {
        throw new Error(key + ' expects a list of header fields');
    }
    return query.section[1].map(queryKey => {
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
 * @return {String} Section contents
 */
function getSection(data, query) {
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
    let fields;

    if (['HEADER.FIELDS', 'HEADER.FIELDS.NOT'].indexOf(key) >= 0) {
        fields = getFieldNames(query, key);
    } else if (query.section.length > 1) {
        throw new Error((key || 'Part number') + ' does not take any arguments');
    }

    // RFC 3501 6.4.5: a part that does not exist is returned as an empty string
    const node = path ? resolveNode(data.tree, path) : data.tree;
    if (!node) {
        return '';
    }

    // HEADER and TEXT with a part number refer to the encapsulated message of a message/rfc822 part,
    // not to the part itself
    const message = path ? node.message : node;

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
            (message.header || []).forEach(line => {
                const name = line.split(':').shift().toUpperCase().trim();
                if (fields.indexOf(name) >= 0 === wanted) {
                    value += line + '\r\n';
                }
            });
            return value + '\r\n';
        }
    }
}

fetchHandlers.BODY = function (connection, message, query) {
    const data = getMessageData(message);

    if (!query.section) {
        if (query.partial) {
            throw new Error('BODY without a section does not take a partial range');
        }
        return bodystructure(data.tree, {
            body: true,
            upperCaseKeys: true
        });
    }

    let value = getSection(data, query);

    if (query.partial) {
        // RFC 3501 9: partial = "<" number "." nz-number ">"
        if (query.partial.length !== 2 || !(query.partial[1] > 0)) {
            throw new Error('Invalid partial range, expecting <start.length>');
        }
        const start = query.partial[0];
        const length = query.partial[1];
        value = value.substr(start, length);
    }

    return {
        type: 'LITERAL',
        value: value
    };
};

fetchHandlers.INTERNALDATE = function (connection, message) {
    return message.internaldate;
};

fetchHandlers.RFC822 = function (connection, message) {
    return {
        type: 'LITERAL',
        value: getMessageData(message).raw
    };
};

fetchHandlers['RFC822.SIZE'] = function (connection, message) {
    return getMessageData(message).raw.length;
};

fetchHandlers['RFC822.HEADER'] = function (connection, message) {
    return {
        type: 'LITERAL',
        value: headerSection(getMessageData(message).tree)
    };
};

fetchHandlers['RFC822.TEXT'] = function (connection, message) {
    return {
        type: 'LITERAL',
        value: render(getMessageData(message).tree, true)
    };
};
