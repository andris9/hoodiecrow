import { addThreadAlgorithm } from '../threading.js';
import type { IMAPServer } from '../types.js';

/**
 * @help Adds THREAD=ORDEREDSUBJECT [RFC5256] capability
 *
 * THREAD: https://tools.ietf.org/html/rfc5256
 *
 * Additional commands:
 * - THREAD ORDEREDSUBJECT
 * - UID THREAD ORDEREDSUBJECT
 */
export default function threadOrderedsubjectPlugin(server: IMAPServer) {
    addThreadAlgorithm(server, 'ORDEREDSUBJECT');
}
