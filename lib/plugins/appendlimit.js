'use strict';

const imapHandler = require('imap-handler');

/**
 * @help Adds APPENDLIMIT [RFC7889] capability
 * @help Server option "appendLimit" sets the limit in octets for all
 * @help mailboxes, a mailbox in storage can set its own "appendLimit"
 * @help (null for no limit)
 *
 * APPENDLIMIT: https://www.rfc-editor.org/rfc/rfc7889
 *
 * The server option "appendLimit" (octets) sets a limit for all mailboxes, advertised as
 * APPENDLIMIT=<n>. A mailbox in the storage can set its own "appendLimit" (a number, or null
 * for no limit), then the capability is a plain APPENDLIMIT and clients read the limits with
 * STATUS (APPENDLIMIT). A larger APPEND or REPLACE fails with NO [TOOBIG], a synchronizing
 * literal is refused before it is sent.
 */
module.exports = function (server) {
    const serverLimit = 'appendLimit' in server.options ? server.options.appendLimit : null;
    if (serverLimit !== null && !isValidLimit(serverLimit)) {
        throw new TypeError('Invalid appendLimit option, expecting a non-negative integer');
    }

    const hasOwnLimit = mailbox => Object.hasOwn(mailbox, 'appendLimit');
    const hasMailboxLimits = () => Object.values(server.folderCache).some(hasOwnLimit);

    /**
     * @param {Object} mailbox Mailbox object
     * @return {Number|null} limit in octets, null if there is no limit
     */
    const getLimit = mailbox => {
        if (!hasOwnLimit(mailbox)) {
            return serverLimit;
        }
        return isValidLimit(mailbox.appendLimit) ? mailbox.appendLimit : null;
    };

    // RFC 7889 section 5: an APPENDLIMIT of 0 means that nothing can be appended
    const isTooBig = (mailbox, size) => {
        const limit = getLimit(mailbox);
        return limit !== null && (size > limit || limit === 0);
    };

    // RFC 7889 section 2: APPENDLIMIT=<n> for the same limit in every mailbox, otherwise a plain
    // APPENDLIMIT and the limits come from STATUS
    if (serverLimit !== null) {
        server.registerCapability('APPENDLIMIT=' + serverLimit, () => !hasMailboxLimits());
    }
    server.registerCapability('APPENDLIMIT', () => serverLimit === null || hasMailboxLimits());

    // RFC 7889 section 4: a message over the limit is refused with TOOBIG
    server.appendChecks.push((connection, mailbox, messages, options) => {
        // COPY and MOVE are not uploads (RFC 7889 section 1)
        if (!options.command) {
            return false;
        }
        if (messages.some(message => isTooBig(mailbox, message.raw.length))) {
            return { code: 'TOOBIG', text: 'Message exceeds the APPENDLIMIT of the mailbox' };
        }
        return false;
    });

    // Refuse the literal of a message that is too large before the client sends it, by not
    // sending a continuation request (RFC 3502 section 6.3.11 example A005)
    server.literalFilters.push((connection, command, line, literalSize) => {
        const mailbox = getPendingTarget(server, command, line);
        if (mailbox && isTooBig(mailbox, literalSize)) {
            return { command: 'NO', code: 'TOOBIG', text: 'Message exceeds the APPENDLIMIT of the mailbox' };
        }
        return false;
    });

    // RFC 7889 section 3.1: status-att-val =/ "APPENDLIMIT" SP (number / nil)
    server.allowedStatus.push('APPENDLIMIT');
    // also used by the STATUS return option of LIST-STATUS (RFC 7889 section 3.2)
    server.statusHandlers.APPENDLIMIT = (connection, mailbox) => getLimit(mailbox);
};

// commands that take a message like APPEND does (RFC 8508 section 3.4)
const APPEND_COMMANDS = new Set(['APPEND', 'REPLACE', 'UID REPLACE']);

function isValidLimit(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Finds the target mailbox of an APPEND or REPLACE command when a literal of a message (or of a
 * CATENATE TEXT part) is announced. Only the start of the command up to the mailbox argument is
 * parsed, so the data of earlier literals is not parsed again for every message of a MULTIAPPEND
 *
 * @param {Object} server IMAPServer
 * @param {String} command Upper case command name
 * @param {String} line Command received so far, up to the literal size marker
 * @return {Object|Boolean} Mailbox object, or false if the literal is not a message or the mailbox is unknown
 */
function getPendingTarget(server, command, line) {
    if (!APPEND_COMMANDS.has(command)) {
        return false;
    }
    const mailboxPosition = server.getCommandOptions(command).mailboxArguments[0];

    // the literal of a CATENATE URL is not a message part
    if (/[ (]URL $/i.test(line.slice(-5))) {
        return false;
    }

    // an open CATENATE list is closed for parsing
    const parse = text => {
        for (const suffix of ['', ')']) {
            try {
                return imapHandler.parser(text.replace(/ $/, '') + suffix).attributes || [];
            } catch {
                // try the next suffix
            }
        }
        return [];
    };

    // the command up to the first literal, or up to the end of it when that literal is the mailbox name
    const literal = line.match(/\{(\d+)\+?\}\r\n/);
    let attributes = parse(literal ? line.substr(0, literal.index) : line);
    if (attributes.length <= mailboxPosition && literal) {
        attributes = parse(line.substr(0, literal.index + literal[0].length + Number(literal[1])));
    }
    // the literal is the mailbox name itself
    if (attributes.length <= mailboxPosition) {
        return false;
    }

    const pathArg = attributes[mailboxPosition];
    return (pathArg && typeof pathArg.value === 'string' && server.getMailbox(pathArg.value)) || false;
}
