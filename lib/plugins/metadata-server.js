'use strict';

const { setup } = require('./metadata');

/**
 * @help Adds METADATA-SERVER [RFC5464] capability, like METADATA but
 * @help only for server annotations (mailbox name ""). With METADATA
 * @help also loaded, only METADATA is advertised
 */

module.exports = function (server) {
    setup(server, false);
};
