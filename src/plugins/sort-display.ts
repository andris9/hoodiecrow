import { collationKey, displayAddress } from '../sorting.js';
import sort from './sort.js';
import type { IMAPServer, Message } from '../types.js';

/**
 * @help Adds SORT=DISPLAY [RFC5957] capability, also loads SORT
 *
 * SORT=DISPLAY: https://tools.ietf.org/html/rfc5957
 *
 * Additional sort keys for SORT and UID SORT:
 * - DISPLAYFROM
 * - DISPLAYTO
 */
export default function sortDisplayPlugin(server: IMAPServer) {
    // RFC 5957 section 1: SORT=DISPLAY means the full SORT extension plus both sort keys
    sort(server);
    server.registerCapability('SORT=DISPLAY');

    // RFC 5957 section 4: the DISPLAY sort value of the first address of env-from and env-to
    server.sortKeys.DISPLAYFROM = (message: Message) => collationKey(displayAddress(message, 'from'));
    server.sortKeys.DISPLAYTO = (message: Message) => collationKey(displayAddress(message, 'to'));
}
