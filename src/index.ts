import createServer, { TAG_REGEX, IMAPServer, IMAPConnection } from './server.js';

export { TAG_REGEX, IMAPServer, IMAPConnection };

export type {
    Attribute,
    ParsedCommand,
    IMAPResponse,
    Notification,
    Callback,
    CommandHandler,
    CommandOptions,
    Plugin,
    IMAPError,
    Message,
    Mailbox,
    StorageNamespace,
    UserData,
    IMAPServerOptions
} from './types.js';
export type { ScriptRule, ScriptContext, ScriptEvent, ScriptBytes, ScriptHandle } from './script.js';

// `imapkit(options)` creates a server. TAG_REGEX was a property of the CommonJS export, it and the
// classes are properties of the factory with both module formats
const imapkit = Object.assign(createServer, { TAG_REGEX, IMAPServer, IMAPConnection });

export default imapkit;
