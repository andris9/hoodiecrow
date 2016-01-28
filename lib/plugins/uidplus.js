"use strict";

/**
 * UIDPLUS: http://tools.ietf.org/html/rfc4315
 *
 * Additional commands:
 * - UID EXPUNGE
 *
 * Additional response codes:
 * - APPENDUID
 * - COPYUID
 * - Not implemented: UIDNOTSTICKY
 */
module.exports = function(server) {
    server.registerCapability("UIDPLUS");

    server.setCommandHandler("UID EXPUNGE", function(connection, parsed, data, callback) {
        if (!parsed.attributes ||
            parsed.attributes.length !== 1 ||
            !parsed.attributes[0] ||
            ["ATOM", "SEQUENCE"].indexOf(parsed.attributes[0].type) < 0
        ) {
            connection.send({
                tag: parsed.tag,
                command: "BAD",
                attributes: [{
                    type: "TEXT",
                    value: "UID EXPUNGE expects uid sequence set"
                }]
            }, "INVALID COMMAND", parsed, data);
            return callback();
        }

        if (["Selected"].indexOf(connection.state) < 0) {
            connection.send({
                tag: parsed.tag,
                command: "BAD",
                attributes: [{
                    type: "TEXT",
                    value: "Select mailbox first"
                }]
            }, "COPY FAILED", parsed, data);
            return callback();
        }

        var sequence = parsed.attributes[0].value,
            range = connection.server.getMessageRange(connection.selectedMailbox, sequence, true),
            rangeMessages = range.map(function(x) { return x[1]; });

        connection.expungeSpecificMessages(connection.selectedMailbox, rangeMessages, false, true);

        connection.send({
            tag: parsed.tag,
            command: "OK",
            attributes: [{
                type: "TEXT",
                value: "UID EXPUNGE completed"
            }]
        }, "UID EXPUNGE", parsed, data);
        callback();
    });

    server.outputHandlers.push(function(connection, response, description, parsed, data, extra) {
        if (description === "APPEND") {
            // The final response should be of the form:
            // OK [APPENDUID <target-mailbox-uidvalidity> <uid>] APPEND Completed
            response.attributes = [
                {
                    type: "SECTION",
                    section: [
                        {
                            type: "ATOM",
                            value: "APPENDUID"
                        },
                        extra.mailbox.uidvalidity,
                        extra.message.uid
                    ]
                }
            ].concat(response.attributes);
            return;
        }

        if (description === "COPY" || description === "UID COPY" ||
            description === "MOVE COPYUID" || description === "UID MOVE COPYUID") {
            response.attributes = [
                {
                    type: "SECTION",
                    section: [
                        {
                            type: "ATOM",
                            value: "COPYUID"
                        },
                        extra.mailbox.uidvalidity,
                        // The range was interpreted in ascending order so these
                        // values are already in the right order.
                        {
                            type: "SEQUENCE",
                            value: extra.sourceUids.join(",")
                        }, {
                            type: "SEQUENCE",
                            value: extra.targetUids.join(",")
                        }
                    ]
                }
            ].concat(response.attributes);
            response.skipResponse = false;
            return;
        }
    });
};
