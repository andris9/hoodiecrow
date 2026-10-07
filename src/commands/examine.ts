import { selectMailbox } from './select.js';
import type { Callback, IMAPConnection, ParsedCommand } from '../types.js';

export default function examineCommand(connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) {
    return selectMailbox(connection, parsed, data, callback, true);
}
