import { processFetch } from './fetch.js';
import type { Callback, IMAPConnection, ParsedCommand } from '../types.js';

const uidFetchCommand = (connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) =>
    processFetch(true, connection, parsed, data, callback);

export default uidFetchCommand;
