'use strict';

module.exports = function (connection, parsed, data, callback) {
    if (connection.refuseReadOnly(parsed, data, 'EXPUNGE FAILED')) {
        return callback();
    }

    connection.expungeDeleted(connection.selectedMailbox, false, true);

    connection.send(
        {
            tag: parsed.tag,
            command: 'OK',
            attributes: [
                {
                    type: 'TEXT',
                    value: 'EXPUNGE Completed'
                }
            ]
        },
        'EXPUNGE',
        parsed,
        data
    );

    callback();
};
