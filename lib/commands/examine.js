'use strict';

const { selectMailbox } = require('./select');

module.exports = function (connection, parsed, data, callback) {
    return selectMailbox(connection, parsed, data, callback, true);
};
