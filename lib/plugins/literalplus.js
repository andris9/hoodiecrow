'use strict';

/**
 * @help Enables LITERAL+ [RFC7888] capability
 * @help Can not be loaded with LITERAL-
 */

module.exports = function (server) {
    // RFC 7888 section 5: servers MUST NOT advertise both LITERAL+ and LITERAL-. IMAP4rev2 adds LITERAL- only
    // when LITERAL+ is not loaded, LITERAL+ replaces it then, as it allows more (RFC 9051 section 4.3)
    if (server.capabilities['LITERAL-'] && !server.impliedLiteralMinus) {
        throw new Error('LITERAL+ can not be enabled together with LITERAL-');
    }
    delete server.capabilities['LITERAL-'];
    server.registerCapability('LITERAL+');
    server.literalPlus = true;
    server.nonSyncLiteralLimit = Infinity;
};
