'use strict';

/**
 * @help Adds QRESYNC [RFC7162] capability, loads CONDSTORE and ENABLE as well
 * @help After ENABLE QRESYNC: SELECT/EXAMINE (QRESYNC (...)), UID FETCH (CHANGEDSINCE n VANISHED),
 * @help and VANISHED responses instead of EXPUNGE
 */

const fetchHandlers = require('../commands/handlers/fetch');
const { isExpungeNotification, toVanished } = require('../vanished');

// RFC 7162 section 7: mod-sequence-value is a positive unsigned 63-bit integer
const MAX_MODSEQ = 9223372036854775807n;
// RFC 3501 section 9: nz-number, and UIDs and UIDVALIDITY values are 32-bit
const MAX_UID = 4294967295;
// RFC 3501 section 9: sequence-set, here without "*" (RFC 7162 section 7: known-uids, known-sequence-set, known-uid-set)
const SEQUENCE_SET = /^[1-9]\d{0,9}(:[1-9]\d{0,9})?(,[1-9]\d{0,9}(:[1-9]\d{0,9})?)*$/;

// commands that report expunged messages, their tagged OK carries the new HIGHESTMODSEQ (RFC 7162 sections 3.2.7
// and 3.2.9, RFC 6851 section 4.4). CLOSE MUST NOT (RFC 7162 section 3.2.8)
// REPLACE removes the replaced message as if with UID EXPUNGE (RFC 8508 section 4.5)
const EXPUNGING_COMMANDS = new Set(['EXPUNGE', 'UID EXPUNGE', 'MOVE', 'UID MOVE', 'REPLACE', 'UID REPLACE']);

module.exports = function (server) {
    server.registerCapability('QRESYNC');
    if (server.enableAvailable.indexOf('QRESYNC') < 0) {
        server.enableAvailable.push('QRESYNC');
    }

    // RFC 8437 section 4.1: UNAUTHENTICATE ends what ENABLE QRESYNC enabled (the ENABLE plugin clears the list)
    server.resetHandlers.push(connection => {
        connection.qresyncExpunged = false;
    });

    // mod-sequence each expunged message was removed with
    const expungeModseq = new WeakMap();

    const isQresync = connection => !!(connection.enabled && connection.enabled.indexOf('QRESYNC') >= 0);
    const { isEnabled: isCondstore, getHighestModseq } = server.condstore;

    // Expunged UID ranges with their mod-sequences, oldest first (RFC 7162 section 5.3), and the mod-sequence after which
    // all expunges are remembered. Messages missing from the initial storage were expunged at an unknown time
    // before. The record belongs to one UIDVALIDITY, as nothing needs to be kept once it changes
    const getExpunged = (mailbox, since) => {
        if (!mailbox.qresyncExpunged || mailbox.qresyncExpunged.uidvalidity !== mailbox.uidvalidity) {
            mailbox.qresyncExpunged = { uidvalidity: mailbox.uidvalidity, since: since || getHighestModseq(mailbox), list: [] };
        }
        return mailbox.qresyncExpunged;
    };

    // start remembering expunges for the mailboxes of the storage once their messages have mod-sequences
    const indexFolders = server.indexFolders;
    server.indexFolders = function () {
        const result = indexFolders.apply(this, arguments);
        Object.keys(this.folderCache).forEach(path => getExpunged(this.folderCache[path]));
        return result;
    };

    // CONDSTORE has already incremented HIGHESTMODSEQ for this removal, the expunged UIDs get that value
    // (RFC 7162 section 3.2)
    server.on('expunge', (mailbox, messages, connection) => {
        const modseq = getHighestModseq(mailbox);
        const list = getExpunged(mailbox, modseq - 1).list;
        messages.forEach(message => {
            // consecutive UIDs expunged together are kept as one range, so the history stays small even in long test
            // runs. It is never trimmed: the server keeps everything since it started (RFC 7162 section 5.3)
            const last = list[list.length - 1];
            if (last && last.modseq === modseq && last.to + 1 === message.uid) {
                last.to = message.uid;
            } else {
                list.push({ from: message.uid, to: message.uid, modseq });
            }
            expungeModseq.set(message, modseq);
        });
        if (connection) {
            connection.qresyncExpunged = true;
        }
    });

    /**
     * Lists the UIDs of a set that were expunged after a mod-sequence (RFC 7162 sections 3.2.5.1 and 3.2.6)
     *
     * @param {Object} mailbox Mailbox object
     * @param {Array} messages Messages of the mailbox as the session sees them, these are not reported
     * @param {Array} ranges Ascending UID ranges as [from, to] pairs
     * @param {Number} modseq Mod-sequence the client knows
     * @param {Number} [knownUpTo] The client knows about all expunges up to this UID (message sequence match data)
     * @return {String} sequence set of the UIDs, empty if there are none
     */
    const getVanished = (mailbox, messages, ranges, modseq, knownUpTo) => {
        const { since, list } = getExpunged(mailbox);

        let candidates;
        if (modseq >= since) {
            // all expunges after the client's mod-sequence are remembered. Message sequence match data only helps
            // when they are not, so it is not used here (RFC 7162 section 5.3)
            candidates = intersectRanges(mergeRanges(list.filter(entry => entry.modseq > modseq).map(entry => [entry.from, entry.to])), ranges);
        } else {
            // RFC 7162 section 3.2.6: for a mod-sequence older than the remembered expunges, the server MUST behave as
            // if asked to report all expunged messages of the set: every UID below UIDNEXT that is not in the mailbox,
            // except what the sequence match data shows the client knows
            candidates = intersectRanges(ranges, [[(knownUpTo || 0) + 1, mailbox.uidnext - 1]]);
        }

        // messages the session still sees are left out, an expunge that the session has not been told about yet is
        // reported with VANISHED without EARLIER
        return subtractUids(candidates, messages)
            .map(range => (range[0] === range[1] ? String(range[0]) : range[0] + ':' + range[1]))
            .join(',');
    };

    const sendBad = (connection, parsed, data, callback, message) => {
        connection.sendStatus(parsed, data, 'BAD', message, false, 'QRESYNC FAILED');
        return callback();
    };

    // Wraps an existing command handler. Commands that are not available are left alone
    const wrapHandler = (command, wrapper) => {
        const prevHandler = server.getCommandHandler(command);
        if (!prevHandler) {
            return;
        }
        server.setCommandHandler(command, (connection, parsed, data, callback) => wrapper(prevHandler, connection, parsed, data, callback));
    };

    // RFC 7162 section 3.2.5: SELECT/EXAMINE mailbox (QRESYNC (uidvalidity mod-sequence-value [known-uids] [seq-match-data]))
    const selectWrapper = (prevHandler, connection, parsed, data, callback) => {
        const params = parsed.attributes && parsed.attributes[1];
        const isQresyncParam = param => isAtom(param, 'QRESYNC');
        const position = Array.isArray(params) ? params.findIndex(isQresyncParam) : -1;
        if (position < 0) {
            return prevHandler(connection, parsed, data, callback);
        }

        if (!isQresync(connection)) {
            return sendBad(connection, parsed, data, callback, 'QRESYNC parameter requires ENABLE QRESYNC');
        }
        if (params.findLastIndex(isQresyncParam) !== position) {
            return sendBad(connection, parsed, data, callback, 'QRESYNC parameter can be used only once');
        }

        let qresync;
        try {
            qresync = parseQresyncParam(params[position + 1]);
        } catch (err) {
            return sendBad(connection, parsed, data, callback, err.message);
        }

        params.splice(position, 2);
        if (!params.length) {
            parsed.attributes.splice(1, 1);
        }
        parsed.qresync = qresync;

        prevHandler(connection, parsed, data, callback);
    };

    wrapHandler('SELECT', selectWrapper);
    wrapHandler('EXAMINE', selectWrapper);

    // RFC 7162 section 3.2.6: the VANISHED UID FETCH modifier
    const fetchWrapper = (isUid, prevHandler, connection, parsed, data, callback) => {
        const modifiers = parsed.attributes && parsed.attributes[2];
        const isVanished = modifier => isAtom(modifier, 'VANISHED');
        const position = Array.isArray(modifiers) ? modifiers.findIndex(isVanished) : -1;
        if (position < 0) {
            return prevHandler(connection, parsed, data, callback);
        }

        if (!isUid) {
            return sendBad(connection, parsed, data, callback, 'VANISHED is only allowed with UID FETCH');
        }
        if (!isQresync(connection)) {
            return sendBad(connection, parsed, data, callback, 'VANISHED requires ENABLE QRESYNC');
        }
        if (modifiers.findLastIndex(isVanished) !== position) {
            return sendBad(connection, parsed, data, callback, 'VANISHED can be used only once');
        }
        if (!modifiers.some(modifier => isAtom(modifier, 'CHANGEDSINCE'))) {
            return sendBad(connection, parsed, data, callback, 'VANISHED requires CHANGEDSINCE');
        }

        modifiers.splice(position, 1);
        parsed.qresyncVanished = true;

        prevHandler(connection, parsed, data, callback);
    };

    wrapHandler('FETCH', fetchWrapper.bind(null, false));
    wrapHandler('UID FETCH', fetchWrapper.bind(null, true));

    // RFC 7162 section 3.2.10: after ENABLE QRESYNC, expunges are reported with VANISHED instead of EXPUNGE.
    // Consecutive EXPUNGE notifications become one VANISHED response
    server.connectionHandlers.push(connection => {
        const prepareNotifications = connection.prepareNotifications;
        connection.prepareNotifications = function (queue) {
            queue = prepareNotifications.call(this, queue);
            return isQresync(this) ? toVanished(queue) : queue;
        };
    });

    // Sends a VANISHED (EARLIER) response, if there is anything to report
    const sendVanishedEarlier = (connection, uids, parsed, data) => {
        if (!uids) {
            return;
        }
        connection.send(
            {
                tag: '*',
                command: 'VANISHED',
                attributes: [[{ type: 'ATOM', value: 'EARLIER' }], { type: 'SEQUENCE', value: uids }]
            },
            'VANISHED EARLIER',
            parsed,
            data
        );
    };

    // RFC 7162 section 3.2.5.1: after SELECT/EXAMINE (QRESYNC), expunges and flag changes since the given mod-sequence
    const sendQresyncChanges = (connection, parsed, data) => {
        const mailbox = connection.selectedMailbox;
        const qresync = parsed.qresync;
        if (qresync.uidvalidity !== mailbox.uidvalidity) {
            // RFC 7162 section 3.2.5: ignore the remaining parameters if UIDVALIDITY does not match
            return;
        }

        // without known UIDs, the client is treated as if it sent 1:<UIDNEXT - 1>, nothing for an unused mailbox
        const ranges = qresync.knownUids || (mailbox.uidnext > 1 ? [[1, mailbox.uidnext - 1]] : []);

        // RFC 7162 section 3.2.5.2: the last pair of sequence number and UID that still match tells up to which
        // UID the client knows about all expunges, the first pair that does not match ends the comparison
        let knownUpTo = 0;
        if (qresync.seqMatch) {
            const uids = iterateRanges(qresync.seqMatch.uids);
            for (const seq of iterateRanges(qresync.seqMatch.sequences)) {
                const uid = uids.next().value;
                const message = mailbox.messages[seq - 1];
                if (!message || message.uid !== uid) {
                    break;
                }
                knownUpTo = uid;
            }
        }

        // VANISHED (EARLIER) MUST come before the FETCH responses (RFC 7162 section 3.2.6)
        sendVanishedEarlier(connection, getVanished(mailbox, mailbox.messages, ranges, qresync.modseq, knownUpTo), parsed, data);

        const getFlags = server.fetchHandlers.FLAGS || fetchHandlers.FLAGS;
        mailbox.messages.forEach((message, i) => {
            if (message.MODSEQ <= qresync.modseq || !inRanges(ranges, message.uid)) {
                return;
            }
            // flag changes MUST include the UID (RFC 7162 section 3.2.5.1)
            connection.send(
                {
                    tag: '*',
                    attributes: [
                        i + 1,
                        { type: 'ATOM', value: 'FETCH' },
                        [
                            { type: 'ATOM', value: 'UID' },
                            message.uid,
                            { type: 'ATOM', value: 'FLAGS' },
                            getFlags(connection, message, { type: 'ATOM', value: 'FLAGS' }),
                            { type: 'ATOM', value: 'MODSEQ' },
                            [message.MODSEQ]
                        ]
                    ]
                },
                'QRESYNC FETCH',
                parsed,
                data,
                message
            );
        });
    };

    const highestModseqCode = modseq => ({ type: 'SECTION', section: [{ type: 'ATOM', value: 'HIGHESTMODSEQ' }, modseq] });

    server.outputHandlers.push((connection, response, description, parsed, data) => {
        if (!parsed || !response || response.tag === '+') {
            return;
        }
        const isTagged = response.tag !== '*' && response.tag === parsed.tag;

        // UID FETCH (VANISHED): VANISHED (EARLIER) comes before the first FETCH response, or before the tagged OK
        if (parsed.qresyncVanished && ((response.tag === '*' && description === 'UID FETCH') || (isTagged && response.command === 'OK'))) {
            parsed.qresyncVanished = false;
            const mailbox = connection.selectedMailbox;
            const ranges = parseUidSet(parsed.attributes[0].value, mailbox.uidnext - 1);
            if (ranges) {
                sendVanishedEarlier(connection, getVanished(mailbox, connection.getSessionMessages(), ranges, parsed.changedsince), parsed, data);
            }
            return;
        }

        if (!isTagged) {
            return;
        }

        if (parsed.qresync && response.command === 'OK' && (description === 'SELECT' || description === 'EXAMINE') && connection.selectedMailbox) {
            sendQresyncChanges(connection, parsed, data);
            return;
        }

        const expunged = connection.qresyncExpunged;
        connection.qresyncExpunged = false;

        // HIGHESTMODSEQ in the tagged OK once messages were expunged, RFC 7162 sections 3.2.7 and 3.2.9 require it
        // with QRESYNC enabled, RFC 6851 section 4.4 for MOVE
        if (
            expunged &&
            response.command === 'OK' &&
            EXPUNGING_COMMANDS.has(String(parsed.command).toUpperCase()) &&
            connection.selectedMailbox &&
            isCondstore(connection)
        ) {
            const hasCode = response.attributes && response.attributes[0] && response.attributes[0].type === 'SECTION';
            if (!hasCode) {
                response.attributes = [highestModseqCode(getHighestModseq(connection.selectedMailbox))].concat(response.attributes || []);
            }
            return;
        }

        // RFC 7162 section 3.2: while expunges are held back (FETCH, STORE, SEARCH), the client must not take a
        // MODSEQ it got as the new HIGHESTMODSEQ, so tell it a value below the mod-sequence of the pending expunges
        if (isCondstore(connection)) {
            let lowest = 0;
            connection.notificationQueue.forEach(notification => {
                const modseq = isExpungeNotification(notification) && expungeModseq.get(notification.message);
                if (modseq && (!lowest || modseq < lowest)) {
                    lowest = modseq;
                }
            });
            if (lowest > 1) {
                connection.send(
                    {
                        tag: '*',
                        command: 'OK',
                        attributes: [highestModseqCode(lowest - 1), { type: 'TEXT', value: 'Expunges not reported yet' }]
                    },
                    'QRESYNC HIGHESTMODSEQ',
                    parsed,
                    data
                );
            }
        }
    });
};

function isAtom(value, name) {
    return !!value && value.type === 'ATOM' && String(value.value).toUpperCase() === name;
}

/**
 * Parses a sequence set without "*" into [from, to] ranges as written
 *
 * @param {Object} value Parsed argument
 * @param {String} name Name of the argument for the error message
 * @return {Array} ranges
 */
function parseSequenceSet(value, name) {
    if (!value || Array.isArray(value) || ['ATOM', 'SEQUENCE'].indexOf(value.type) < 0 || !SEQUENCE_SET.test(value.value)) {
        throw new Error('Invalid QRESYNC ' + name + ', a sequence set without "*" expected');
    }
    return value.value.split(',').map(part => {
        const range = part.split(':').map(Number);
        if (range.some(number => number > MAX_UID)) {
            throw new Error('Invalid QRESYNC ' + name + ', number out of range');
        }
        return [range[0], range.length > 1 ? range[1] : range[0]];
    });
}

/**
 * Parses the UID set of UID FETCH, "*" stands for the highest UID the mailbox may have used
 *
 * @param {String} value Sequence set
 * @param {Number} star Value for "*"
 * @return {Array|false} ranges ordered as [low, high], or false for other forms (e.g. "$" of SEARCHRES)
 */
function parseUidSet(value, star) {
    if (!/^[\d*:,]+$/.test(String(value))) {
        return false;
    }
    return mergeRanges(
        String(value)
            .split(',')
            .map(part => part.split(':').map(number => (number === '*' ? star : Number(number))))
    );
}

// Intersection of two lists of ascending, non-overlapping ranges
function intersectRanges(a, b) {
    const result = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        const from = Math.max(a[i][0], b[j][0]);
        const to = Math.min(a[i][1], b[j][1]);
        if (from <= to) {
            result.push([from, to]);
        }
        if (a[i][1] < b[j][1]) {
            i++;
        } else {
            j++;
        }
    }
    return result;
}

// Removes the UIDs of messages (ordered by UID) from ascending ranges, walking both lists once
function subtractUids(ranges, messages) {
    const result = [];
    let i = 0;
    ranges.forEach(([from, to]) => {
        let next = from;
        while (i < messages.length && messages[i].uid < from) {
            i++;
        }
        for (; i < messages.length && messages[i].uid <= to; i++) {
            if (messages[i].uid > next) {
                result.push([next, messages[i].uid - 1]);
            }
            next = messages[i].uid + 1;
        }
        if (next <= to) {
            result.push([next, to]);
        }
    });
    return result;
}

/**
 * Orders the ends of every range and merges overlapping or adjacent ranges, so that a UID is listed once
 *
 * @param {Array} ranges List of [from, to] or [number] ranges
 * @return {Array} ascending [low, high] ranges
 */
function mergeRanges(ranges) {
    const sorted = ranges.map(range => [Math.min(...range), Math.max(...range)]).sort((a, b) => a[0] - b[0]);
    const result = [];
    sorted.forEach(range => {
        const last = result[result.length - 1];
        if (last && range[0] <= last[1] + 1) {
            last[1] = Math.max(last[1], range[1]);
        } else {
            result.push(range);
        }
    });
    return result;
}

// Lists the numbers of ascending ranges one by one
function* iterateRanges(ranges) {
    for (const [from, to] of ranges) {
        for (let i = from; i <= to; i++) {
            yield i;
        }
    }
}

/**
 * Checks that a sequence set lists its numbers in ascending order and counts them
 */
function countAscending(ranges, name) {
    let last = 0;
    let count = 0;
    ranges.forEach(([from, to]) => {
        if (from > to || from <= last) {
            throw new Error('Invalid QRESYNC ' + name + ', numbers must be in ascending order');
        }
        last = to;
        count += to - from + 1;
    });
    return count;
}

/**
 * Validates the value of the QRESYNC SELECT/EXAMINE parameter (RFC 7162 section 7):
 * "(" uidvalidity SP mod-sequence-value [SP known-uids] [SP seq-match-data] ")"
 *
 * @param {Array} value Parsed parameter value
 * @return {Object} `{ uidvalidity, modseq, knownUids, seqMatch }`
 */
function parseQresyncParam(value) {
    if (!Array.isArray(value) || value.length < 2 || value.length > 4) {
        throw new Error('QRESYNC expects (uidvalidity modseq [known-uids] [(known-sequence-set known-uid-set)])');
    }

    const [uidvalidity, modseq] = value;
    // uidvalidity = nz-number
    if (!isNumberAtom(uidvalidity) || !/^[1-9]\d*$/.test(uidvalidity.value) || Number(uidvalidity.value) > MAX_UID) {
        throw new Error('Invalid QRESYNC uidvalidity, a non-zero number expected');
    }
    // mod-sequence-value = 1*DIGIT, 1 <= n <= 9,223,372,036,854,775,807
    if (!isNumberAtom(modseq) || !/^\d+$/.test(modseq.value) || BigInt(modseq.value) < 1n || BigInt(modseq.value) > MAX_MODSEQ) {
        throw new Error('Invalid QRESYNC mod-sequence, a positive number expected');
    }

    const result = {
        uidvalidity: Number(uidvalidity.value),
        modseq: Number(modseq.value),
        knownUids: false,
        seqMatch: false
    };

    const rest = value.slice(2);
    if (rest.length && !Array.isArray(rest[0])) {
        result.knownUids = mergeRanges(parseSequenceSet(rest.shift(), 'known-uids'));
    }

    if (rest.length) {
        const seqMatch = rest.shift();
        if (!Array.isArray(seqMatch) || seqMatch.length !== 2 || rest.length) {
            throw new Error('Invalid QRESYNC parameters, (known-sequence-set known-uid-set) expected last');
        }
        // RFC 7162 section 3.2.5.2: both sets MUST be in ascending order, the Nth number of one matches the Nth of the other
        const sequences = parseSequenceSet(seqMatch[0], 'known-sequence-set');
        const uids = parseSequenceSet(seqMatch[1], 'known-uid-set');
        const count = countAscending(sequences, 'known-sequence-set');
        if (countAscending(uids, 'known-uid-set') !== count) {
            throw new Error('Invalid QRESYNC sets, known-sequence-set and known-uid-set must have as many numbers');
        }
        result.seqMatch = { sequences, uids };
    }

    return result;
}

function isNumberAtom(value) {
    return !!value && value.type === 'ATOM';
}

function inRanges(ranges, uid) {
    return ranges.some(range => uid >= range[0] && uid <= range[1]);
}

// RFC 7162 section 3.2.3: a QRESYNC server implements CONDSTORE and ENABLE, these are loaded first
module.exports.requires = ['ENABLE', 'CONDSTORE'];
