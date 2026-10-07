'use strict';

module.exports = function (connection, parsed, data, callback) {
    connection.state = 'Logout';

    connection.send(
        {
            tag: '*',
            command: 'BYE',
            attributes: [
                {
                    type: 'TEXT',
                    value: 'LOGOUT received'
                }
            ]
        },
        'LOGOUT UNTAGGED',
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
                    value: 'Completed'
                }
            ]
        },
        'LOGOUT COMPLETED',
        parsed,
        data
    );

    connection.end();

    callback();
};
