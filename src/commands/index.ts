// Built-in command handlers by command name

import appendCommand from './append.js';
import capabilityCommand from './capability.js';
import checkCommand from './check.js';
import closeCommand from './close.js';
import copyCommand from './copy.js';
import createCommand from './create.js';
import deleteCommand from './delete.js';
import examineCommand from './examine.js';
import expungeCommand from './expunge.js';
import fetchCommand from './fetch.js';
import listCommand from './list.js';
import loginCommand from './login.js';
import logoutCommand from './logout.js';
import lsubCommand from './lsub.js';
import noopCommand from './noop.js';
import renameCommand from './rename.js';
import searchCommand from './search.js';
import selectCommand from './select.js';
import statusCommand from './status.js';
import storeCommand from './store.js';
import subscribeCommand from './subscribe.js';
import uidCopyCommand from './uid-copy.js';
import uidFetchCommand from './uid-fetch.js';
import uidSearchCommand from './uid-search.js';
import uidStoreCommand from './uid-store.js';
import unsubscribeCommand from './unsubscribe.js';

import type { CommandHandler } from '../types.js';

export const commands: Record<string, CommandHandler> = {
    APPEND: appendCommand,
    CAPABILITY: capabilityCommand,
    CHECK: checkCommand,
    CLOSE: closeCommand,
    COPY: copyCommand,
    CREATE: createCommand,
    DELETE: deleteCommand,
    EXAMINE: examineCommand,
    EXPUNGE: expungeCommand,
    FETCH: fetchCommand,
    LIST: listCommand,
    LOGIN: loginCommand,
    LOGOUT: logoutCommand,
    LSUB: lsubCommand,
    NOOP: noopCommand,
    RENAME: renameCommand,
    SEARCH: searchCommand,
    SELECT: selectCommand,
    STATUS: statusCommand,
    STORE: storeCommand,
    SUBSCRIBE: subscribeCommand,
    'UID COPY': uidCopyCommand,
    'UID FETCH': uidFetchCommand,
    'UID SEARCH': uidSearchCommand,
    'UID STORE': uidStoreCommand,
    UNSUBSCRIBE: unsubscribeCommand
};
