'use strict';

const { addThreadAlgorithm } = require('../threading');

/**
 * @help Adds THREAD=REFERENCES [RFC5256] capability
 *
 * THREAD: https://tools.ietf.org/html/rfc5256
 *
 * Additional commands:
 * - THREAD REFERENCES
 * - UID THREAD REFERENCES
 */
module.exports = function (server) {
    addThreadAlgorithm(server, 'REFERENCES');
};
