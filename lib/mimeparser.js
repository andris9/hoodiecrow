var addressparser = require("./addressparser");

module.exports = function(rfc822){
    var parser = new Parser(rfc822);
    parser.parse();
    parser.finalizeTree();
    return parser.tree.childNodes[0] || false;
}

function Parser(rfc822){
    this.rfc822 = rfc822 || "";

    this.br = "";
    this.pos = 0;

    this.tree = {childNodes:[]};
    this.node = this.createNode(this.tree);
}

Parser.prototype.createNode = function(parentNode){
    var node = {
        state: "header",
        parentNode: parentNode,
        childNodes: [],
        header: [],
        parsedHeader: {},
        body: [],
        multipart: false,
        parentBoundary: parentNode.boundary,
        boundary: false
    }
    parentNode.childNodes.push(node);
    return node;
}

Parser.prototype.processNodeHeader = function(){
    var key, value;

    for(var i = this.node.header.length - 1; i >= 0; i--){
        if(i && this.node.header[i].match(/^\s/)){
            this.node.header[i-1] = this.node.header[i-1].replace(/\s*$/, "") + " " + this.node.header[i].trim();
            this.node.header.splice(i, 1);
        }else{
            value = this.node.header[i].split(":");
            key = (value.shift() || "").trim().toLowerCase();
            value = value.join(":").trim();

            if(key in this.node.parsedHeader){
                if(Array.isArray(this.node.parsedHeader[key])){
                    this.node.parsedHeader[key].unshift(value);
                }else{
                    this.node.parsedHeader[key] = [value, this.node.parsedHeader[key]];
                }
            }else{
                this.node.parsedHeader[key] = value;
            }
        }
    }

    if(!this.node.parsedHeader["content-type"]){
        this.node.parsedHeader["content-type"] = "text/plain";
    }

    ["content-type", "content-disposition"].forEach((function(key){
        if(this.node.parsedHeader[key]){
            this.node.parsedHeader[key] = this.parseHeaderKeys([].concat(this.node.parsedHeader[key] || []).pop());
        }
    }).bind(this));

    ["from", "sender", "reply-to", "to", "cc", "bcc"].forEach((function(key){
        var addresses = [];
        if(this.node.parsedHeader[key]){
            [].concat(this.node.parsedHeader[key] || []).forEach(function(value){
                if(value){
                    addresses = addresses.concat(addressparser(value) || []);    
                }
            });
            this.node.parsedHeader[key] = addresses;
        }
    }).bind(this));
}

Parser.prototype.parseHeaderKeys = function(headerValue){
    var data = {value:"", type:"", subtype:"", params:{}},
        match, processEncodedWords = {};
    
    (headerValue || "").split(";").forEach(function(part, i){
        var key, value;
        if(!i){
            data.value = part.trim();
            data.subtype = data.value.split("/");
            data.type = (data.subtype.shift() || "").toLowerCase();
            data.subtype = data.subtype.join("/");
            return;
        }
        value = part.split("=");
        key = (value.shift() || "").trim().toLowerCase();
        value = value.join("=").replace(/^['"\s]*|['"\s]*$/g, "");

        if((match = key.match(/^([^*]+)\*(\d)?$/))){
            if(!processEncodedWords[match[1]]){
                processEncodedWords[match[1]] = [];
            }
            processEncodedWords[match[1]][Number(match[2]) || 0] = value;
        }else{
            data.params[key] = value;    
        }
        data.hasParams = true;
    });

    Object.keys(processEncodedWords).forEach(function(key){
        var charset = "", value = "";
        processEncodedWords[key].forEach(function(val){
            var parts = val.split("'");
            charset = charset || parts.shift();
            value += (parts.pop() || "").replace(/%/g, "=");
        });
        data.params[key] = "=?"+(charset || "ISO-8859-1").toUpperCase()+"?Q?"+value+"?=";
    });

    return data;
}

Parser.prototype.processContentType = function(){
    if(!this.node.parsedHeader['content-type']){
        return;
    }

    if(this.node.parsedHeader['content-type'].type == "multipart" && this.node.parsedHeader['content-type'].params.boundary){
        this.node.multipart = this.node.parsedHeader['content-type'].subtype;
        this.node.boundary = this.node.parsedHeader['content-type'].params.boundary;
    }
}

Parser.prototype.parse = function(){
    var line, prevBr = "";
    while(typeof this.br == "string"){
        line = this.readLine();

        switch(this.node.state){
            case "header":
                if(!line){
                    this.processNodeHeader();
                    this.processContentType();

                    this.node.state = "body";
                }else{
                    this.node.header.push(line);
                }
                break;
            case "body":
                if(this.node.parentBoundary && (line == "--" + this.node.parentBoundary || line == "--" + this.node.parentBoundary + "--")){
                    if(line == "--" + this.node.parentBoundary){
                        this.node = this.createNode(this.node.parentNode);
                    }else{
                        this.node = this.node.parentNode;
                    }
                }else if(this.node.boundary && line == "--" + this.node.boundary){
                    this.node = this.createNode(this.node);
                }else{
                    this.node.body.push((this.node.body.length ? prevBr : "") + line);
                }
                break;
            default:
                throw new Error("Unexpected state");
        }

        prevBr = this.br;
    }
}

Parser.prototype.finalizeTree = function(){
    var walker = function(node){
        if(node.body){
            node.lineCount = node.body.length;
            node.body = node.body.join("");
            node.size = node.body.length;
        }
        node.childNodes.forEach(walker);

        // remove unneeded properties
        delete node.parentNode; // circular reference, if precent makes it impossible to convert parsed structure to JSON
        delete node.state;
        if(!node.childNodes.length){
            delete node.childNodes;
        }
        delete node.parentBoundary;
    }
    walker(this.tree);
}

Parser.prototype.readLine = function(){
    var match = this.rfc822.substr(this.pos).match(/(.*?)(\r?\n|$)/);
    if(match){
        this.br = match[2] || false;
        this.pos += match[0].length;
        return match[1];
    }
    return false;
}
