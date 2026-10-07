'use strict';

const { copyMessages } = require('./copy');

module.exports = function (connection, parsed, data, callback) {
    return copyMessages(connection, parsed, data, callback, true);
};
