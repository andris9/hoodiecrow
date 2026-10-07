'use strict';

const { addThreadAlgorithm } = require('../threading');

/**
 * @help Adds THREAD=ORDEREDSUBJECT [RFC5256] capability
 *
 * THREAD: https://tools.ietf.org/html/rfc5256
 *
 * Additional commands:
 * - THREAD ORDEREDSUBJECT
 * - UID THREAD ORDEREDSUBJECT
 */
module.exports = function (server) {
    addThreadAlgorithm(server, 'ORDEREDSUBJECT');
};
