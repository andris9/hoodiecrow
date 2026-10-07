import type { IMAPConnection, IMAPServer } from '../types.js';

/**
 * @help Enables SASL-IR [RFC4959] capability
 */

export default function saslIrPlugin(server: IMAPServer) {
    // Register capability, usable for non authenticated users
    server.registerCapability('SASL-IR', (connection: IMAPConnection) => {
        return connection.state === 'Not Authenticated';
    });
}
