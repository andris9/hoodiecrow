'use strict';

/**
 * @help Adds CONTEXT=SORT [RFC5267] capability, loads ESORT and CONTEXT=SEARCH as well
 * @help SORT RETURN (UPDATE) sends ADDTO and REMOVEFROM updates with context positions in sort order, PARTIAL and CONTEXT work for SORT too
 */

const esort = require('./esort');
const contextSearch = require('./context-search');

module.exports = function (server) {
    // RFC 5267 section 4.1: CONTEXT=SORT means SORT and the extended SORT syntax of section 3. The updating
    // contexts are shared with CONTEXT=SEARCH, so that is loaded (and advertised) as well
    esort(server);
    contextSearch(server);

    server.registerCapability('CONTEXT=SORT');
    server.contextSort = true;
};
