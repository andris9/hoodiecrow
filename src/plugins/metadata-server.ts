import { setup } from './metadata.js';
import type { IMAPServer } from '../types.js';

/**
 * @help Adds METADATA-SERVER [RFC5464] capability, like METADATA but
 * @help only for server annotations (mailbox name ""), loads ENABLE. With METADATA
 * @help also loaded, only METADATA is advertised
 */

export default function metadataServerPlugin(server: IMAPServer) {
    setup(server, false);
}

// RFC 5464 section 4.1: a server that sends unsolicited METADATA responses "MUST support the ENABLE command"
metadataServerPlugin.requires = ['ENABLE'];
