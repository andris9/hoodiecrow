'use strict';

const { copyToMailbox } = require('../commands/copy');

/**
 * @help Adds MOVE [RFC6851] capability
 *
 * MOVE: http://tools.ietf.org/html/rfc6851
 *
 * Additional commands:
 * - MOVE
 * - UID MOVE
 */
module.exports = function (server) {
    server.registerCapability('MOVE');

    const moveHandler = function (uidMode, connection, parsed, data, callback) {
        function uidify(str) {
            if (uidMode) {
                return 'UID ' + str;
            }
            return str;
        }

        if (
            !parsed.attributes ||
            parsed.attributes.length !== 2 ||
            !parsed.attributes[0] ||
            ['ATOM', 'SEQUENCE'].indexOf(parsed.attributes[0].type) < 0 ||
            !parsed.attributes[1] ||
            ['ATOM', 'STRING', 'LITERAL'].indexOf(parsed.attributes[1].type) < 0
        ) {
            connection.send(
                {
                    tag: parsed.tag,
                    command: 'BAD',
                    attributes: [
                        {
                            type: 'TEXT',
                            value: uidify('MOVE expects sequence set and a mailbox name')
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
                uidify('MOVE FAILED'),
                parsed,
                data
            );
            return callback();
        }

        // MOVE expunges messages from the source mailbox, which is not allowed after EXAMINE
        if (connection.readOnly) {
            connection.sendStatus(parsed, data, 'NO', 'Mailbox is read-only', false, uidify('MOVE FAIL'));
            return callback();
        }

        const result = copyToMailbox(connection, parsed, data, uidMode, uidify('MOVE FAIL'));
        if (!result) {
            return callback();
        }

        // Hook for UIDPLUS to generate the untagged COPYUID response (that wants
        // to happen prior to the EXPUNGEs).  If the UIDPLUS extension is not
        // active, this will not happen.
        connection.send(
            {
                tag: '*',
                command: 'OK',
                attributes: [],
                skipResponse: true
            },
            uidify('MOVE COPYUID'),
            parsed,
            data,
            result
        );

        // Expunge the messages from the source folder. When moving into the selected mailbox,
        // the copies were already announced with EXISTS responses
        connection.expungeSpecificMessages(connection.selectedMailbox, result.messages, false, true);

        connection.send(
            {
                tag: parsed.tag,
                command: 'OK',
                attributes: [
                    {
                        type: 'TEXT',
                        value: 'Done'
                    }
                ]
            },
            uidify('MOVE OK'),
            parsed,
            data
        );
        callback();
    };

    server.setCommandHandler('MOVE', moveHandler.bind(null, false));
    server.setCommandHandler('UID MOVE', moveHandler.bind(null, true));
};
