/* basic init file that uses default user */
var _ = require('lodash'), imapper = require('../../lib/server'),
users = require('./testuser-plugin');

module.exports = function (opts) {
	return imapper(_.extend({users: users}, opts || {}));
};
