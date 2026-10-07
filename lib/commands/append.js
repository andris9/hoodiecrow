'use strict';

const { normalizeSystemFlag, checkSystemFlags } = require('./handlers/flags');

module.exports = function (connection, parsed, data, callback) {
    const args = [].concat(parsed.attributes || []);
    let flags;

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

    // flags are atoms, and \Recent or unknown system flags can not be set (RFC 3501 section 9)
    try {
        flags = (flags || []).map(flag => {
            if (!flag || flag.type !== 'ATOM') {
                throw new Error('Invalid flags argument');
            }
            const value = normalizeSystemFlag(flag.value);
            checkSystemFlags(connection, value);
            return value;
        });
    } catch {
        connection.sendStatus(parsed, data, 'BAD', 'Invalid flags argument', false, 'INVALID COMMAND');
        return callback();
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

    const mailbox = connection.getTargetMailbox(path.value, parsed, data, 'APPEND FAILED');
    if (!mailbox || !connection.checkAppend(mailbox, [{ raw: raw.value }], parsed, data, 'APPEND FAILED')) {
        return callback();
    }

    // the session that has the target mailbox selected gets an EXISTS update as well
    const appendResult = connection.server.appendMessage(mailbox, flags, internaldate && internaldate.value, raw.value);

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
