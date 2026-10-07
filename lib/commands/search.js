'use strict';

const makeSearch = require('./handlers/search');

/**
 * Shared implementation of SEARCH and UID SEARCH
 *
 * @param {Boolean} isUid If true, the response lists UIDs instead of sequence numbers
 */
function processSearch(isUid, connection, parsed, data, callback) {
    const command = isUid ? 'UID SEARCH' : 'SEARCH';

    if (connection.state !== 'Selected') {
        connection.send(
            {
                tag: parsed.tag,
                command: 'BAD',
                attributes: [
                    {
                        type: 'TEXT',
                        value: 'Select mailbox first'
                    }
                ]
            },
            command + ' FAILED',
            parsed,
            data
        );
        return callback();
    }

    if (!parsed.attributes || !parsed.attributes.length) {
        connection.send(
            {
                tag: parsed.tag,
                command: 'BAD',
                attributes: [
                    {
                        type: 'TEXT',
                        value: command + ' expects search criteria, empty query given'
                    }
                ]
            },
            command + ' FAILED',
            parsed,
            data
        );
        return callback();
    }

    let params;

    try {
        // parenthesized lists stay nested
        const convert = (argument, i) => {
            if (Array.isArray(argument)) {
                return argument.map(convert);
            }
            if (!argument || ['STRING', 'ATOM', 'LITERAL', 'SEQUENCE'].indexOf(argument.type) < 0) {
                throw new Error('Invalid search criteria argument #' + (i + 1));
            }
            return argument.value;
        };
        params = parsed.attributes.map(convert);
    } catch (E) {
        connection.send(
            {
                tag: parsed.tag,
                command: 'BAD',
                attributes: [
                    {
                        type: 'TEXT',
                        value: E.message
                    }
                ]
            },
            command + ' FAILED',
            parsed,
            data
        );
        return callback();
    }

    let messages = connection.selectedMailbox.messages;
    let searchResult;

    for (let i = 0, len = connection.notificationQueue.length; i < len; i++) {
        if (connection.notificationQueue[i].mailboxCopy) {
            messages = connection.notificationQueue[i].mailboxCopy;
            break;
        }
    }

    try {
        searchResult = makeSearch(connection, messages, params);
    } catch (E) {
        const attributes = [];
        if (E.code === 'BADCHARSET') {
            attributes.push({
                type: 'SECTION',
                section: [
                    {
                        type: 'ATOM',
                        value: 'BADCHARSET'
                    },
                    E.charsets.map(charset => ({
                        type: 'ATOM',
                        value: charset
                    }))
                ]
            });
        }
        attributes.push({
            type: 'TEXT',
            value: E.message
        });
        connection.send(
            {
                tag: parsed.tag,
                command: E.imapResponse === 'BAD' ? 'BAD' : 'NO',
                attributes
            },
            command + ' FAILED',
            parsed,
            data
        );
        return callback();
    }

    // RFC 3501 7.2.5: the SEARCH response is sent even when nothing matched
    connection.send(
        {
            tag: '*',
            command: 'SEARCH',
            attributes: searchResult.list.map(item => {
                return isUid ? item.uid : searchResult.numbers[item.uid];
            })
        },
        command,
        parsed,
        data
    );

    connection.send(
        {
            tag: parsed.tag,
            command: 'OK',
            attributes: [
                {
                    type: 'TEXT',
                    value: command + ' completed'
                }
            ]
        },
        command,
        parsed,
        data
    );
    return callback();
}

module.exports = (connection, parsed, data, callback) => processSearch(false, connection, parsed, data, callback);
module.exports.processSearch = processSearch;
