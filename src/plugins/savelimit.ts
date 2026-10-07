import { getLimit, addSaveLimit } from './messagelimit.js';
import type { IMAPServer } from '../types.js';

/**
 * @help Adds SAVELIMIT [RFC9738] capability, advertised as SAVELIMIT=<n>
 * @help Server option "messageLimit" sets n (default 1000). COPY and APPEND (MULTIAPPEND)
 * @help of more messages fail with NO [MESSAGELIMIT ...], other commands are not limited.
 * @help Can not be loaded with MESSAGELIMIT
 *
 * SAVELIMIT: https://www.rfc-editor.org/rfc/rfc9738
 */
export default function savelimitPlugin(server: IMAPServer) {
    // RFC 9738 section 3: a server that only limits COPY and APPEND (and their UID variants) advertises SAVELIMIT
    const limit = getLimit(server, 'SAVELIMIT');
    server.registerCapability('SAVELIMIT=' + limit);
    addSaveLimit(server, limit);
}
