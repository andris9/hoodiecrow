import { toVanished } from '../vanished.js';
import { isAtom } from '../arguments.js';
import { registerEnable, isEnabled } from './enable.js';
import type { Attribute, CommandContext, IMAPConnection, IMAPResponse, IMAPServer, ParsedCommand } from '../types.js';

/** The command that getRefusal() checks, the literal filter only knows its name */
type CheckedCommand = Pick<ParsedCommand, 'command'> & { attributes?: Attribute[] | undefined };

/**
 * @help Adds UIDONLY [RFC9586] capability, loads ENABLE as well
 * @help After ENABLE UIDONLY: FETCH, STORE, SEARCH, COPY, MOVE, SORT, THREAD, REPLACE and
 * @help message numbers in UID SEARCH (SORT, THREAD) criteria are refused with BAD [UIDREQUIRED],
 * @help UIDFETCH responses replace FETCH responses and VANISHED replaces EXPUNGE.
 * @help Load UIDPLUS for COPYUID and UID EXPUNGE
 *
 * UIDONLY: https://www.rfc-editor.org/rfc/rfc9586
 */

export default function uidonlyPlugin(server: IMAPServer) {
    server.registerCapability('UIDONLY');

    registerEnable(server, 'UIDONLY');

    // UNAUTHENTICATE clears the ENABLEd extensions (RFC 8437 section 4.1)
    const isUidonly = (connection: IMAPConnection) => isEnabled(connection, 'UIDONLY');

    const refuse = (text: string) => ({ command: 'BAD', code: 'UIDREQUIRED', text });

    // RFC 9586 section 3: once UIDONLY is enabled, message numbers in any argument MUST be answered with a
    // tagged BAD that has the UIDREQUIRED response code
    const getRefusal = (connection: IMAPConnection, parsed: CheckedCommand) => {
        const command = String(parsed.command || '').toUpperCase();
        const options = server.getCommandOptions(command);
        // the ESEARCH command of MULTISEARCH always returns UIDs (RFC 7377 section 2), like a UID command
        const isUid = /^UID /.test(command) || command === 'ESEARCH';

        // sections 3.2 and 3.8: FETCH, STORE, SEARCH, COPY, MOVE, SORT and THREAD are prohibited, also REPLACE
        // (RFC 8508), its message argument is a sequence number. These have the sequenceSet or searchCriteria
        // command option
        if (!isUid && (options.sequenceSet !== false || options.searchCriteria !== false)) {
            return refuse(command + ' is not allowed once UIDONLY is enabled, use UID ' + command);
        }

        // section 3.5: the <sequence set> search key is prohibited, also in UID SORT and UID THREAD
        if (isUid && options.searchCriteria !== false && connection.usesSequenceNumbers(parsed as CommandContext)) {
            return refuse('Message numbers are not allowed in the search criteria once UIDONLY is enabled, use UID <sequence set>');
        }

        // section 3.7: the fourth QRESYNC parameter (message sequence match data) MUST NOT be used
        if ((command === 'SELECT' || command === 'EXAMINE') && parsed.attributes && Array.isArray(parsed.attributes[1])) {
            const params = parsed.attributes[1];
            const position = params.findIndex((param: any) => isAtom(param, 'QRESYNC'));
            const value = position >= 0 && params[position + 1];
            if (Array.isArray(value) && value.slice(2).some(Array.isArray)) {
                return refuse('QRESYNC message sequence match data is not allowed once UIDONLY is enabled');
            }
        }

        return false;
    };

    server.commandChecks.push((connection: IMAPConnection, parsed: ParsedCommand) => isUidonly(connection) && getRefusal(connection, parsed));

    // a prohibited command is refused before its literal is sent, before other checks that would answer NO
    server.literalFilters.unshift((connection: IMAPConnection, command: string) => isUidonly(connection) && getRefusal(connection, { command }));

    server.connectionHandlers.push((connection: IMAPConnection) => {
        // RFC 3501 section 5.5 is about commands with message numbers, these are all refused with
        // BAD [UIDREQUIRED] once UIDONLY is enabled, as if they had waited
        const isAmbiguous = connection.isAmbiguous;
        connection.isAmbiguous = function (parsed: ParsedCommand) {
            return !isUidonly(this) && isAmbiguous.call(this, parsed);
        };

        // RFC 9586 sections 3.4 and 3.6: expunges are announced with VANISHED instead of EXPUNGE, EXISTS and
        // RECENT stay as they are
        const prepareNotifications = connection.prepareNotifications;
        connection.prepareNotifications = function (queue: any[]) {
            queue = prepareNotifications.call(this, queue);
            return isUidonly(this) ? toVanished(queue) : queue;
        };
    });

    // RFC 9586 section 3: the server MUST NOT return message sequence numbers in any response
    const outputHandler = (connection: IMAPConnection, response: IMAPResponse, description: string, parsed: ParsedCommand, data: string, extra: any) => {
        if (!response || response.tag !== '*' || !Array.isArray(response.attributes) || !isUidonly(connection)) {
            return;
        }
        const attributes = response.attributes;

        // the UNSEEN response code of SELECT and EXAMINE is a message number (RFC 3501 section 7.1)
        if (response.command === 'OK' && attributes[0] && attributes[0].type === 'SECTION' && isAtom(attributes[0].section[0], 'UNSEEN')) {
            response.skipResponse = true;
            return;
        }

        if (!isAtom(attributes[1], 'FETCH') || !Array.isArray(attributes[2])) {
            return;
        }

        // section 3.3: uidfetch-resp = uniqueid SP "UIDFETCH" SP msg-att
        // FETCH responses pass their message as `extra`, notifications like the MessageNew FETCH of NOTIFY carry it
        const list = attributes[2];
        const uidPos = list.findIndex((item, i) => !(i % 2) && isAtom(item, 'UID'));
        const message = (extra && typeof extra.uid === 'number' && extra) || response.fetchedMessage;
        const uid = message ? message.uid : uidPos >= 0 && list[uidPos + 1];
        if (!uid) {
            // never send a sequence number instead
            response.skipResponse = true;
            return;
        }

        // the UID data item is only included if the client asked for it, like in the examples of section 3.3
        if (parsed && !('uidonlyKeepUid' in parsed)) {
            parsed.uidonlyKeepUid = requestsUid(parsed);
        }
        let items = list;
        if (uidPos >= 0 && list.length > 2 && !(parsed && parsed.uidonlyKeepUid)) {
            items = list.slice(0, uidPos).concat(list.slice(uidPos + 2));
        }
        response.attributes = [uid, { type: 'ATOM', value: 'UIDFETCH' }, items];
    };

    // registered once every plugin is loaded, so that the other output handlers see the FETCH responses they
    // know before these are turned into UIDFETCH responses
    server.once('pluginsLoaded', () => server.outputHandlers.push(outputHandler));
}

// Checks if a UID FETCH command lists the UID data item
function requestsUid(parsed: ParsedCommand) {
    if (String(parsed.command || '').toUpperCase() !== 'UID FETCH' || !parsed.attributes) {
        return false;
    }
    return [].concat(parsed.attributes[1] || []).some(item => isAtom(item, 'UID'));
}

uidonlyPlugin.requires = ['ENABLE'];
