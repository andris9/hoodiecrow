// Built-in plugins by name (the file name without extension), see load-plugins.ts

import aclPlugin from './acl.js';
import appendlimitPlugin from './appendlimit.js';
import authPlainPlugin from './auth-plain.js';
import binaryPlugin from './binary.js';
import catenatePlugin from './catenate.js';
import compressPlugin from './compress.js';
import condstorePlugin from './condstore.js';
import contextSearchPlugin from './context-search.js';
import contextSortPlugin from './context-sort.js';
import createSpecialUsePlugin from './create-special-use.js';
import enablePlugin from './enable.js';
import esearchPlugin from './esearch.js';
import esortPlugin from './esort.js';
import idPlugin from './id.js';
import idlePlugin from './idle.js';
import imap4rev2Plugin from './imap4rev2.js';
import listExtendedPlugin from './list-extended.js';
import listStatusPlugin from './list-status.js';
import literalminusPlugin from './literalminus.js';
import literalplusPlugin from './literalplus.js';
import logindisabledPlugin from './logindisabled.js';
import messagelimitPlugin from './messagelimit.js';
import metadataPlugin from './metadata.js';
import metadataServerPlugin from './metadata-server.js';
import movePlugin from './move.js';
import multiappendPlugin from './multiappend.js';
import multisearchPlugin from './multisearch.js';
import namespacePlugin from './namespace.js';
import notifyPlugin from './notify.js';
import oauthbearerPlugin from './oauthbearer.js';
import objectidPlugin from './objectid.js';
import partialPlugin from './partial.js';
import previewPlugin from './preview.js';
import qresyncPlugin from './qresync.js';
import quotaPlugin from './quota.js';
import replacePlugin from './replace.js';
import saslIrPlugin from './sasl-ir.js';
import savedatePlugin from './savedate.js';
import savelimitPlugin from './savelimit.js';
import searchresPlugin from './searchres.js';
import sortPlugin from './sort.js';
import sortDisplayPlugin from './sort-display.js';
import specialUsePlugin from './special-use.js';
import starttlsPlugin from './starttls.js';
import statusSizePlugin from './status-size.js';
import threadOrderedsubjectPlugin from './thread-orderedsubject.js';
import threadReferencesPlugin from './thread-references.js';
import uidonlyPlugin from './uidonly.js';
import uidplusPlugin from './uidplus.js';
import unauthenticatePlugin from './unauthenticate.js';
import unselectPlugin from './unselect.js';
import utf8AcceptPlugin from './utf8-accept.js';
import xGmExt1Plugin from './x-gm-ext-1.js';
import xoauth2Plugin from './xoauth2.js';

import type { Plugin } from '../types.js';

export const plugins: Record<string, Plugin> = {
    acl: aclPlugin,
    appendlimit: appendlimitPlugin,
    'auth-plain': authPlainPlugin,
    binary: binaryPlugin,
    catenate: catenatePlugin,
    compress: compressPlugin,
    condstore: condstorePlugin,
    'context-search': contextSearchPlugin,
    'context-sort': contextSortPlugin,
    'create-special-use': createSpecialUsePlugin,
    enable: enablePlugin,
    esearch: esearchPlugin,
    esort: esortPlugin,
    id: idPlugin,
    idle: idlePlugin,
    imap4rev2: imap4rev2Plugin,
    'list-extended': listExtendedPlugin,
    'list-status': listStatusPlugin,
    literalminus: literalminusPlugin,
    literalplus: literalplusPlugin,
    logindisabled: logindisabledPlugin,
    messagelimit: messagelimitPlugin,
    metadata: metadataPlugin,
    'metadata-server': metadataServerPlugin,
    move: movePlugin,
    multiappend: multiappendPlugin,
    multisearch: multisearchPlugin,
    namespace: namespacePlugin,
    notify: notifyPlugin,
    oauthbearer: oauthbearerPlugin,
    objectid: objectidPlugin,
    partial: partialPlugin,
    preview: previewPlugin,
    qresync: qresyncPlugin,
    quota: quotaPlugin,
    replace: replacePlugin,
    'sasl-ir': saslIrPlugin,
    savedate: savedatePlugin,
    savelimit: savelimitPlugin,
    searchres: searchresPlugin,
    sort: sortPlugin,
    'sort-display': sortDisplayPlugin,
    'special-use': specialUsePlugin,
    starttls: starttlsPlugin,
    'status-size': statusSizePlugin,
    'thread-orderedsubject': threadOrderedsubjectPlugin,
    'thread-references': threadReferencesPlugin,
    uidonly: uidonlyPlugin,
    uidplus: uidplusPlugin,
    unauthenticate: unauthenticatePlugin,
    unselect: unselectPlugin,
    'utf8-accept': utf8AcceptPlugin,
    'x-gm-ext-1': xGmExt1Plugin,
    xoauth2: xoauth2Plugin
};
