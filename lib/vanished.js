'use strict';

/**
 * VANISHED responses (RFC 7162 section 3.2.10) in place of EXPUNGE notifications. Used by QRESYNC
 * and by UIDONLY (RFC 9586 section 3.4), which both report expunged messages by UID.
 */

const { toSequenceSet } = require('./esearch');

/**
 * Checks if a queued notification is an EXPUNGE response for a removed message
 *
 * @param {Object} notification Queued notification
 * @return {Boolean} true for an EXPUNGE notification
 */
function isExpungeNotification(notification) {
    const name = !!notification.message && !!notification.attributes && notification.attributes[1];
    return !!name && name.type === 'ATOM' && String(name.value).toUpperCase() === 'EXPUNGE';
}

/**
 * Replaces the EXPUNGE notifications of a queue with VANISHED responses, consecutive EXPUNGE
 * notifications become one VANISHED response. The queue is not changed
 *
 * @param {Array} queue Queued notifications
 * @return {Array} notifications to send
 */
function toVanished(queue) {
    if (!queue.some(isExpungeNotification)) {
        return queue;
    }
    // groups of consecutive expunges, as lists of UIDs, between the other notifications
    const groups = [];
    queue.forEach(notification => {
        if (!isExpungeNotification(notification)) {
            groups.push(notification);
        } else if (Array.isArray(groups[groups.length - 1])) {
            groups[groups.length - 1].push(notification.message);
        } else {
            groups.push([notification.message]);
        }
    });
    // the removed messages go with the response for output handlers, like `message` of EXPUNGE
    return groups.map(group =>
        Array.isArray(group)
            ? {
                  tag: '*',
                  command: 'VANISHED',
                  attributes: [{ type: 'SEQUENCE', value: toSequenceSet(group.map(message => message.uid)) }],
                  notification: true,
                  messages: group
              }
            : group
    );
}

module.exports = { isExpungeNotification, toVanished };
