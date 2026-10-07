'use strict';

// THREAD and UID THREAD (RFC 5256 section 3) and the ORDEREDSUBJECT and REFERENCES algorithms

const { states } = require('./command-states');
const { getMessageData } = require('./mimeparser');
const { collationKey, baseSubject, sentTime, parseMessageIds, searchMessages } = require('./sorting');

/**
 * Creates a thread tree node. A node without a message is a dummy
 */
function createNode(entry) {
    return { entry: entry || null, parent: null, children: [] };
}

// Sent date order with the sequence number as tie-breaker (RFC 5256 section 2.2). A dummy is
// ordered by its first child
function compareNodes(a, b) {
    while (!a.entry && a.children.length) {
        a = a.children[0];
    }
    while (!b.entry && b.children.length) {
        b = b.children[0];
    }
    return a.entry.date - b.entry.date || a.entry.seq - b.entry.seq;
}

/**
 * Lists the nodes of trees in pre-order (parents before their children). Iterative, as message
 * references can make a thread as deep as the mailbox is large.
 *
 * @param {Array} nodes Top level nodes
 * @return {Array} All nodes
 */
function preOrder(nodes) {
    const list = [];
    const stack = nodes.slice().reverse();
    while (stack.length) {
        const node = stack.pop();
        list.push(node);
        for (let i = node.children.length - 1; i >= 0; i--) {
            stack.push(node.children[i]);
        }
    }
    return list;
}

/**
 * Serializes thread nodes (RFC 5256 section 5): every thread is a thread-list, a node is followed by its
 * only child, or by one thread-list per child when it has more. A dummy has no number of its own.
 *
 * @param {Array} roots Top level nodes
 * @param {Boolean} isUid If true, list UIDs instead of sequence numbers
 * @return {String} thread-data without the "THREAD" keyword
 */
function formatThreads(roots, isUid) {
    const output = [];
    // strings to write and nodes to expand, the next one is at the end
    const stack = [];
    const pushLists = nodes => {
        for (let i = nodes.length - 1; i >= 0; i--) {
            stack.push(')', nodes[i], '(');
        }
    };
    pushLists(roots);
    while (stack.length) {
        const item = stack.pop();
        if (typeof item === 'string') {
            output.push(item);
            continue;
        }
        const children = item.children;
        if (children.length === 1) {
            stack.push(children[0]);
        } else {
            pushLists(children);
        }
        if (item.entry) {
            if (children.length) {
                stack.push(' ');
            }
            output.push(isUid ? item.entry.message.uid : item.entry.seq);
        }
    }
    return output.join('');
}

/**
 * ORDEREDSUBJECT (RFC 5256 section 3): messages grouped by base subject, every thread is its first
 * message with the others as children, threads ordered by the sent date of their first message
 *
 * @param {Array} entries Searched messages as `{ message, seq, date, subject }`
 * @return {Array} Top level nodes
 */
function orderedSubject(entries) {
    const compareSubjects = (a, b) => (a.subject.id < b.subject.id ? -1 : a.subject.id > b.subject.id ? 1 : 0);
    const sorted = entries.slice().sort((a, b) => compareSubjects(a, b) || a.date - b.date || a.seq - b.seq);
    const threads = [];
    let current = null;
    for (const entry of sorted) {
        if (current && current.entry.subject.id === entry.subject.id) {
            current.children.push(createNode(entry));
        } else {
            current = createNode(entry);
            threads.push(current);
        }
    }
    return threads.sort(compareNodes);
}

/**
 * REFERENCES (RFC 5256 section 3), steps 1 to 6
 *
 * @param {Array} entries Searched messages in mailbox order as `{ message, seq, date, subject }`
 * @return {Array} Top level nodes
 */
function references(entries) {
    const byId = new Map();
    const all = [];

    const getNode = id => {
        if (!byId.has(id)) {
            const node = createNode();
            byId.set(id, node);
            all.push(node);
        }
        return byId.get(id);
    };

    const isDescendant = (node, ancestor) => {
        for (let current = node; current; current = current.parent) {
            if (current === ancestor) {
                return true;
            }
        }
        return false;
    };

    const unlink = node => {
        if (node.parent) {
            node.parent.children.splice(node.parent.children.indexOf(node), 1);
            node.parent = null;
        }
    };

    // links a parent and a child, unless that would introduce a loop. Only a node with children can have
    // the parent as a descendant, so the walk up from the parent is skipped for the others
    const link = (parent, child) => {
        if (parent !== child && (!child.children.length || !isDescendant(parent, child))) {
            parent.children.push(child);
            child.parent = parent;
        }
    };

    // (1) link the messages by their references
    for (const entry of entries) {
        const header = getMessageData(entry.message).tree.parsedHeader;

        // (1.A) a message without a valid Message-ID, or with one that an earlier message already has, gets a unique one
        const messageId = parseMessageIds(header['message-id'])[0];
        let node = messageId !== undefined && getNode(messageId);
        if (!node || node.entry) {
            node = createNode();
            all.push(node);
        }
        node.entry = entry;

        // the References header, or else the first Message ID of In-Reply-To
        let refs = parseMessageIds(header.references);
        if (!refs.length) {
            refs = parseMessageIds(header['in-reply-to']).slice(0, 1);
        }

        // (1.A) each reference is the parent of the next one, existing links are kept
        const refNodes = refs.map(getNode);
        for (let i = 1; i < refNodes.length; i++) {
            if (!refNodes[i].parent) {
                link(refNodes[i - 1], refNodes[i]);
            }
        }

        // (1.B) the last reference is the parent of the message, replacing an existing link
        const parent = refNodes[refNodes.length - 1] || null;
        if (node.parent !== parent) {
            unlink(node);
            if (parent) {
                link(parent, node);
            }
        }
    }

    // (2) messages without a parent are the top level
    const roots = all.filter(node => !node.parent);

    // (3) prune dummies: drop the ones without children, put the children of the others in their place,
    // but not at the top level if there is more than one child
    const replacement = (node, topLevel) => {
        if (node.entry) {
            return [node];
        }
        if (!node.children.length) {
            return [];
        }
        return topLevel && node.children.length > 1 ? [node] : node.children;
    };
    // children before their parents, so a dummy is replaced by children that are already pruned
    for (const node of preOrder(roots).reverse()) {
        node.children = node.children.flatMap(child => replacement(child, false));
        node.children.forEach(child => {
            child.parent = node;
        });
    }
    let top = roots.flatMap(node => replacement(node, true));
    top.forEach(node => {
        node.parent = null;
    });

    // (4) sort the top level by sent date, a dummy by its first child
    top.forEach(node => {
        if (!node.entry) {
            node.children.sort(compareNodes);
        }
    });
    top.sort(compareNodes);

    // (5) gather threads with the same base subject, the subject of a dummy is the one of its first child
    const threadSubject = node => (node.entry ? node.entry.subject : node.children[0].entry.subject);
    const isReply = node => !!node.entry && node.entry.subject.isReply;
    const table = new Map();

    // (5.B) one message per base subject, a dummy or a message that is not a reply or forward is preferred
    for (const node of top) {
        const subject = threadSubject(node);
        if (!subject.id) {
            continue;
        }
        const old = table.get(subject.id);
        if (!old || (old.entry && (!node.entry || (isReply(old) && !isReply(node))))) {
            table.set(subject.id, node);
        }
    }

    // (5.C) merge the other threads with the same subject into the one in the table
    const removed = new Set();
    for (const node of top) {
        const subject = threadSubject(node);
        if (!subject.id) {
            continue;
        }
        const other = table.get(subject.id);
        if (other === node) {
            continue;
        }
        removed.add(node);
        if (!other.entry && !node.entry) {
            node.children.forEach(child => link(other, child));
        } else if (!other.entry || (isReply(node) && !isReply(other))) {
            link(other, node);
        } else {
            // both become children of a new dummy that takes the place of the message in the table
            const dummy = createNode();
            top[top.indexOf(other)] = dummy;
            link(dummy, other);
            link(dummy, node);
            table.set(subject.id, dummy);
        }
    }
    top = top.filter(node => !removed.has(node));

    // (6) sort all sets of siblings by sent date, the deepest ones first
    for (const node of preOrder(top).reverse()) {
        node.children.sort(compareNodes);
    }
    top.sort(compareNodes);
    return top;
}

const ALGORITHMS = {
    ORDEREDSUBJECT: orderedSubject,
    REFERENCES: references
};

/**
 * Adds the THREAD and UID THREAD commands, unless another algorithm plugin did already, and the
 * THREAD=<algorithm> capability
 *
 * @param {Object} server IMAP server
 * @param {String} algorithm "ORDEREDSUBJECT" or "REFERENCES"
 */
function addThreadAlgorithm(server, algorithm) {
    server.registerCapability('THREAD=' + algorithm);

    if (server.threadAlgorithms) {
        server.threadAlgorithms[algorithm] = ALGORITHMS[algorithm];
        return;
    }
    server.threadAlgorithms = { [algorithm]: ALGORITHMS[algorithm] };

    const threadHandler = (isUid, connection, parsed, data, callback) => {
        const command = isUid ? 'UID THREAD' : 'THREAD';
        const attributes = parsed.attributes || [];

        // RFC 5256 section 5: thread-alg = "ORDEREDSUBJECT" / "REFERENCES" / thread-alg-ext, an atom
        const name = attributes[0] && attributes[0].type === 'ATOM' ? attributes[0].value.toUpperCase() : '';
        if (!Object.hasOwn(server.threadAlgorithms, name)) {
            connection.sendStatus(
                parsed,
                data,
                'BAD',
                name ? 'Unsupported threading algorithm ' + name : command + ' expects a threading algorithm atom',
                false,
                command + ' FAILED'
            );
            return callback();
        }

        const result = searchMessages(connection, parsed, data, attributes.slice(1));
        if (!result) {
            return callback();
        }

        // base subjects are compared with the collation (RFC 5256 sections 3 and 7)
        const entries = result.list.map(message => {
            const base = baseSubject(getMessageData(message).tree.parsedHeader.subject);
            return {
                message,
                seq: result.numbers[message.uid],
                date: sentTime(message),
                // a binary string of the collation key, these compare like the octets of the key
                subject: { id: collationKey(base.subject).toString('binary'), isReply: base.isReply }
            };
        });

        connection.send(
            {
                tag: '*',
                command: 'THREAD',
                // thread-data has no SP between thread-lists, so it can not be built from nested arrays
                attributes: entries.length ? [{ type: 'TEXT', value: formatThreads(server.threadAlgorithms[name](entries), isUid) }] : []
            },
            command,
            parsed,
            data,
            // the search result, so CONDSTORE knows about a MODSEQ search key (RFC 7162 section 3.1.9)
            result
        );
        connection.sendStatus(parsed, data, 'OK', command + ' completed', false, command);
        return callback();
    };

    // RFC 5256 section 3: EXPUNGE responses are not permitted while responding to THREAD, but are during UID THREAD.
    // The search criteria start after the algorithm and the charset
    server.setCommandHandler('THREAD', threadHandler.bind(null, false), { states: states.SELECTED, searchCriteria: 2, noExpunge: true });
    server.setCommandHandler('UID THREAD', threadHandler.bind(null, true), { states: states.SELECTED, searchCriteria: 2 });
}

module.exports = { addThreadAlgorithm };
