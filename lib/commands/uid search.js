'use strict';

const { processSearch } = require('./search');

module.exports = (connection, parsed, data, callback) => processSearch(true, connection, parsed, data, callback);
