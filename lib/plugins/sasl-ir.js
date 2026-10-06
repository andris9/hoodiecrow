'use strict';

/**
 * @help Enables SASL-IR [RFC4959] capability
 */

module.exports = function (server) {
    // Register capability, usable for non authenticated users
    server.registerCapability('SASL-IR', connection => {
        return connection.state === 'Not Authenticated';
    });
};
