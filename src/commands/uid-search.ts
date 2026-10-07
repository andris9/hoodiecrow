import { processSearch } from './search.js';
import type { Callback, IMAPConnection, ParsedCommand } from '../types.js';

const uidSearchCommand = (connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) =>
    processSearch(true, connection, parsed, data, callback);

export default uidSearchCommand;
