'use strict';

const { states } = require('../command-states');

/**
 * @help Custom plugin to allow programmatic control of the server
 * @help Available commands:
 * @help  XTOYBIRD SERVER dumps server internals
 * @help  XTOYBIRD CONNECTION dumps connection internals
 * @help  XTOYBIRD STORAGE dumps storage as JSON
 * @help  XTOYBIRD USERADD "username" "password" adds or updates user
 * @help  XTOYBIRD USERDEL "username" removes a user
 * @help  XTOYBIRD SHUTDOWN Closes the server after the last client
 * @help                  disconnects. New connections are rejected.
 * @help Commands are only allowed after login, and only for the owner
 * @help (aclOwner option) when ACL is loaded. A test control plugin,
 * @help any user it allows can read and change everything
 */

const util = require('util');
const { isAstring } = require('../arguments');

module.exports = function (server) {
    let username;
    let password;
    let message;

    const sendError = (connection, parsed, data, callback, command, message) => {
        connection.sendStatus(parsed, data, command, message, false, 'INVALID COMMAND');
        return callback();
    };

    server.setCommandHandler(
        'XTOYBIRD',
        (connection, parsed, data, callback) => {
            // XTOYBIRD bypasses every access check (STORAGE dumps all mailboxes), so with ACL only the owner may use it
            if (server.acl && !server.acl.isOwner(connection)) {
                connection.sendStatus(parsed, data, 'NO', 'XTOYBIRD is only allowed for the owner', 'NOPERM', 'INVALID COMMAND');
                return callback();
            }

            if (parsed.attributes) {
                const subcommand = ((parsed.attributes[0] && parsed.attributes[0].value) || '').toString().toUpperCase();
                if (subcommand === 'USERADD' && (parsed.attributes.length !== 3 || !isAstring(parsed.attributes[1]) || !isAstring(parsed.attributes[2]))) {
                    return sendError(connection, parsed, data, callback, 'BAD', 'USERADD expects username and password');
                }
                if (subcommand === 'USERDEL' && (parsed.attributes.length !== 2 || !isAstring(parsed.attributes[1]))) {
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
        },
        { states: states.AUTHENTICATED }
    );
};

// Response text is free text that some clients still tokenize, so only plain user names are echoed
function displayName(username) {
    return /^[\w.@+-]+$/.test(username) ? "'" + username + "' " : '';
}
