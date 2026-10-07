/**
 * VANISHED responses (RFC 7162 section 3.2.10) in place of EXPUNGE notifications. Used by QRESYNC
 * and by UIDONLY (RFC 9586 section 3.4), which both report expunged messages by UID.
 */

import { toSequenceSet } from './esearch.js';
import type { IMAPResponse, Message, Notification } from './types.js';

/**
 * Checks if a queued notification is an EXPUNGE response for a removed message
 *
 * @param {Object} notification Queued notification
 * @return {Boolean} true for an EXPUNGE notification
 */
function isExpungeNotification(notification: Notification): boolean {
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
function toVanished(queue: Notification[]): IMAPResponse[] {
    if (!queue.some(isExpungeNotification)) {
        return queue;
    }
    // groups of consecutive expunges, as lists of UIDs, between the other notifications
    const groups: (Notification | Message[])[] = [];
    queue.forEach(notification => {
        if (!isExpungeNotification(notification)) {
            groups.push(notification);
        } else if (Array.isArray(groups[groups.length - 1])) {
            // an EXPUNGE notification always carries its message
            (groups[groups.length - 1] as Message[]).push(notification.message!);
        } else {
            groups.push([notification.message!]);
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

export { isExpungeNotification, toVanished };
