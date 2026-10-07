'use strict';

const { states } = require('../command-states');

/**
 * @help Adds UNSELECT [RFC3691] capability
 */

module.exports = function (server) {
    server.registerCapability('UNSELECT');

    server.setCommandHandler(
        'UNSELECT',
        (connection, parsed, data, callback) => {
            connection.send(
                {
                    tag: parsed.tag,
                    command: 'OK',
                    attributes: [
                        {
                            type: 'TEXT',
                            value: 'Mailbox closed'
                        }
                    ]
                },
                'CLOSE',
                parsed,
                data
            );

            connection.state = 'Authenticated';

            connection.selectedMailbox = false;
            return callback();
        },
        { states: states.SELECTED, noArguments: true }
    );
};
