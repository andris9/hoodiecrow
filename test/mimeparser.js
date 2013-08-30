var mimeParser = require("../lib/mimeparser"),
    fs = require("fs");

module.exports["Parse simple message"] = function(test){
    var message = "From: from address <from>\r\nTo: to address <to>\r\nSubject: subject line\r\n\r\nbody\r\ntext",
        parsed = mimeParser(message);

    test.ok(!!parsed.header);
    test.ok(!!parsed.body);
    test.ok(parsed.parsedHeader);
    test.equal(typeof parsed.parsedHeader, "object");

    test.deepEqual(parsed.header, [
        "From: from address <from>",
        "To: to address <to>",
        "Subject: subject line"
    ]);

    test.equal(parsed.parsedHeader.subject, "subject line");
    test.deepEqual(parsed.parsedHeader.from, [{"address": "from","name": "from address"}]);
    test.deepEqual(parsed.parsedHeader.to, [{"address": "to","name": "to address"}]);
    test.equal(parsed.body, "body\r\ntext");

    test.equal(parsed.parsedHeader['content-type'].value, "text/plain");
    test.equal(parsed.lineCount, 2);
    test.equal(parsed.size, 10);

    test.done();
}