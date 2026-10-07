'use strict';

const { processStore } = require('./store');

module.exports = (connection, parsed, data, callback) => processStore(true, connection, parsed, data, callback);
