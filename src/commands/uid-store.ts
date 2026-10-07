import { processStore } from './store.js';
import type { Callback, IMAPConnection, ParsedCommand } from '../types.js';

const uidStoreCommand = (connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) =>
    processStore(true, connection, parsed, data, callback);

export default uidStoreCommand;
