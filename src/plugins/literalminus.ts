import type { IMAPServer } from '../types.js';

/**
 * @help Enables LITERAL- [RFC7888] capability
 * @help Non-synchronizing literals up to 4096 octets, a larger
 * @help one is dropped and answered with BAD [TOOBIG]
 * @help Can not be loaded with LITERAL+
 */

export default function literalminusPlugin(server: IMAPServer) {
    // RFC 7888 section 5: servers MUST NOT advertise both LITERAL+ and LITERAL-
    if (server.capabilities['LITERAL+']) {
        throw new Error('LITERAL- can not be enabled together with LITERAL+');
    }
    server.registerCapability('LITERAL-');
    // loaded by name, LITERAL+ can not replace it any more (see IMAP4rev2)
    server.impliedLiteralMinus = false;
    server.literalPlus = true;
    server.nonSyncLiteralLimit = 4096;
}
