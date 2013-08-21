/**
 * @fileOverview Provides a parser for IMAP line based commands
 * @author Andris Reinman
 */

var Stream = require("stream").Stream,
    utillib = require("util");

// expose to the world
module.exports = IMAPLineParser;

/**
 * Creates a reusable parser for parsing. It is a writable stream for piping
 * data directly in.
 *
 * @constructor
 */
function IMAPLineParser(){
    Stream.call(this);
    this.writable = true;

    this._init();
}
utillib.inherits(IMAPLineParser, Stream);

/**
 * Possible states the parser can be in (Finite State Machine)
 */
IMAPLineParser.prototype.states = {
    DEFAULT: 0x1,
    ATOM: 0x2,
    QUOTED: 0x3
};

/**
 * Possible types for data nodes
 */
IMAPLineParser.prototype.types = {
    STRING: 0x1, // regular string, default
    GROUP: 0x2,  // parentheses group (a b c)
    PARAMS: 0x3, // value params BODY[PARAM1 PARAM2]
    PARTIAL: 0x4, // Partial length indicator BODY[]<from.to>
    LITERAL: 0x5 // {123} literal string
};

// PUBLIC METHODS

/**
 * Appends a chunk for parsing
 *
 * @param {Buffer|String} chunk Data to be appended to the parse string
 * @return {Boolean} Always returns true
 */
IMAPLineParser.prototype.write = function(chunk){
    chunk = (chunk || "").toString("binary");
    this._currentLine += chunk;
    this._parseLine(chunk);
    return true;
};

/**
 * If a literal occurs ({123}\r\n) do not parse it, since the length is known.
 * Just add it separately and it will included as the node value instead of
 * length property.
 *
 * @param {Buffer|String} chunk Data to be appended to the literal string value
 */
IMAPLineParser.prototype.writeLiteral = function(chunk){
    if(!this.currentNode.value){
        this.currentNode.value = "";
    }

    if(this.currentNode.type != this.types.LITERAL){
        //this.currentNode.literal = this.currentNode.value;
        this.currentNode.value = "";
        //this.currentNode.type = this.types.LITERAL;
    }

    this.currentNode.value += (chunk || "").toString("binary");
};

/**
 * Finishes current parsing and reesets internal variables. Emits 'line' event
 * with the parsed data
 *
 * @param {Buffer|String} chunk Data to be appended to the parse string
 */
IMAPLineParser.prototype.end = function(chunk){
    if(chunk && chunk.length){
        this.write(chunk);
    }

    if(this.currentNode.value){
        if(this._state == this.states.ATOM || this._state==this.states.QUOTED){
            if(this._state == this.states.ATOM && this.currentNode.value == "NIL"){
                this.currentNode.value = null;
            }
            this._branch.childNodes.push(this.currentNode);
        }
    }

    process.nextTick(this.emit.bind(this, "log", this._currentLine));
    process.nextTick(this.emit.bind(this, "line", this.finalize()));
    this._init();
};

/**
 * Generates a structured object with the data currently known. Useful if you
 * need to check parse status in the middle of the process
 *
 * @return {Array} Parsed data
 */
IMAPLineParser.prototype.finalize = function(){
    var tree = [];
    this._nodeWalker(this._parseTree.childNodes, tree);
    return tree;
};

// PRIVATE METHODS

/**
 * Resets all internal variables and creates a new parse tree
 */
IMAPLineParser.prototype._init = function(){

    /**
     * Current state the parser is in
     * @private
     */
    this._state = this.states.DEFAULT;

    /**
     * Which quote symbol is used for current quoted string
     * @private
     */
    this._quoteMark = '';

    /**
     * Is the current character escaped by \
     * @private
     */
    this._escapedChar = false;

    /**
     * Parse tree to hold the parsed data structure
     * @private
     */
    this._parseTree = {
        childNodes: []
    };

    /**
     * Active branch, by default it's the tree itselt
     * @private
     */
    this._branch = this._parseTree;

    /**
     * Hold the original line data
     * @private
     */
    this._currentLine = "";

    /**
     * Starting node
     * @private
     */
    this.currentNode = {
        parentNode: this._branch,
        value: "",
        childNodes: []
    };
};

/**
 * Parses the data currently known, continues from the previous state.
 * This is a token based parser. Special characters are space, backslash,
 * quotes, (), [] and <>. After every character the parseTree is updated.
 *
 * @param {String} line Data to be parsed
 */
IMAPLineParser.prototype._parseLine = function(line){

    var i=0, curchar;

    while(i < line.length){

        curchar = line.charAt(i);

        // Check all characters one by one
        switch(curchar){

            // Handle whitespace
            case " ":
            case "\t":
                if(this._state == this.states.QUOTED){
                    this.currentNode.value += curchar;
                }else if(this._state == this.states.ATOM && this._escapedChar){
                    this.currentNode.value += curchar;
                }else if(this._state == this.states.ATOM){
                    this._addToBranch();
                    this._state = this.states.DEFAULT;
                    this._createNode();
                }
                break;

            // Backspace is for escaping in quoted strings
            case '\\':
                if(this._escapedChar || this._state == this.states.ATOM){
                    this.currentNode.value += curchar;
                }else if(this._state == this.states.QUOTED){
                    this._escapedChar = true;
                }else if(this._state == this.states.DEFAULT){
                    this._state = this.states.ATOM;
                    this._createNode(curchar);
                }
                break;

            // Handle quotes, remember the quote type to allow other unescaped quotes
            case '"':
            case "'":
                if(this._escapedChar || (this._state == this.states.QUOTED && this._quoteMark != curchar)){
                    this.currentNode.value += curchar;
                }else if(this._state == this.states.DEFAULT){
                    this._quoteMark = curchar;
                    this._state = this.states.QUOTED;
                    this._createNode();
                }else if(this._state == this.states.QUOTED){
                    this._addToBranch();
                    this._state = this.states.DEFAULT;
                    this._createNode();
                }else if(this._state == this.states.ATOM){
                    this._addToBranch();
                    this._quoteMark = curchar;
                    this._state = this.states.QUOTED;
                    this._createNode();
                }
                break;

            // Handle different group types
            case "[":
            case "(":
            case "<":
                if(this._escapedChar || this._state==this.states.QUOTED){
                    this.currentNode.value += curchar;
                    break;
                }

                if(this._state == this.states.ATOM){
                    this._addToBranch();
                }

                // () gets a separate node, [] uses last node as parent
                if(this._state == this.states.ATOM && curchar == "["){
                    this._branch = this._branch.lastNode || this._parseTree;
                    this._branch.type = this.types.PARAMS;
                    if(!this._branch.childNodes){
                        this._branch.childNodes = [];
                    }
                }else{
                    // create new empty node
                    this._createNode(false);
                    switch(curchar){
                        case "(":
                            this.currentNode.type = this.types.GROUP;
                            break;
                        case "<":
                            this.currentNode.type = this.types.PARTIAL;
                            break;
                        case "[":
                            this.currentNode.type = this.types.PARAMS;
                            break;
                    }

                    this._addToBranch();

                    this._branch = this.currentNode || this._parseTree;
                    if(!this._branch.childNodes){
                        this._branch.childNodes = [];
                    }
                }

                this._state = this.states.DEFAULT;

                this._createNode();

                break;
            case "]":
            case ")":
            case ">":
                if(this._escapedChar || this._state==this.states.QUOTED){
                    this.currentNode.value += curchar;
                    break;
                }

                if(this._state == this.states.ATOM){
                    this._addToBranch();
                }

                this._state = this.states.DEFAULT;

                this._branch = this._branch.parentNode || this._branch;
                if(!this._branch.childNodes){
                    this._branch.childNodes = [];
                }

                this._createNode();
                break;

            // Add to existing string or create a new atom
            default:
                if(this._state == this.states.ATOM || this._state == this.states.QUOTED){
                    this.currentNode.value += curchar;
                }else{
                    this._state = this.states.ATOM;
                    this._createNode(curchar);
                }
        }

        // cancel escape if it didn't happen
        if(this._escapedChar && curchar != "\\"){
            this._escapedChar = false;
        }

        i++;
    }

};

/**
 * Pushes current node to the active branch
 */
IMAPLineParser.prototype._addToBranch = function(){
    if(this._state == this.states.ATOM && this.currentNode.value == "NIL"){
        this.currentNode.value = null;
    }
    this._branch.childNodes.push(this.currentNode);
    this._branch.lastNode = this.currentNode;
};

/**
 * Creates a new empty node
 *
 * @param {String} [defaultValue] If specified will be used as node.value value
 */
IMAPLineParser.prototype._createNode = function(defaultValue){
    this.lastNode = this.currentNode;

    this.currentNode = {};

    if(defaultValue !== false){
        this.currentNode.value = defaultValue || "";
    }

    this.currentNode.parentNode = this._branch;
};

/**
 * Recursive function to walk the parseTree and generate structured output object
 *
 * @param {Array} branch Current branch to check
 * @param {Array} local Output object node to append the data to
 */
IMAPLineParser.prototype._nodeWalker = function(branch, local){
    var node, i, len, curnode, prevpos, literalLength;

    for(i=0, len = branch.length; i<len; i++){
        node = branch[i];

        if((typeof node.value == "string" || node.value === null) && !node.type){
            local.push(node.value);
        }else if(node.type == this.types.LITERAL){

            literalLength = node.literal.match(/\{(\d+)\}/);
            literalLength = literalLength && Number(literalLength[1]) || 0;

            curnode = {
                literal: literalLength,
                value: node.value
            };

            local.push(curnode);
        }else if(node.type == this.types.PARTIAL){
            prevpos = local.length - 1;
            if(prevpos<0){
                curnode = {};
            }else{
                curnode = local[prevpos];
                if(typeof curnode != "object" || Array.isArray(curnode)){
                    curnode = {
                        value: curnode
                    };
                }
            }

            local.splice(prevpos, 1, curnode);

            curnode.partial = [];

            if(node.childNodes.length == 1 && typeof node.childNodes[0].value == "string"){
                curnode.partial = node.childNodes[0].value.split(".").map(Number);
            }else{
                this._nodeWalker(node.childNodes, curnode.partial);
            }

        }else if(node.type == this.types.PARAMS){
            if(!node.childNodes.length){
                local.push(node.value);
            }else{
                curnode = {};
                if(typeof node.value != "undefined"){
                    curnode.value = node.value;
                }
                local.push(curnode);
                curnode.params = [];
                this._nodeWalker(node.childNodes, curnode.params);
            }

        }else if(node.type == this.types.GROUP){
            curnode = [];
            local.push(curnode);
            this._nodeWalker(node.childNodes, curnode);
        }
    }
};

