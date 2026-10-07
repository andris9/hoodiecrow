'use strict';

const fetchHandlers = require('./handlers/fetch');

const macros = {
    ALL: ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE'],
    FAST: ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE'],
    FULL: ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE', 'BODY']
};

/**
 * Shared implementation of FETCH and UID FETCH
 *
 * @param {Boolean} isUid If true, the sequence set lists UIDs and UID is always included in the response
 */
function processFetch(isUid, connection, parsed, data, callback) {
    const command = isUid ? 'UID FETCH' : 'FETCH';

    if (
        !parsed.attributes ||
        parsed.attributes.length !== 2 ||
        !parsed.attributes[0] ||
        ['ATOM', 'SEQUENCE'].indexOf(parsed.attributes[0].type) < 0 ||
        !parsed.attributes[1] ||
        (['ATOM'].indexOf(parsed.attributes[1].type) < 0 && !Array.isArray(parsed.attributes[1]))
    ) {
        connection.send(
            {
                tag: parsed.tag,
                command: 'BAD',
                attributes: [
                    {
                        type: 'TEXT',
                        value: command + ' expects sequence set and message item names'
                    }
                ]
            },
            'INVALID COMMAND',
            parsed,
            data
        );
        return callback();
    }

    const range = connection.getMessageRange(parsed.attributes[0].value, isUid);
    let params = [].concat(parsed.attributes[1] || []);

    if (parsed.attributes[1].type === 'ATOM' && Object.prototype.hasOwnProperty.call(macros, parsed.attributes[1].value.toUpperCase())) {
        params = macros[parsed.attributes[1].value.toUpperCase()].slice();
    }

    // messages that get \Seen set by this FETCH
    const seen = [];
    // untagged FETCH responses
    const responses = [];

    try {
        let uidExist = false;
        let flagsExist = false;
        let forceSeen = false;

        params.forEach((param, i) => {
            if (!param || (typeof param !== 'string' && param.type !== 'ATOM')) {
                throw new Error('Invalid FETCH argument #' + (i + 1));
            }

            if (typeof param === 'string') {
                param = params[i] = {
                    type: 'ATOM',
                    value: param
                };
            }

            const key = param.value.toUpperCase();

            if (key === 'FLAGS') {
                flagsExist = true;
            }

            if (key === 'UID') {
                uidExist = true;
            }

            // RFC 3501 6.4.5: BODY[<section>] and items whose handler is marked with setsSeen set \Seen
            const handler = connection.server.fetchHandlers[key] || fetchHandlers[key];
            if (connection.canSetSeen() && ((key === 'BODY' && param.section) || (handler && handler.setsSeen))) {
                forceSeen = true;
            }
        });

        if (forceSeen && !flagsExist) {
            params.push({
                type: 'ATOM',
                value: 'FLAGS'
            });
        }

        if (isUid && !uidExist) {
            params.push({
                type: 'ATOM',
                value: 'UID'
            });
        }

        const handlers = params.map((param, i) => {
            const key = (param.value || '').toUpperCase();
            const handler = connection.server.fetchHandlers[key] || fetchHandlers[key];
            if (!handler) {
                throw new Error('Invalid FETCH argument ' + (key ? ' ' + key : '#' + (i + 1)));
            }
            return handler;
        });

        // item names as they appear in the response
        const names = params.map(param => {
            const name = Object.assign({}, param, { value: param.value.replace(/\.PEEK\b/i, '') });
            if (name.partial) {
                // RFC 3501 7.4.2: only the origin octet is returned in the response, as BODY[]<start>
                name.partial = name.partial.slice(0, 1);
            }
            return name;
        });

        // nothing is sent before every message is done, so a failing item leaves no partial output
        range.forEach(rangeMessage => {
            const response = [];
            let i;
            let len;
            for (i = 0, len = connection.server.fetchFilters.length; i < len; i++) {
                if (!connection.server.fetchFilters[i](connection, rangeMessage[1], parsed, rangeMessage[0])) {
                    return;
                }
            }

            if (forceSeen && rangeMessage[1].flags.indexOf('\\Seen') < 0) {
                rangeMessage[1].flags.push('\\Seen');
                seen.push(rangeMessage[1]);
            }

            for (i = 0, len = params.length; i < len; i++) {
                response.push(names[i]);
                response.push(handlers[i](connection, rangeMessage[1], params[i]));
            }

            responses.push({
                tag: '*',
                attributes: [
                    rangeMessage[0],
                    {
                        type: 'ATOM',
                        value: 'FETCH'
                    },
                    response
                ]
            });
        });
    } catch (E) {
        // the failed FETCH did not set \Seen after all
        seen.forEach(message => connection.server.removeFlag(message.flags, '\\Seen'));
        // a handler can fail with NO and a response code, e.g. NO [UNKNOWN-CTE] (RFC 3516 section 4.3)
        connection.sendStatus(parsed, data, E.imapResponse === 'NO' ? 'NO' : 'BAD', E.message, E.code, command + ' FAILED');
        return callback();
    }

    responses.forEach(response => connection.send(response, command, parsed, data));

    connection.send(
        {
            tag: parsed.tag,
            command: 'OK',
            attributes: [
                {
                    type: 'TEXT',
                    value: command + ' Completed'
                }
            ]
        },
        command,
        parsed,
        data
    );

    // other sessions that have the mailbox selected learn about the new flags (RFC 3501 section 5.2)
    connection.notifyFlagChanges(seen);
    return callback();
}

module.exports = (connection, parsed, data, callback) => processFetch(false, connection, parsed, data, callback);
module.exports.processFetch = processFetch;
module.exports.macros = macros;
