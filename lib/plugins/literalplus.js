'use strict';

/**
 * @help Enables LITERAL+ [RFC7888] capability
 * @help Can not be loaded with LITERAL-
 */

module.exports = function (server) {
    // RFC 7888 section 5: servers MUST NOT advertise both LITERAL+ and LITERAL-
    if (server.capabilities['LITERAL-']) {
        throw new Error('LITERAL+ can not be enabled together with LITERAL-');
    }
    server.registerCapability('LITERAL+');
    server.literalPlus = true;
};
