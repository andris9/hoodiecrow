"use strict";

// Expose to the world
module.exports = createBodystructure;

/**
 * Generates an object out of parsed mime tree, that can be 
 * serialized into a BODYSTRUCTURE string
 *
 * @param {Object} tree Parsed mime tree (see mimeparser.js for input)
 * @param {Object} Object structure in the form of BODYSTRUCTURE
 */
function createBodystructure(tree){
    var walker = function(node){
        switch((node.parsedHeader["content-type"] || {}).type){
            case "multipart":
                return processMultipartNode(node);
            case "text":
                return processTextNode(node);
            // TODO: Add RFC822 handler which is a special case
            //case "message":
            //    return processRFC822Node(node);
            default:
                return processAttachmentNode(node);
        }
    };
    return walker(tree);
}

/**
 * Generates a list of basic fields any non-multipart part should have
 * 
 * @param {Object} node A tree node of the parsed mime tree
 * @return {Array} A list of basic fields 
 */
function getBasicFields(node){
    return [
        // body type
        node.parsedHeader['content-type'] && node.parsedHeader['content-type'].type || null,
        // body subtype
        node.parsedHeader['content-type'] && node.parsedHeader['content-type'].subtype || null,
        // body parameter parenthesized list
        node.parsedHeader['content-type'] && 
            node.parsedHeader['content-type'].hasParams && 
            flatten(Object.keys(node.parsedHeader['content-type'].params).map(function(key){
                return [key, node.parsedHeader['content-type'].params[key]];
            })) || null,
        // body id
        node.parsedHeader['content-id'] || null,
        // body description
        node.parsedHeader['content-description'] || null,
        // body encoding
        node.parsedHeader['content-transfer-encoding'] || null,
        // body size
        node.size
    ];
}

/**
 * Generates a list of extension fields any non-multipart part should have
 * 
 * @param {Object} node A tree node of the parsed mime tree
 * @return {Array} A list of extension fields 
 */
function getExtensionFields(node){
    return [
        // body MD5
        node.parsedHeader['content-md5'] || null,
        // body disposition
        node.parsedHeader['content-disposition'] && [
            node.parsedHeader['content-disposition'].value,
            flatten(Object.keys(node.parsedHeader['content-disposition'].params).map(function(key){
                return [key, node.parsedHeader['content-disposition'].params[key]];
            })) || null
        ] || null,
        // body language
        node.parsedHeader['content-language'] && 
            node.parsedHeader['content-language'].value.split(",").map(function(lang){
                return lang.trim();
            }) || null,
        // body location
        node.parsedHeader['content-location'] || null
    ];
}

/**
 * Processes a node with content-type=multipart/*
 * 
 * @param {Object} node A tree node of the parsed mime tree
 * @return {Array} BODYSTRUCTURE for a multipart part
 */
function processMultipartNode(node){
    return (node.childNodes && node.childNodes.map(createBodystructure) || [[]]).
        concat([
            // body subtype
            node.multipart,
            // body parameter parenthesized list
            node.parsedHeader['content-type'] && 
                node.parsedHeader['content-type'].hasParams && 
                flatten(Object.keys(node.parsedHeader['content-type'].params).map(function(key){
                    return [key, node.parsedHeader['content-type'].params[key]];
                })) || null]).
        // skip body MD5
        concat(getExtensionFields(node).slice(1));
}

/**
 * Processes a node with content-type=text/*
 * 
 * @param {Object} node A tree node of the parsed mime tree
 * @return {Array} BODYSTRUCTURE for a text part
 */
function processTextNode(node){
    return [].concat(getBasicFields(node)).
        concat([
            node.lineCount
        ]).concat(getExtensionFields(node));
}

/**
 * Processes a non-text, non-multipart node
 * 
 * @param {Object} node A tree node of the parsed mime tree
 * @return {Array} BODYSTRUCTURE for the part
 */
function processAttachmentNode(node){
    return [].concat(getBasicFields(node)).
        concat([
            node.lineCount
        ]).concat(getExtensionFields(node));
}

/**
 * Converts all sub-arrays into one level array
 * flatten([1,[2,3]]) -> [1,2,3]
 *
 * @param {Array} arr An array with possible sub-arrays
 * @return {Array} Flat array
 */
function flatten(arr){
    var result = [];
    if(Array.isArray(arr)){
        arr.forEach(function(elm){
            if(Array.isArray(elm)){
                result = result.concat(flatten(elm));
            }else{
                result.push(elm);
            }
        });
    }else{
        result.push(arr);
    }
    return result;
}