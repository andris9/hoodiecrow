import type { Attribute, IMAPConnection, IMAPServer, Mailbox, ParsedCommand } from './types.js';

/** An extended LIST selection option, see getListExtensions() */
export interface ListSelectionOption {
    type: 'base' | 'independent' | 'modifier';
    returnOption?: string;
    includeNonExistent?: boolean;
    match?: (folder: Mailbox, connection: IMAPConnection) => boolean;
}

/** What onItem() of a return option learns about a listed mailbox */
export interface ListItemInfo {
    /** the mailbox matched the selection criteria */
    matched: boolean;
    /** the mailbox is not \NonExistent */
    exists: boolean;
}

/** An extended LIST return option, see getListExtensions() */
export interface ListReturnOption {
    parse?: (list: Attribute, connection: IMAPConnection) => any;
    onItem?: (connection: IMAPConnection, folder: Mailbox, value: any, info: ListItemInfo, parsed: ParsedCommand, data: string) => void;
}

/** The registry of extended LIST options */
export interface ListExtensions {
    enabled: boolean;
    selectionOptions: Record<string, ListSelectionOption>;
    returnOptions: Record<string, ListReturnOption>;
}

/**
 * Returns the registry of extended LIST options (RFC 5258 section 3), shared by the LIST-EXTENDED
 * plugin and the plugins that add their own options (SPECIAL-USE, LIST-STATUS). These can be loaded
 * in any order, so whichever comes first creates the registry. Options are only accepted when the
 * LIST-EXTENDED plugin is loaded (`enabled`).
 *
 * Selection options: `{ type, returnOption, includeNonExistent, match(folder, connection) }`
 *   - `type` is "base", "independent" or "modifier" (list-select-base-opt, list-select-independent-opt
 *     and list-select-mod-opt in the RFC 5258 section 6 grammar)
 *   - `returnOption` is the return option the selection option implies
 *   - `match` is the filter the mailboxes must pass, `includeNonExistent` if it can select mailbox
 *     names that do not exist (like SUBSCRIBED)
 *
 * Return options: `{ parse(list, connection), onItem(connection, folder, value, info, parsed, data) }`
 *   - `parse` is set for options that take a value (option-value), it returns the parsed value or
 *     throws an Error with a message for the BAD response
 *   - `onItem` runs after the LIST response of every listed mailbox. `info.matched` is true if the
 *     mailbox matched the selection criteria, `info.exists` if it is not \NonExistent
 *
 * @param {Object} server IMAPServer instance
 * @return {Object} `{ enabled, selectionOptions, returnOptions }`
 */
function getListExtensions(server: IMAPServer): ListExtensions {
    if (!server.listExtensions) {
        server.listExtensions = {
            enabled: false,
            selectionOptions: Object.create(null),
            returnOptions: Object.create(null)
        };
    }
    return server.listExtensions;
}

export { getListExtensions };
