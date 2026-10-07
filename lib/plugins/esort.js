'use strict';

/**
 * @help Adds ESORT [RFC5267] capability, loads SORT and ESEARCH as well
 * @help SORT and UID SORT take the RETURN (MIN MAX ALL COUNT) result options and answer with ESEARCH, results are in sort order
 */

const sort = require('./sort');
const esearch = require('./esearch');
const { buildEsearchResponse, selectReturned } = require('../esearch');

const isSort = command => command === 'SORT' || command === 'UID SORT';

module.exports = function (server) {
    if (server.esortLoaded) {
        return;
    }
    server.esortLoaded = true;

    sort(server);
    esearch(server);

    server.registerCapability('ESORT');

    // RFC 5267 section 3: extended-sort = ["UID" SP] "SORT" search-return-opts SP sort-criteria SP search-criteria
    server.acceptSearchReturn('SORT');
    server.acceptSearchReturn('UID SORT');

    // RFC 5267 section 4.1: the CONTEXT, UPDATE and PARTIAL result options of SORT come with CONTEXT=SORT. PARTIAL
    // is also defined for the PARTIAL capability (RFC 9394 section 3.1)
    server.searchReturnChecks.push((options, connection, parsed, names) => {
        if (!isSort((parsed.command || '').toUpperCase()) || server.contextSort) {
            return false;
        }
        const name = ['CONTEXT', 'UPDATE', 'PARTIAL'].find(key => names.has(key) && (key !== 'PARTIAL' || !server.partialRangeLast));
        return !!name && name + ' is not supported for SORT';
    });

    // Replaces the SORT response of an extended SORT with an ESEARCH response (RFC 5267 section 3)
    server.outputHandlers.push((connection, response, description, parsed, data, extra) => {
        if (!parsed || !parsed.searchReturn || response.tag !== '*' || response.command !== 'SORT' || !isSort(description) || !extra || !extra.sorted) {
            return;
        }
        response.skipResponse = true;

        const options = parsed.searchReturn;
        if (server.isSilentReturn(options)) {
            return;
        }

        // the extra data lists the returned messages, for the MODSEQ of CONDSTORE (RFC 7162 section 3.1.10)
        connection.send(
            buildEsearchResponse(parsed.tag, description === 'UID SORT', extra, options, null, extra.sorted),
            'ESEARCH',
            parsed,
            data,
            Object.assign({}, extra, { list: selectReturned(extra.sorted, options) })
        );
    });
};
