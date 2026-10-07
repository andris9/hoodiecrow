import { toSequenceSet } from '../esearch.js';
import type { Callback, IMAPConnection, IMAPResponse, IMAPServer, Mailbox, Message, ParsedCommand } from '../types.js';

/**
 * @help Adds UIDPLUS [RFC4315] capability
 *
 * UIDPLUS: http://tools.ietf.org/html/rfc4315
 *
 * Additional commands:
 * - UID EXPUNGE
 *
 * Additional response codes:
 * - APPENDUID (with a UID set for MULTIAPPEND, and in an untagged OK for REPLACE)
 * - COPYUID
 * - Not implemented: UIDNOTSTICKY
 */
export default function uidplusPlugin(server: IMAPServer) {
    server.registerCapability('UIDPLUS');

    server.setCommandHandler('UID EXPUNGE', (connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) => {
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

        if (connection.refuseReadOnly(parsed, data, 'UID EXPUNGE FAILED')) {
            return callback();
        }

        const sequence = parsed.attributes[0].value;
        const range = connection.limitRange(parsed, connection.getMessageRange(sequence, true));
        // Only messages with the \Deleted flag are removed (RFC 4315 section 2.1)
        const rangeMessages = range.map(x => x[1]).filter((message: Message) => message.flags.indexOf('\\Deleted') >= 0);

        connection.expungeSpecificMessages(connection.selectedMailbox as Mailbox, rangeMessages, false, true, !!parsed.highestFirst);

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

    server.outputHandlers.push((connection: IMAPConnection, response: IMAPResponse, description: string, parsed: ParsedCommand, data: string, extra: any) => {
        if (description === 'APPEND' || description === 'REPLACE APPENDUID') {
            // OK [APPENDUID <target-mailbox-uidvalidity> <uid>] APPEND Completed. With MULTIAPPEND the
            // second value is a UID set, but never for a single message (RFC 4315 section 3)
            const uids = extra.messages.map((message: Message) => message.uid);
            response.attributes = [
                {
                    type: 'SECTION',
                    section: [
                        {
                            type: 'ATOM',
                            value: 'APPENDUID'
                        },
                        extra.mailbox.uidvalidity,
                        uids.length > 1 ? { type: 'SEQUENCE', value: toSequenceSet(uids) } : uids[0]
                    ]
                }
            ].concat(response.attributes);
            // REPLACE sends APPENDUID in an untagged OK before the EXPUNGE (RFC 8508 section 4.3)
            response.skipResponse = false;
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
}
