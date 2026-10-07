/**
 * @help Adds SEARCHRES [RFC5182] capability, loads ESEARCH as well
 * @help SEARCH RETURN (SAVE) stores the result, "$" refers to it in place of a sequence set
 */

import esearch from './esearch.js';
import { selectReturned } from '../esearch.js';
import type { IMAPConnection, IMAPResponse, IMAPServer, Message, MessageRange, ParsedCommand } from '../types.js';

// Commands after which the search result variable is empty (RFC 5182 section 2.1). After CLOSE and
// UNSELECT no mailbox is selected, so "$" can not be used until the next SELECT or EXAMINE anyway
const RESET_COMMANDS = new Set(['SELECT', 'EXAMINE', 'CLOSE', 'UNSELECT']);

// SAVE also applies to commands based on SEARCH, like SORT (RFC 5182 section 1) with ESORT
// and to the ESEARCH command of MULTISEARCH, which leaves the messages to save in `parsed.searchresFound`
const isSearch = (command: string) => ['SEARCH', 'UID SEARCH', 'SORT', 'UID SORT', 'ESEARCH'].includes(command);

export default function searchresPlugin(server: IMAPServer) {
    // a SEARCHRES server MUST also implement ESEARCH (RFC 5182 section 2.1)
    esearch(server);

    server.registerCapability('SEARCHRES');
    // SAVE adds no data to the ESEARCH response
    server.searchReturnOptions.set('SAVE', { data: false });

    server.connectionHandlers.push((connection: IMAPConnection) => {
        // RFC 5182 section 3: sequence-set =/ seq-last-command, seq-last-command = "$". Dovecot only accepts
        // "$" as the whole sequence set, not combined with numbers like "1,$", and neither does ImapKit
        const getMessageRange = connection.getMessageRange;
        connection.getMessageRange = function (this: IMAPConnection, range: string | number | null | undefined, isUid: boolean) {
            if (range !== '$') {
                return getMessageRange.call(this, range, isUid);
            }
            // The search result variable holds message objects, so expunged messages drop out of it without
            // renumbering, and it is the same set for UID and sequence number commands (RFC 5182 section 2.1).
            // As "$" holds no sequence numbers, core lets it be pipelined (RFC 5182 section 2.3)
            const saved: Set<Message> = this.searchResult || new Set();
            const result: MessageRange = [];
            this.getSessionMessages().forEach((message: Message, i: number) => {
                if (saved.has(message)) {
                    result.push([i + 1, message]);
                }
            });
            return result;
        };
    });

    // RFC 8437 section 4.1: after UNAUTHENTICATE "$" represents the empty set
    server.resetHandlers.push((connection: IMAPConnection) => {
        connection.searchResult = null;
    });

    server.outputHandlers.push((connection: IMAPConnection, response: IMAPResponse, description: string, parsed: ParsedCommand, data: string, extra: any) => {
        if (!parsed || !response || (response.tag !== parsed.tag && response.command !== 'SEARCH' && response.command !== 'SORT')) {
            return;
        }
        const command = (parsed.command || '').toUpperCase();
        const save = isSearch(command) && parsed.searchReturn && parsed.searchReturn.has('SAVE');

        // the result of SEARCH, with MIN and/or MAX only these messages are saved (RFC 5182 section 2.4).
        // It is stored once the tagged response tells if the command succeeded
        if (
            save &&
            response.tag === '*' &&
            (response.command === 'SEARCH' || response.command === 'SORT') &&
            description === command &&
            extra &&
            Array.isArray(extra.list)
        ) {
            parsed.searchresFound = selectReturned(extra.sorted || extra.list, parsed.searchReturn);
            return;
        }

        if (response.tag !== parsed.tag) {
            return;
        }

        if (RESET_COMMANDS.has(command)) {
            connection.searchResult = null;
            return;
        }

        // RFC 5182 section 2.1: an OK sets the variable, a NO empties it and a BAD leaves it as it was
        if (save && response.command !== 'BAD') {
            connection.searchResult = new Set(response.command === 'OK' ? parsed.searchresFound : []);
        }
    });
}
