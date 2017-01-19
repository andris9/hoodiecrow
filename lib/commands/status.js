"use strict";

module.exports = function(connection, parsed, data, callback) {

  if (!parsed.attributes ||
      parsed.attributes.length !== 2 ||
      !parsed.attributes[0] ||
      ["STRING", "LITERAL", "ATOM"].indexOf(parsed.attributes[0].type) < 0 ||
      !Array.isArray(parsed.attributes[1]) ||
      !parsed.attributes[1].length
  ) {

    connection.send({
      tag: parsed.tag,
      command: "BAD",
      attributes: [{
        type: "TEXT",
        value: "STATUS expects mailbox argument and a list of status items"
      }]
    }, "INVALID COMMAND", parsed, data);
    return callback();
  }

  if (["Authenticated", "Selected"].indexOf(connection.state) < 0) {
    connection.send({
      tag: parsed.tag,
      command: "BAD",
      attributes: [{
        type: "TEXT",
        value: "Log in first"
      }]
    }, "STATUS FAILED", parsed, data);
    return callback();
  }

  var path = parsed.attributes[0].value;

  // get status of the mailbox at the given path
  connection.getStatus(path, function (err, status) {
    var response = [], item, itemKey;
    if (err) {
      connection.send({
        tag: parsed.tag,
        command: "NO",
        attributes: [{
          type: "TEXT",
          value: "Invalid mailbox name"
        }]
      }, "STATUS FAILED", parsed, data);
      return callback();
    }

    // check which attributes it asked for
    for (var i = 0, len = parsed.attributes[1].length; i < len; i++) {
      item = parsed.attributes[1][i];
      if (!item || item.type !== "ATOM" || connection.server.allowedStatus.indexOf(item.value.toUpperCase()) < 0) {
        connection.send({
          tag: parsed.tag,
          command: "BAD",
          attributes: [{
            type: "TEXT",
            value: "Invalid status element (" + (i + 1) + ")"
          }]
        }, "STATUS FAILED", parsed, data);
        return callback();
      }
      itemKey = item.value.toUpperCase();

      response.push({
        type: "ATOM",
        value: itemKey
      });
      switch (itemKey) {
      case "MESSAGES":
        // mailbox.messages.length
        response.push(status.messages);
        break;
      case "RECENT":
        // status.flags["\\Recent"] || 0)
        response.push(status.recent || 0);
        break;
      case "UIDNEXT":
        // mailbox.uidnext
        response.push(status.uidnext);
        break;
      case "UIDVALIDITY":
        // mailbox.uidvalidity
        response.push(status.uidvalidity);
        break;
      case "UNSEEN":
        // status.unseen
        response.push(status.unseen || 0);
        break;
      }
    }

    connection.send({
      tag: "*",
      command: "STATUS",
      attributes: [{
        type: "ATOM",
        value: path
      },
      response
      ]
    }, "STATUS", parsed, data);

    connection.send({
      tag: parsed.tag,
      command: "OK",
      attributes: [{
        type: "TEXT",
        value: "Status completed"
      }]
    }, "STATUS", parsed, data);
    return callback();
  });
};
