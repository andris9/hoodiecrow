
module.exports = function(server){

    // Add ID to capability listing
    server.addCapability("XFIFTH", function(connection){
        // always allow
        return true;
    });

    // Add search handler for XFIFTH param
    server.setSearchHandler("XFIFTH", function(mailbox, message, index){
        return index % 5 == 0;
    });

    // Add handler for messages added to mailbox
    // every message will have a xfifth property that is a mailbox
    // specific counter incrementing by 5
    server.addMessageInsertHandler(function(mailbox, message, index){
        mailbox.last_xfifth = (mailbox.xfifth || 0) + 5;
        message.xfifth = mailbox.last_xfifth;
    });
}
