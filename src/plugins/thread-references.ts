import { addThreadAlgorithm } from '../threading.js';
import type { IMAPServer } from '../types.js';

/**
 * @help Adds THREAD=REFERENCES [RFC5256] capability
 *
 * THREAD: https://tools.ietf.org/html/rfc5256
 *
 * Additional commands:
 * - THREAD REFERENCES
 * - UID THREAD REFERENCES
 */
export default function threadReferencesPlugin(server: IMAPServer) {
    addThreadAlgorithm(server, 'REFERENCES');
}
