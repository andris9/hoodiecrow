/**
 * @help Adds CONTEXT=SORT [RFC5267] capability, loads ESORT and CONTEXT=SEARCH as well
 * @help SORT RETURN (UPDATE) sends ADDTO and REMOVEFROM updates with context positions in sort order, PARTIAL and CONTEXT work for SORT too
 */

import esort from './esort.js';
import contextSearch from './context-search.js';
import type { IMAPServer } from '../types.js';

export default function contextSortPlugin(server: IMAPServer) {
    // RFC 5267 section 4.1: CONTEXT=SORT means SORT and the extended SORT syntax of section 3. The updating
    // contexts are shared with CONTEXT=SEARCH, so that is loaded (and advertised) as well
    esort(server);
    contextSearch(server);

    server.registerCapability('CONTEXT=SORT');
    server.contextSort = true;
}
