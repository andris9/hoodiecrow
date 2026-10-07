'use strict';

module.exports = function (connection, parsed, data, callback) {
    const args = [].concat(parsed.attributes || []);
    let flags;

    if (['Authenticated', 'Selected'].indexOf(connection.state) < 0) {
        connection.send(
            {
                tag: parsed.tag,
                command: 'BAD',
                attributes: [
                    {
                        type: 'TEXT',
                        value: 'Log in first'
                    }
                ]
            },
            'APPEND FAILED',
            parsed,
            data
        );
        return callback();
    }

    if (args.length > 4 || args.length < 2) {
        connection.send(
            {
                tag: parsed.tag,
                command: 'BAD',
                attributes: [
                    {
                        type: 'TEXT',
                        value: 'APPEND takes 2 - 4 arguments'
                    }
                ]
            },
            'INVALID COMMAND',
            parsed,
            data
        );
        return callback();
    }

    const path = args.shift();
    const raw = args.pop();

    if (Array.isArray(args[0])) {
        flags = args.shift();
    }
    const internaldate = args.shift();

    if (!path || ['STRING', 'ATOM', 'LITERAL'].indexOf(path.type) < 0) {
        connection.send(
            {
                tag: parsed.tag,
                command: 'BAD',
                attributes: [
                    {
                        type: 'TEXT',
                        value: 'Invalid mailbox argument'
                    }
                ]
            },
            'INVALID COMMAND',
            parsed,
            data
        );
        return callback();
    }

    if (!raw || raw.type !== 'LITERAL') {
        connection.send(
            {
                tag: parsed.tag,
                command: 'BAD',
                attributes: [
                    {
                        type: 'TEXT',
                        value: 'Invalid message source argument'
                    }
                ]
            },
            'INVALID COMMAND',
            parsed,
            data
        );
        return callback();
    }

    if (flags) {
        for (let i = 0, len = flags.length; i < len; i++) {
            // flags are atoms, and \Recent or unknown system flags can not be set (RFC 3501 section 9)
            if (!flags[i] || flags[i].type !== 'ATOM' || (flags[i].value.charAt(0) === '\\' && connection.server.systemFlags.indexOf(flags[i].value) < 0)) {
                connection.send(
                    {
                        tag: parsed.tag,
                        command: 'BAD',
                        attributes: [
                            {
                                type: 'TEXT',
                                value: 'Invalid flags argument'
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
    }

    if (internaldate && (internaldate.type !== 'STRING' || !connection.server.validateInternalDate(internaldate.value))) {
        connection.send(
            {
                tag: parsed.tag,
                command: 'BAD',
                attributes: [
                    {
                        type: 'TEXT',
                        value: 'Invalid internaldate argument'
                    }
                ]
            },
            'INVALID COMMAND',
            parsed,
            data
        );
        return callback();
    }

    const mailbox = connection.server.getMailbox(path.value);
    if (!mailbox || mailbox.flags.indexOf('\\Noselect') >= 0) {
        connection.send(
            {
                tag: parsed.tag,
                command: 'NO',
                attributes: [].concat(
                    // TRYCREATE tells the client that CREATE would help (RFC 3501 section 6.3.11)
                    !mailbox
                        ? {
                              type: 'SECTION',
                              section: [
                                  {
                                      type: 'ATOM',
                                      value: 'TRYCREATE'
                                  }
                              ]
                          }
                        : [],
                    {
                        type: 'TEXT',
                        value: mailbox ? 'Target mailbox is not selectable' : 'Target mailbox does not exist'
                    }
                )
            },
            'APPEND FAILED',
            parsed,
            data
        );
        return callback();
    }

    // the session that has the target mailbox selected gets an EXISTS update as well
    const appendResult = connection.server.appendMessage(
        mailbox,
        (flags || []).map(flag => {
            return flag.value;
        }),
        internaldate && internaldate.value,
        raw.value
    );

    connection.send(
        {
            tag: parsed.tag,
            command: 'OK',
            attributes: [
                {
                    type: 'TEXT',
                    value: 'APPEND Completed'
                }
            ]
        },
        'APPEND',
        parsed,
        data,
        appendResult
    );
    callback();
};
