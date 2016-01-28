"use strict";

/**
 * MOVE: http://tools.ietf.org/html/rfc6851
 *
 * Additional commands:
 * - MOVE
 * - UID MOVE
 */
module.exports = function(server) {
    server.registerCapability("MOVE");

    var moveHandler = function(uidMode, connection, parsed, data, callback) {
      function uidify(str) {
        if (uidMode) {
          return "UID " + str;
        }
        return str;
      }

      if (!parsed.attributes ||
          parsed.attributes.length !== 2 ||
          !parsed.attributes[0] ||
          ["ATOM", "SEQUENCE"].indexOf(parsed.attributes[0].type) < 0 ||
          !parsed.attributes[1] ||
          ["ATOM", "STRING"].indexOf(parsed.attributes[1].type) < 0
      ) {
          connection.send({
              tag: parsed.tag,
              command: "BAD",
              attributes: [{
                  type: "TEXT",
                  value: uidify("MOVE expects sequence set and a mailbox name")
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
          }, uidify("MOVE FAILED"), parsed, data);
          return callback();
      }

      var sequence = parsed.attributes[0].value,
          path = parsed.attributes[1].value,
          mailbox = connection.server.getMailbox(path),
          range = connection.server.getMessageRange(connection.selectedMailbox, sequence, uidMode);

      if (!mailbox) {
          connection.send({
              tag: parsed.tag,
              command: "NO",
              attributes: [{
                  type: "TEXT",
                  value: "Target mailbox does not exist"
              }]
          }, uidify("MOVE FAIL"), parsed, data);
          return callback();
      }

      var rangeMessages = range.map(function(x) { return x[1]; });

      var sourceUids = [],
          targetUids = [];
      rangeMessages.forEach(function(message) {
          var flags = [].concat(message.flags || []),
              internaldate = message.internaldate;
          sourceUids.push(message.uid);

          var appendResult = connection.server.appendMessage(mailbox, flags, internaldate, message.raw, connection);
          targetUids.push(appendResult.message.uid);
      });

      // Hook for UIDPLUS to generate the untagged COPYUID response (that wants
      // to happen prior to the EXPUNGEs).  If the UIDPLUS extension is not
      // active, this ill not happen.
      var extra = {
        mailbox: mailbox,
        sourceUids: sourceUids,
        targetUids: targetUids
      };
      connection.send({
          tag: "*",
          command: "OK",
          attributes: [],
          skipResponse: true
      }, uidify("MOVE COPYUID"), parsed, data, extra);

      // Expunge the messages from the source folder.
      connection.expungeSpecificMessages(connection.selectedMailbox, rangeMessages, false, true);

      connection.send({
          tag: parsed.tag,
          command: "OK",
          attributes: [{
              type: "TEXT",
              value: "Done"
          }]
      }, uidify("MOVE OK"), parsed, data);
      callback();
    };

    server.setCommandHandler("MOVE", moveHandler.bind(null, false));
    server.setCommandHandler("UID MOVE", moveHandler.bind(null, true));
};
