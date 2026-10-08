import { normalizeSystemFlag, checkSystemFlags } from './flags.js';
import type { Attribute, IMAPConnection, Mailbox, Message, ParsedCommand, StoreHandler } from '../../types.js';

const storeHandlers: Record<string, StoreHandler> = {};

export default storeHandlers;

/** The flags of a STORE: a flag or a list of flags, each a string or an atom */
type FlagValues = Attribute | Attribute[];

function setFlags(connection: IMAPConnection, message: Message, flags: FlagValues) {
    // STORE runs in the Selected state
    const mailbox = connection.selectedMailbox as Mailbox;
    const messageFlags: string[] = [];
    ([] as Attribute[]).concat(flags).forEach(flag => {
        flag = normalizeSystemFlag(typeof flag === 'string' ? flag : String(flag.value || ''));
        checkSystemFlags(connection.server, flag);

        // Ignore if it is not in allowed list and only permament flags are allowed to use
        if (mailbox.permanentFlags.indexOf(flag) < 0 && !mailbox.allowPermanentFlags) {
            return;
        }

        if (messageFlags.indexOf(flag) < 0) {
            messageFlags.push(flag);
        }
    });
    message.flags = messageFlags;
    connection.server.rememberFlags(mailbox, messageFlags);
}

function addFlags(connection: IMAPConnection, message: Message, flags: FlagValues) {
    const mailbox = connection.selectedMailbox as Mailbox;
    ([] as Attribute[]).concat(flags).forEach(flag => {
        flag = normalizeSystemFlag(typeof flag === 'string' ? flag : String(flag.value || ''));
        checkSystemFlags(connection.server, flag);

        // Ignore if it is not in allowed list and only permament flags are allowed to use
        if (mailbox.permanentFlags.indexOf(flag) < 0 && !mailbox.allowPermanentFlags) {
            return;
        }

        if (message.flags.indexOf(flag) < 0) {
            message.flags.push(flag);
        }
    });
    connection.server.rememberFlags(mailbox, message.flags);
}

function removeFlags(connection: IMAPConnection, message: Message, flags: FlagValues) {
    ([] as Attribute[]).concat(flags).forEach(flag => {
        flag = normalizeSystemFlag(typeof flag === 'string' ? flag : String(flag.value || ''));
        checkSystemFlags(connection.server, flag);

        if (message.flags.indexOf(flag) >= 0) {
            for (let i = 0; i < message.flags.length; i++) {
                if (message.flags[i] === flag) {
                    message.flags.splice(i, 1);
                    break;
                }
            }
        }
    });
}

function sendUpdate(connection: IMAPConnection, parsed: ParsedCommand, data: string, index: number, message: Message) {
    const resp: Attribute[] = [
        {
            type: 'ATOM',
            value: 'FLAGS'
        },
        connection.getFlags(message).map(flag => {
            return {
                type: 'ATOM',
                value: flag
            };
        })
    ];

    if ((parsed.command || '').toUpperCase() === 'UID STORE') {
        resp.push({
            type: 'ATOM',
            value: 'UID'
        });
        resp.push(message.uid);
    }

    connection.send(
        {
            tag: '*',
            attributes: [
                index,
                {
                    type: 'ATOM',
                    value: 'FETCH'
                },
                resp
            ]
        },
        'FLAG UPDATE',
        parsed,
        data,
        message
    );
}

storeHandlers.FLAGS = function (connection: IMAPConnection, message: Message, flags: FlagValues, index: number, parsed: ParsedCommand, data: string) {
    setFlags(connection, message, flags);
    sendUpdate(connection, parsed, data, index, message);
};

storeHandlers['+FLAGS'] = function (connection: IMAPConnection, message: Message, flags: FlagValues, index: number, parsed: ParsedCommand, data: string) {
    addFlags(connection, message, flags);
    sendUpdate(connection, parsed, data, index, message);
};

storeHandlers['-FLAGS'] = function (connection: IMAPConnection, message: Message, flags: FlagValues, index: number, parsed: ParsedCommand, data: string) {
    removeFlags(connection, message, flags);
    sendUpdate(connection, parsed, data, index, message);
};

storeHandlers['FLAGS.SILENT'] = function (connection: IMAPConnection, message: Message, flags: FlagValues) {
    setFlags(connection, message, flags);
};

storeHandlers['+FLAGS.SILENT'] = function (connection: IMAPConnection, message: Message, flags: FlagValues) {
    addFlags(connection, message, flags);
};

storeHandlers['-FLAGS.SILENT'] = function (connection: IMAPConnection, message: Message, flags: FlagValues) {
    removeFlags(connection, message, flags);
};
