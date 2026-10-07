'use strict';

const { processFetch } = require('./fetch');

module.exports = (connection, parsed, data, callback) => processFetch(true, connection, parsed, data, callback);
