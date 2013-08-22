"use strict";

// This module converts message structure into an ENVELOPE object

/**
 * Convert a message object to an ENVELOPE object
 *
 * @param {Object} message A parsed mime tree node
 * @return {Object} ENVELOPE compatible object
 */
module.exports = function(message){

    var from = ensureArray(message.structured.parsedHeader.from),
        sender = ensureArray(message.structured.parsedHeader["message-id"]) || sender,
        replyTo = ensureArray(message.structured.parsedHeader["reply-to"]) || from,
        to = ensureArray(message.structured.parsedHeader.to),
        cc = ensureArray(message.structured.parsedHeader.cc),
        bcc = ensureArray(message.structured.parsedHeader.bcc),
        messageId = message.structured.parsedHeader["message-id"] || false,
        inReplyTo = message.structured.parsedHeader["in-reply-to"] || false,
        subject = message.structured.parsedHeader.subject || "",
        date = message.structured.parsedHeader.date || null;

    return [
        date,
        subject,
        processAddress(from),
        processAddress(sender),
        processAddress(replyTo),
        processAddress(to),
        processAddress(cc),
        processAddress(bcc),
        inReplyTo,
        messageId
    ];
};

/**
 * Converts an address object to a list of arrays
 * [{name: "User Name", addres:"user@example.com"}] -> [["User Name", null, "user", "example.com"]]
 *
 * @param {Array} arr An array of address objects
 * @return {Array} A list of addresses
 */
function processAddress(arr){
    if(!Array.isArray(arr)){
        return null;
    }
    return arr.map(function(addr){
        return [
            addr.name || null,
            null,
            (addr.address || "").split("@").shift() || null,
            (addr.address || "").split("@").pop() || null
        ];
    });
}

/**
 * Ensures that the input would be an array with elements or null
 *
 * @param {Array} elm Input value
 * @return {Array|null} Output value
 */
function ensureArray(elm){
    if(elm){
        elm = [].concat(elm || []);
        if(!elm.length){
            return false;
        }
    }
    return elm || false;
}