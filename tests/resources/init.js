/* basic init file that uses default user */
var _ = require('lodash'), imapper = require('../../lib/server'),
users = require('./testuser-plugin'), storage = require('imapper-storage-memory');

module.exports = function (opts) {
	return imapper(_.extend({users: users, storage: storage}, opts || {}));
};
