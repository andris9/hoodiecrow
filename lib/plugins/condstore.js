
// Partial CONDSTORE implementation
module.exports = function(server){

    // Add CONDSTORE to capability listing
    server.addCapability("CONDSTORE", function(connection){
        // always allow
        return true;
    });

    // Show modseq value in SELECT and EXAMINE responses
    server.addMailboxInfoHandler(function(mailbox, infoList){
        mailbox.highestmodseq = (mailbox.highestmodseq || 0);
        infoList.push("OK [HIGHESTMODSEQ " + mailbox.highestmodseq + "]");
    });

    // Ensure modseq value for every message
    server.addMessageInsertHandler(function(mailbox, message, index){
        mailbox.highestmodseq = (mailbox.highestmodseq || 0) + 1;
        message.modseq = mailbox.highestmodseq;
    });

    // Update modseq when needed
    server.addMessageUpdateHandler(function(mailbox, message){
        mailbox.highestmodseq = (mailbox.highestmodseq || 0) + 1;
        message.modseq = mailbox.highestmodseq;
    });

    // Add search handler for MODSEQ param
    server.setSearchHandler("MODSEQ", function(mailbox, message, index, modseq){
        return message.modseq >= Number(modseq);
    });
}
