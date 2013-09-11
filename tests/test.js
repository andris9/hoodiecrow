var toybird = require("../lib/server");

module.exports["Toybird tests"] = {
    "Sample test": function(test){
        test.ok(toybird());
        test.done();
    }
}