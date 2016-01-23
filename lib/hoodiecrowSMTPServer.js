"use strict";

var simplesmtp = require("simplesmtp");

/***
 * Starts simpleSMTP server, passing parsed email messages along to the
 * hoodiecrow IMAP server as a new message in the INBOX.
 *
 * Note: Interprets data chunks coming out of simpleSMTP to fix dot escaping
 * issue that is liable to leave duplicated dots in emails
 *
 *
 * @param {Number} smtpPort - port to listen on for SMTP commands
 * @param {Object} imapServer - the hoodiecrow IMAP server
 * @param {Function} callback - function executed when SMTP server is listening
 */
exports.startSMTPServer = function startSMTPServer(smtpPort, imapServer, callback) {
    var server = simplesmtp.createSimpleServer({SMTPBanner:"Hoodiecrow"}, function(req) {
        var data = [], dataLen = 0;
        req.on("data", function(chunk){
            if(!chunk || !chunk.length){
                return;
            }
            data.push(chunk);
            dataLen += chunk.length;
        });
        req.on("end", function(){
          function handleDotEscaping(message) {
            // According to http://tools.ietf.org/html/rfc5321#section-4.5.2, 
            // SMTP clients are to escape any period appearing as the first
            // character of a line with another period.  This code removes
            // any of these inserted periods as they would appear as a doubled
            // period in email if we didn't.
            //
            // This should probably be considered an issue in simpleSMTP
            // since period escaping is part of the SMTP spec, but it doesn't
            // seem to be possible to fix it there with this API unless emitted 
            // chunks coincide with lines submitted by the SMTP client.  It
            // wasn't immediately clear whether that is the case.
            // And simpleSMTP is clearly labelled as deprecated anyway.  Might
            // as well hack in a fix here unless hoodiecrow were to move to
            // simpleSMTP's replacement
            //
            var dotsNotHandled = message.toString("utf-8");
            // If the message begins with a dot, we need to delete it, unless its part of a message terminator.
            var firstLineHandled = dotsNotHandled[0] === "." && !(dotsNotHandled[1] === "\r" && dotsNotHandled[2] === "\n") ?
                                     dotsNotHandled.substr(1) : dotsNotHandled;
            // This split/join deletes all periods that appear as the first character of a line
            // except for when it is immediately followed by <cr><lf> and thus is part of a message terminator.
            var textSurroundingFirstCharacterDots = firstLineHandled.split("\r\n.");
            var intermediate = textSurroundingFirstCharacterDots.map(function(lineFollowingStartingDot) {
              if (lineFollowingStartingDot.indexOf("\r\n") === 0) {
                return "\r\n." + lineFollowingStartingDot;
              } else {
                return lineFollowingStartingDot;
              }
            });

            return new Buffer(intermediate.join("\r\n"));
          }
  
            var message = Buffer.concat(data, dataLen),
              messageAfterHandlingDotEscaping = handleDotEscaping(message);

            imapServer.appendMessage("INBOX", [], false, messageAfterHandlingDotEscaping.toString("binary"));
        });
        req.accept();
    });
    
    server.listen(smtpPort, function(){
        console.log("Incoming SMTP server up and running on port %s", smtpPort);
        if (callback) {
            return callback();
        }
    });

    return server;
  
};
