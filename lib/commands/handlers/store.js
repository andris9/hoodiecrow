'use strict';

const storeHandlers = {};

module.exports = storeHandlers;

function normalizeSystemFlag(flag) {
    if (flag.charAt(0) === '\\') {
        flag = flag.charAt(0) + flag.charAt(1).toUpperCase() + flag.substr(2).toLowerCase();
    }
    return flag;
}

// RFC 3501 9: flag-keyword = atom = 1*ATOM-CHAR, so a keyword can not contain atom-specials:
// "(" / ")" / "{" / SP / CTL / list-wildcards / quoted-specials / resp-specials. 8-bit octets are
// allowed, the parser accepts them in atoms as well
// eslint-disable-next-line no-control-regex
const INVALID_KEYWORD_CHAR = /[\x00-\x1f\x7f (){%*"\\\]]/;

function checkSystemFlags(connection, flag) {
    if (flag.charAt(0) === '\\') {
        if (connection.server.systemFlags.indexOf(flag) < 0) {
            throw new Error('Invalid system flag ' + flag);
        }
    } else if (!flag || INVALID_KEYWORD_CHAR.test(flag)) {
        throw new Error('Invalid flag keyword ' + JSON.stringify(flag));
    }
}

function setFlags(connection, message, flags) {
    const messageFlags = [];
    [].concat(flags).forEach(flag => {
        flag = normalizeSystemFlag(typeof flag === 'string' ? flag : String(flag.value || ''));
        checkSystemFlags(connection, flag);

        // Ignore if it is not in allowed list and only permament flags are allowed to use
        if (connection.selectedMailbox.permanentFlags.indexOf(flag) < 0 && !connection.selectedMailbox.allowPermanentFlags) {
            return;
        }

        if (messageFlags.indexOf(flag) < 0) {
            messageFlags.push(flag);
        }
    });
    message.flags = messageFlags;
}

function addFlags(connection, message, flags) {
    [].concat(flags).forEach(flag => {
        flag = normalizeSystemFlag(typeof flag === 'string' ? flag : String(flag.value || ''));
        checkSystemFlags(connection, flag);

        // Ignore if it is not in allowed list and only permament flags are allowed to use
        if (connection.selectedMailbox.permanentFlags.indexOf(flag) < 0 && !connection.selectedMailbox.allowPermanentFlags) {
            return;
        }

        if (message.flags.indexOf(flag) < 0) {
            message.flags.push(flag);
        }
    });
}

function removeFlags(connection, message, flags) {
    [].concat(flags).forEach(flag => {
        flag = normalizeSystemFlag(typeof flag === 'string' ? flag : String(flag.value || ''));
        checkSystemFlags(connection, flag);

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

function sendUpdate(connection, parsed, data, index, message) {
    const resp = [
        {
            type: 'ATOM',
            value: 'FLAGS'
        },
        message.flags.map(flag => {
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

storeHandlers.FLAGS = function (connection, message, flags, index, parsed, data) {
    setFlags(connection, message, flags);
    sendUpdate(connection, parsed, data, index, message);
};

storeHandlers['+FLAGS'] = function (connection, message, flags, index, parsed, data) {
    addFlags(connection, message, flags);
    sendUpdate(connection, parsed, data, index, message);
};

storeHandlers['-FLAGS'] = function (connection, message, flags, index, parsed, data) {
    removeFlags(connection, message, flags);
    sendUpdate(connection, parsed, data, index, message);
};

storeHandlers['FLAGS.SILENT'] = function (connection, message, flags) {
    setFlags(connection, message, flags);
};

storeHandlers['+FLAGS.SILENT'] = function (connection, message, flags) {
    addFlags(connection, message, flags);
};

storeHandlers['-FLAGS.SILENT'] = function (connection, message, flags) {
    removeFlags(connection, message, flags);
};
