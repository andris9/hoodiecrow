import { copyMessages } from './copy.js';
import type { Callback, IMAPConnection, ParsedCommand } from '../types.js';

export default function uidCopyCommand(connection: IMAPConnection, parsed: ParsedCommand, data: string, callback: Callback) {
    return copyMessages(connection, parsed, data, callback, true);
}
