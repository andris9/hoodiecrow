'use strict';

/**
 * @help Custom plugin to allow programmatic control of the server
 * @help Available commands:
 * @help  XTOYBIRD SERVER dumps server internals
 * @help  XTOYBIRD CONNECTION dumps connection internals
 * @help  XTOYBIRD STORAGE dumps storage as JSON
 * @help  XTOYBIRD USERADD "username" "password" adds or updates user
 * @help  XTOYBIRD USERDEL "username" removes an user
 * @help  XTOYBIRD SHUTDOWN Closes the server after the last client
 * @help                  disconnects. New connections are rejected.
 * @help Commands are only allowed after login
 */

const util = require('util');

module.exports = function (server) {
    let username;
    let password;
    let message;

    const sendError = (connection, parsed, data, callback, command, message) => {
        connection.sendStatus(parsed, data, command, message, false, 'INVALID COMMAND');
        return callback();
    };

    const isString = attribute => !!attribute && ['ATOM', 'STRING', 'LITERAL'].indexOf(attribute.type) >= 0;

    server.setCommandHandler('XTOYBIRD', (connection, parsed, data, callback) => {
        // Only authenticated clients can control the server

        if (parsed.attributes) {
            const subcommand = ((parsed.attributes[0] && parsed.attributes[0].value) || '').toString().toUpperCase();
            if (subcommand === 'USERADD' && (parsed.attributes.length !== 3 || !isString(parsed.attributes[1]) || !isString(parsed.attributes[2]))) {
                return sendError(connection, parsed, data, callback, 'BAD', 'USERADD expects username and password');
            }
            if (subcommand === 'USERDEL' && (parsed.attributes.length !== 2 || !isString(parsed.attributes[1]))) {
                return sendError(connection, parsed, data, callback, 'BAD', 'USERDEL expects username');
            }

            switch (subcommand) {
                case 'SERVER':
                    connection.send(
                        {
                            tag: '*',
                            command: 'XTOYBIRD',
                            attributes: [
                                {
                                    type: 'SECTION',
                                    section: [
                                        {
                                            type: 'ATOM',
                                            value: 'XDUMPVAL'
                                        }
                                    ]
                                },
                                {
                                    type: 'LITERAL',
                                    value: util.inspect(server, false, 22)
                                }
                            ]
                        },
                        'CONNECTION STATUS',
                        parsed,
                        data
                    );
                    break;

                case 'CONNECTION':
                    connection.send(
                        {
                            tag: '*',
                            command: 'XTOYBIRD',
                            attributes: [
                                {
                                    type: 'SECTION',
                                    section: [
                                        {
                                            type: 'ATOM',
                                            value: 'XDUMPVAL'
                                        }
                                    ]
                                },
                                {
                                    type: 'LITERAL',
                                    value: util.inspect(connection, false, 22)
                                }
                            ]
                        },
                        'CONNECTION STATUS',
                        parsed,
                        data
                    );
                    break;

                case 'STORAGE':
                    connection.send(
                        {
                            tag: '*',
                            command: 'XTOYBIRD',
                            attributes: [
                                {
                                    type: 'SECTION',
                                    section: [
                                        {
                                            type: 'ATOM',
                                            value: 'XJSONDUMP'
                                        }
                                    ]
                                },
                                {
                                    type: 'LITERAL',
                                    value: JSON.stringify(connection.server.storage, false, 4)
                                }
                            ]
                        },
                        'CONNECTION STATUS',
                        parsed,
                        data
                    );
                    break;

                case 'USERADD':
                    username = parsed.attributes[1].value || '';
                    password = parsed.attributes[2].value || '';

                    if (connection.server.getUser(username)) {
                        connection.server.users[username].password = password;
                        message = 'updated';
                    } else {
                        connection.server.users[username] = {
                            password: password
                        };
                        message = 'added';
                    }

                    connection.send(
                        {
                            tag: '*',
                            command: 'XTOYBIRD',
                            attributes: [
                                {
                                    type: 'SECTION',
                                    section: [
                                        {
                                            type: 'ATOM',
                                            value: 'XUSER'
                                        }
                                    ]
                                },
                                {
                                    type: 'TEXT',
                                    value: 'User ' + displayName(username) + message + ' successfully'
                                }
                            ]
                        },
                        'CONNECTION USERADD',
                        parsed,
                        data
                    );
                    break;

                case 'USERDEL':
                    username = parsed.attributes[1].value || '';

                    if (username in connection.server.users) {
                        delete connection.server.users[username];
                        message = 'succeeded';
                    } else {
                        message = 'failed (no such user)';
                    }

                    connection.send(
                        {
                            tag: '*',
                            command: 'XTOYBIRD',
                            attributes: [
                                {
                                    type: 'SECTION',
                                    section: [
                                        {
                                            type: 'ATOM',
                                            value: 'XUSER'
                                        }
                                    ]
                                },
                                {
                                    type: 'TEXT',
                                    value: 'Removing user ' + displayName(username) + message
                                }
                            ]
                        },
                        'CONNECTION USERDEL',
                        parsed,
                        data
                    );
                    break;

                case 'SHUTDOWN':
                    connection.send(
                        {
                            tag: '*',
                            command: 'OK',
                            attributes: [
                                {
                                    type: 'SECTION',
                                    section: [
                                        {
                                            type: 'ATOM',
                                            value: 'ALERT'
                                        }
                                    ]
                                },
                                {
                                    type: 'TEXT',
                                    value: 'System scheduled for shutdown'
                                }
                            ]
                        },
                        'CONNECTION SHUTDOWN',
                        parsed,
                        data
                    );

                    connection.server.close();
                    break;

                default:
                    connection.send(
                        {
                            tag: parsed.tag,
                            command: 'BAD',
                            attributes: [
                                {
                                    type: 'TEXT',
                                    value: 'Unknown command'
                                }
                            ]
                        },
                        'INVALID COMMAND',
                        parsed,
                        data
                    );
                    return callback();
            }
        }

        connection.send(
            {
                tag: parsed.tag,
                command: 'OK',
                attributes: [
                    {
                        type: 'TEXT',
                        value: 'XTOYBIRD Completed'
                    }
                ]
            },
            'XTOYBIRD',
            parsed,
            data
        );
        return callback();
    });
};

// Response text is free text that some clients still tokenize, so only plain user names are echoed
function displayName(username) {
    return /^[\w.@+-]+$/.test(username) ? "'" + username + "' " : '';
}
