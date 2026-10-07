'use strict';

const { updateSession } = require('../utf8-session');
const literalMinus = require('./literalminus');

/**
 * @help Adds IMAP4rev2 [RFC9051] capability next to IMAP4rev1 and loads
 * @help the extensions folded into IMAP4rev2 (RFC 9051 Appendix E).
 * @help A session follows RFC 9051 after ENABLE IMAP4rev2, others RFC 3501
 */

// RFC 9051 Appendix A: a client that wants IMAP4rev2 when both revisions are advertised MUST issue "ENABLE IMAP4rev2".
// The ENABLE plugin lists enabled extensions in this spelling
const REV2 = 'IMAP4rev2';

// RFC 9051 section 9 leaves these IMAP4rev1 items out of the search-key, status-att and fetch-att rules (Appendix E
// items 12 and 18), so an IMAP4rev2 session gets BAD for them
const REMOVED_SEARCH_KEYS = new Set(['NEW', 'OLD', 'RECENT', 'UNRECENT']);
const REMOVED_STATUS_ITEMS = new Set(['RECENT']);
// RFC 9051 section 6.3.11 and Appendix E item 3: STATUS DELETED is new in IMAP4rev2 (STATUS SIZE comes with STATUS=SIZE)
const ADDED_STATUS_ITEMS = new Set(['DELETED']);
const REMOVED_FETCH_ITEMS = new Set(['RFC822', 'RFC822.HEADER', 'RFC822.TEXT']);

// RFC 9051 section 2.3.2: keywords that SHOULD be allowed in SEARCH and preserved in APPEND, COPY and MOVE
const KEYWORDS = ['$Forwarded', '$MDNSent', '$Junk', '$NotJunk', '$Phishing'];

// set by setMode() below
const isRev2 = connection => !!connection.imap4rev2;

const atomName = attr => (attr && attr.type === 'ATOM' ? String(attr.value).toUpperCase() : '');

module.exports = function (server) {
    // RFC 9051 Appendix A: advertised together with IMAP4rev1 (capability.js always lists it), so every session
    // starts as IMAP4rev1 (section 7.2.2) and ENABLE switches it (section 6.3.1)
    server.registerCapability('IMAP4rev2');

    // Shared with the ENABLE plugin
    server.enableAvailable = server.enableAvailable || [];
    if (server.enableAvailable.indexOf(REV2) < 0) {
        server.enableAvailable.push(REV2);
    }

    // RFC 9051 section 4.3 and Appendix E item 2: non-synchronizing literals up to 4096 octets (LITERAL-). LITERAL+
    // allows more, so it is kept if it is loaded already, and it can replace this LITERAL- when it is loaded later
    if (!server.capabilities['LITERAL+'] && !server.capabilities['LITERAL-']) {
        literalMinus(server);
        server.impliedLiteralMinus = true;
    }

    // RFC 9051 section 2.3.2: a mailbox that does not allow new keywords (no "\*" in PERMANENTFLAGS) still keeps these
    server.mailboxHandlers.push((server, mailbox) => {
        if (!mailbox.allowPermanentFlags) {
            KEYWORDS.forEach(keyword => server.ensureFlag(mailbox.permanentFlags, keyword));
        }
    });

    // The session follows RFC 9051 once IMAP4rev2 is enabled
    const setMode = connection => {
        const rev2 = (connection.imap4rev2 = !!connection.enabled && connection.enabled.indexOf(REV2) >= 0);
        // UTF-8 in quoted strings and mailbox names (sections 4.3 and 5.1), SEARCH assumes UTF-8 (section 6.4.4)
        updateSession(connection);
        // message/global encapsulates a message like message/rfc822 (sections 6.4.5.1 and 7.5.2)
        connection.messageGlobal = rev2;
        connection.disabledSearchKeys = rev2 ? REMOVED_SEARCH_KEYS : null;
        // literal sizes, partial ranges (parsed by imap-handler), LARGER and SMALLER are number64 (section 9, Appendix E item 1)
        connection.number64 = connection.parserOptions.number64 = rev2;
        connection.disabledStatusItems = rev2 ? REMOVED_STATUS_ITEMS : null;
        // only for this session, an IMAP4rev1 session gets DELETED only from plugins that add it for everyone (QUOTA)
        connection.addedStatusItems = rev2 ? ADDED_STATUS_ITEMS : null;
        if (rev2) {
            // \Recent is deprecated (section 2.3.2, Appendix E item 12), an IMAP4rev2 session does not see it
            connection.getFlags = message => message.flags;
        } else {
            // back to IMAPConnection#getFlags
            delete connection.getFlags;
        }
    };
    server.connectionHandlers.push(setMode);
    // RFC 8437 section 4.1: UNAUTHENTICATE turns ENABLEd extensions off
    server.resetHandlers.push(setMode);

    const sendBad = (connection, parsed, data, callback, text) => {
        connection.sendStatus(parsed, data, 'BAD', text);
        return callback();
    };

    // Wraps the handler of a command, `wrapper(prevHandler, connection, parsed, data, callback)` runs instead
    const wrap = (command, wrapper) => {
        const prevHandler = server.getCommandHandler(command);
        server.setCommandHandler(command, (connection, parsed, data, callback) => wrapper(prevHandler, connection, parsed, data, callback));
    };

    // Appendix E item 17: CHECK was removed, NOOP does the same. Item 19: LSUB was deprecated and left out of the
    // section 9 grammar, LIST (SUBSCRIBED) replaces it
    Object.entries({ CHECK: 'NOOP', LSUB: 'LIST (SUBSCRIBED)' }).forEach(([command, replacement]) => {
        wrap(command, (prevHandler, connection, parsed, data, callback) => {
            if (isRev2(connection)) {
                return sendBad(connection, parsed, data, callback, command + ' is not part of IMAP4rev2, use ' + replacement + ' (RFC 9051 Appendix E)');
            }
            prevHandler(connection, parsed, data, callback);
        });
    });

    // Appendix E item 18: RFC822, RFC822.HEADER and RFC822.TEXT are not fetch-att items any more, BODY[], BODY.PEEK[HEADER]
    // and BODY[TEXT] replace them. RFC822.SIZE stays
    const fetchWrapper = (prevHandler, connection, parsed, data, callback) => {
        const items = (parsed.attributes || [])[1];
        if (isRev2(connection) && [].concat(items || []).some(item => REMOVED_FETCH_ITEMS.has(atomName(item)))) {
            return sendBad(
                connection,
                parsed,
                data,
                callback,
                'RFC822, RFC822.HEADER and RFC822.TEXT are not part of IMAP4rev2, use BODY[] (RFC 9051 Appendix E)'
            );
        }
        prevHandler(connection, parsed, data, callback);
    };
    wrap('FETCH', fetchWrapper);
    wrap('UID FETCH', fetchWrapper);

    // Appendix E item 4 and section 6.4.4: SEARCH answers with ESEARCH, without result options it is RETURN (ALL).
    // The ESEARCH plugin replaces the SEARCH response once `parsed.searchReturn` is set
    const searchWrapper = (prevHandler, connection, parsed, data, callback) => {
        if (isRev2(connection) && atomName((parsed.attributes || [])[0]) !== 'RETURN') {
            parsed.searchReturn = server.parseSearchReturn([], connection, parsed);
        }
        prevHandler(connection, parsed, data, callback);
    };
    wrap('SEARCH', searchWrapper);
    wrap('UID SEARCH', searchWrapper);

    // Appendix E item 9 and section 6.3.2: SELECT and EXAMINE report CLOSED when they close the selected mailbox
    server.closedChecks.push(isRev2);

    // Untagged LIST response for the selected mailbox (section 6.3.2, Appendix E item 10), with accurate attributes.
    // Not a "LIST ITEM" response, that ACL would hide for a mailbox the user may read but not list
    const sendMailboxList = (connection, mailbox, parsed, data) => {
        // the special-use attributes of SPECIAL-USE are mailbox attributes in IMAP4rev2 (section 7.3.1)
        const attributes = mailbox.flags.concat(mailbox['special-use'] || []);
        connection.send(
            {
                tag: '*',
                command: 'LIST',
                attributes: [
                    attributes.map(flag => ({ type: 'ATOM', value: flag })),
                    (server.storage[mailbox.namespace] || {}).separator || null,
                    // the canonical name, converted for the session in IMAPConnection#send
                    { type: 'MAILBOX', value: mailbox.path }
                ]
            },
            'SELECT LIST',
            parsed,
            data,
            mailbox
        );
    };

    server.outputHandlers.push((connection, response, description, parsed, data) => {
        if (!parsed || !response || !isRev2(connection)) {
            return;
        }
        const command = String(parsed.command || '').toUpperCase();
        if (command !== 'SELECT' && command !== 'EXAMINE') {
            return;
        }

        // Appendix E items 11 and 12: the RECENT response and the UNSEEN response code are deprecated
        if (description === command + ' RECENT' || description === command + ' UNSEEN') {
            response.skipResponse = true;
            return;
        }

        if (description === command && response.tag === parsed.tag && response.command === 'OK' && connection.selectedMailbox) {
            sendMailboxList(connection, connection.selectedMailbox, parsed, data);
        }
    });

    server.outputHandlers.push((connection, response, description, parsed, data, extra) => {
        if (description === 'ENABLED' && Array.isArray(extra) && extra.indexOf(REV2) >= 0) {
            setMode(connection);
        }
    });
};

// RFC 9051 Appendix E item 2 lists the extensions that IMAP4rev2 folds in. With them the plugins advertise their own
// capabilities, which RFC 9051 Appendix A suggests for a server that supports both revisions. AUTH=PLAIN is a MUST
// (section 6.1.1). LITERAL- is loaded by the plugin itself, unless LITERAL+ is loaded
module.exports.requires = [
    'ENABLE',
    'NAMESPACE',
    'UNSELECT',
    'UIDPLUS',
    'ESEARCH',
    'SEARCHRES',
    'IDLE',
    'SASL-IR',
    'LIST-EXTENDED',
    'LIST-STATUS',
    'MOVE',
    'BINARY',
    'SPECIAL-USE',
    'STATUS=SIZE',
    'AUTH=PLAIN'
];
