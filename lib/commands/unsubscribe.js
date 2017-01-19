"use strict";

module.exports = function(connection, parsed, data, callback) {

  if (!parsed.attributes ||
        parsed.attributes.length !== 1 ||
        !parsed.attributes[0] ||
        ["STRING", "LITERAL", "ATOM"].indexOf(parsed.attributes[0].type) < 0
    ) {

    connection.send({
      tag: parsed.tag,
      command: "BAD",
      attributes: [{
        type: "TEXT",
        value: "UNSUBSCRIBE expects mailbox name"
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
    }, "UNSUBSCRIBE FAILED", parsed, data);
    return callback();
  }

  var path = parsed.attributes[0].value;


  connection.unsubscribeFolder(path,function (err) {
    if (err) {
      connection.send({
        tag: parsed.tag,
        command: "BAD",
        attributes: [{
          type: "TEXT",
          value: "Invalid mailbox name"
        }]
      }, "UNSUBSCRIBE FAILED", parsed, data);
      return callback();
    }
    connection.send({
      tag: parsed.tag,
      command: "OK",
      attributes: [{
        type: "TEXT",
        value: "Status completed"
      }]
    }, "UNSUBSCRIBE", parsed, data);
    return callback();
  });
};
