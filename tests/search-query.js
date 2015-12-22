var queryProc = require("../lib/commands/handlers/search"), parser = require('imap-handler').parser,
query = function (str) {
	var parsed = parser("A2 SEARCH "+str),
  params = parsed.attributes.map(function(argument, i) {
      if (["STRING", "ATOM", "LITERAL", "SEQUENCE"].indexOf(argument.type) < 0) {
          throw new Error("Invalid search criteria argument #" + (i + 1));
      }
      return argument.value;
  });
	return queryProc(params);
};



module.exports["Query parsing tests"] = {
    "ALL": function(test) {
			test.deepEqual(query("ALL"),{index:"1:*"});
			test.done();
    },

    "ANSWERED": function(test) {
			test.deepEqual(query("ANSWERED"),{flags:["\\Answered"]});
			test.done();
    },

    "UNANSWERED": function(test) {
			test.deepEqual(query("UNANSWERED"),{flags:[{not:"\\Answered"}]});
			test.done();
    },

    "BCC": function(test) {
			test.deepEqual(query("BCC \"test\""),{headers:{bcc:"test"}});
			test.done();
    },

    "BEFORE": function(test) {
			test.deepEqual(query("BEFORE \"14-Sep-2013\""),{date:{lt:"14-Sep-2013"}});
			test.done();
    },

    "SINCE": function(test) {
			test.deepEqual(query("SINCE \"14-Sep-2013\""),{date:{gt:"14-Sep-2013"}});
			test.done();
    },

    "ON": function(test) {
			test.deepEqual(query("ON \"14-Sep-2013\""),{date:{eq:"14-Sep-2013"}});
			test.done();
    },

    "BODY": function(test) {
			test.deepEqual(query("BODY \"World 3\""),{body:"World 3"});
			test.done();
    },

    "CC": function(test) {
			test.deepEqual(query("CC \"test\""),{headers:{cc:"test"}});
			test.done();
    },

    "DELETED": function(test) {
			test.deepEqual(query("DELETED"),{flags:["\\Deleted"]});
			test.done();
    },

    "UNDELETED": function(test) {
			test.deepEqual(query("UNDELETED"),{flags:[{not:"\\Deleted"}]});
			test.done();
    },

    "DRAFT": function(test) {
			test.deepEqual(query("DRAFT"),{flags:["\\Draft"]});
			test.done();
    },

    "UNDRAFT": function(test) {
			test.deepEqual(query("UNDRAFT"),{flags:[{not:"\\Draft"}]});
			test.done();
    },

    "FLAGGED": function(test) {
			test.deepEqual(query("FLAGGED"),{flags:["\\Flagged"]});
			test.done();
    },

    "UNFLAGGED": function(test) {
			test.deepEqual(query("UNFLAGGED"),{flags:[{not:"\\Flagged"}]});
			test.done();
    },

    "FROM": function(test) {
			test.deepEqual(query("FROM \"test\""),{headers:{from:"test"}});
			test.done();
    },

    "HEADER String": function(test) {
			test.deepEqual(query("HEADER \"message-id\" \"abcd\""),{headers:{"message-id":"abcd"}});
			test.done();
    },

    "HEADER Any": function(test) {
			test.deepEqual(query("HEADER \"message-id\""),{headers:{"message-id":""}});
			test.done();
    },

    "KEYWORD": function(test) {
			test.deepEqual(query("KEYWORD \"MyFlag\""),{flags:["MyFlag"]});
			test.done();
    },

    "KEYWORD1 KEYWORD2": function(test) {
			test.deepEqual(query("KEYWORD \"MyFlag\" KEYWORD \"Flag2\""),{flags:["MyFlag","Flag2"]});
			test.done();
    },

    "KEYWORD1 KEYWORD2 KEYWORD3": function(test) {
			test.deepEqual(query("KEYWORD \"MyFlag\" KEYWORD \"Flag2\" KEYWORD \"Flag3\""),{flags:["MyFlag","Flag2","Flag3"]});
			test.done();
    },
		
    "LARGER": function(test) {
			test.deepEqual(query("LARGER 34"),{size:{gt:34}});
			test.done();
    },

    "SMALLER": function(test) {
			test.deepEqual(query("SMALLER 34"),{size:{lt:34}});
			test.done();
    },

    "NEW": function(test) {
			test.deepEqual(query("NEW"),{flags:["\\Recent",{not:"\\Seen"}]});
			test.done();
    },

    "RECENT": function(test) {
			test.deepEqual(query("RECENT"),{flags:["\\Recent"]});
			test.done();
    },

    "SEEN": function(test) {
			test.deepEqual(query("SEEN"),{flags:["\\Seen"]});
			test.done();
    },

    "UNSEEN": function(test) {
			test.deepEqual(query("UNSEEN"),{flags:[{not:"\\Seen"}]});
			test.done();
    },

    "RECENT UNSEEN": function(test) {
			test.deepEqual(query("RECENT UNSEEN"),{flags:["\\Recent",{not:"\\Seen"}]});
			test.done();
    },

    "NOT KEYWORD": function(test) {
			test.deepEqual(query("NOT KEYWORD \"MyFlag\""),{flags:[{not:"MyFlag"}]});
			test.done();
    },

    "UNKEYWORD": function(test) {
			test.deepEqual(query("UNKEYWORD \"MyFlag\""),{flags:[{not:"MyFlag"}]});
			test.done();
    },

    "OLD": function(test) {
			test.deepEqual(query("OLD"),{flags:[{not:"\\Recent"}]});
			test.done();
    },

    "NOT RECENT": function(test) {
			test.deepEqual(query("NOT RECENT"),{flags:[{not:"\\Recent"}]});
			test.done();
    },

    "SENTBEFORE": function(test) {
			test.deepEqual(query("SENTBEFORE \"14-Sep-2013\""),{headers:{sent:{lt:"14-Sep-2013"}}});
			test.done();
    },

    "SENTON": function(test) {
			test.deepEqual(query("SENTON \"14-Sep-2013\""),{headers:{sent:{eq:"14-Sep-2013"}}});
			test.done();
    },

    "SENTSINCE": function(test) {
			test.deepEqual(query("SENTSINCE \"14-Sep-2013\""),{headers:{sent:{gt:"14-Sep-2013"}}});
			test.done();
    },

    "SUBJECT": function(test) {
			test.deepEqual(query("SUBJECT \"hello 2\""),{headers:{subject:"hello 2"}});
			test.done();
    },

    "TEXT": function(test) {
			test.deepEqual(query("TEXT \"hello 2\""),{text:"hello 2"});
			test.done();
    },

    "TO": function(test) {
			test.deepEqual(query("TO \"receiver\""),{headers:{to:"receiver"}});
			test.done();
    },

    "INVALID": function(test) {
			test.deepEqual(query("ABCDE"),null);
			test.done();
    },

    "<SEQUENCE>": function(test) {
			test.deepEqual(query("1:3,5:*"),{index:"1:3,5:*"});
			test.done();
    },

    "UID": function(test) {
			test.deepEqual(query("UID 66"),{uid:"66"});
			test.done();
    },

    "OR KEYWORD INDEX": function(test) {
			test.deepEqual(query("OR KEYWORD \"MyFlag\" 5:6"),{or:{flags:["MyFlag"],index:"5:6"}});
			test.done();
    },

    "OR KEYWORD1 KEYWORD2": function(test) {
			test.deepEqual(query("OR KEYWORD \"MyFlag\" KEYWORD \"Flag2\""),{flags:{or:["MyFlag","Flag2"]}});
			test.done();
    }

};
