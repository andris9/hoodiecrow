import { setup } from './metadata.js';
import type { IMAPServer } from '../types.js';

/**
 * @help Adds METADATA-SERVER [RFC5464] capability, like METADATA but
 * @help only for server annotations (mailbox name ""). With METADATA
 * @help also loaded, only METADATA is advertised
 */

export default function metadataServerPlugin(server: IMAPServer) {
    setup(server, false);
}
