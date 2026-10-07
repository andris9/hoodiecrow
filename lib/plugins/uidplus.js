'use strict';

/**
 * @help Adds UIDPLUS [RFC4315] capability
 *
 * UIDPLUS: http://tools.ietf.org/html/rfc4315
 *
 * Additional commands:
 * - UID EXPUNGE
 *
 * Additional response codes:
 * - APPENDUID
 * - COPYUID
 * - Not implemented: UIDNOTSTICKY
 */
module.exports = function (server) {
    server.registerCapability('UIDPLUS');

    server.setCommandHandler('UID EXPUNGE', (connection, parsed, data, callback) => {
        if (!parsed.attributes || parsed.attributes.length !== 1 || !parsed.attributes[0] || ['ATOM', 'SEQUENCE'].indexOf(parsed.attributes[0].type) < 0) {
            connection.send(
                {
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [
                        {
                            type: 'TEXT',
                            value: 'UID EXPUNGE expects uid sequence set'
                        }
                    ]
                },
                'INVALID COMMAND',
                parsed,
                data
            );
            return callback();
        }

        if (['Selected'].indexOf(connection.state) < 0) {
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
                'UID EXPUNGE FAILED',
                parsed,
                data
            );
            return callback();
        }

        if (connection.readOnly) {
            connection.sendStatus(parsed, data, 'NO', 'Mailbox is read-only', false, 'UID EXPUNGE FAILED');
            return callback();
        }

        const sequence = parsed.attributes[0].value;
        const range = connection.server.getMessageRange(connection.getSessionMessages(), sequence, true);
        // Only messages with the \Deleted flag are removed (RFC 4315 section 2.1)
        const rangeMessages = range.map(x => x[1]).filter(message => message.flags.indexOf('\\Deleted') >= 0);

        connection.expungeSpecificMessages(connection.selectedMailbox, rangeMessages, false, true);

        connection.send(
            {
                tag: parsed.tag,
                command: 'OK',
                attributes: [
                    {
                        type: 'TEXT',
                        value: 'UID EXPUNGE completed'
                    }
                ]
            },
            'UID EXPUNGE',
            parsed,
            data
        );
        callback();
    });

    server.outputHandlers.push((connection, response, description, parsed, data, extra) => {
        if (description === 'APPEND') {
            // The final response should be of the form:
            // OK [APPENDUID <target-mailbox-uidvalidity> <uid>] APPEND Completed
            response.attributes = [
                {
                    type: 'SECTION',
                    section: [
                        {
                            type: 'ATOM',
                            value: 'APPENDUID'
                        },
                        extra.mailbox.uidvalidity,
                        extra.message.uid
                    ]
                }
            ].concat(response.attributes);
            return;
        }

        if (description === 'COPY' || description === 'UID COPY' || description === 'MOVE COPYUID' || description === 'UID MOVE COPYUID') {
            // Nothing was copied, an empty COPYUID would break the response grammar
            if (!extra || !extra.sourceUids || !extra.sourceUids.length) {
                return;
            }
            response.attributes = [
                {
                    type: 'SECTION',
                    section: [
                        {
                            type: 'ATOM',
                            value: 'COPYUID'
                        },
                        extra.mailbox.uidvalidity,
                        // The range was interpreted in ascending order so these
                        // values are already in the right order.
                        {
                            type: 'SEQUENCE',
                            value: extra.sourceUids.join(',')
                        },
                        {
                            type: 'SEQUENCE',
                            value: extra.targetUids.join(',')
                        }
                    ]
                }
            ].concat(response.attributes);
            response.skipResponse = false;
            return;
        }
    });
};
