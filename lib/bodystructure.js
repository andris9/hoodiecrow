
module.exports = createBodystructure;

function createBodystructure(tree){
    var walker = function(node){
        switch((node.parsedHeader["content-type"] || {}).type){
            case "multipart":
                return processMultipartNode(node);
            case "text":
                return processTextNode(node);
            default:
                return processAttachmentNode(node);
        };
    }
    return walker(tree);
}

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

function processMultipartNode(node){
    
    var list = node.childNodes && node.childNodes.map(createBodystructure) || [];

    return list.concat([
        node.multipart,
        node.parsedHeader['content-type'] && 
            node.parsedHeader['content-type'].hasParams && 
            flatten(Object.keys(node.parsedHeader['content-type'].params).map(function(key){
                return [key, node.parsedHeader['content-type'].params[key]];
            })) || null,
        node.parsedHeader['content-md5'] || null,
        node.parsedHeader['content-disposition'] && [
            node.parsedHeader['content-disposition'].value,
            flatten(Object.keys(node.parsedHeader['content-disposition'].params).map(function(key){
                return [key, node.parsedHeader['content-disposition'].params[key]];
            })) || null
        ] || null,
        node.parsedHeader['content-language'] &&
            flatten(node.parsedHeader['content-language']).pop().split(",").map(function(lang){
                return lang.trim();
            }) || null,
        node.parsedHeader['content-location'] || null
    ]);
}

function processTextNode(node){
    return [
        node.parsedHeader['content-type'] && node.parsedHeader['content-type'].type || null,
        node.parsedHeader['content-type'] && node.parsedHeader['content-type'].subtype || null,
        node.parsedHeader['content-type'] && 
            node.parsedHeader['content-type'].hasParams && 
            flatten(Object.keys(node.parsedHeader['content-type'].params).map(function(key){
                return [key, node.parsedHeader['content-type'].params[key]];
            })) || null,
        node.parsedHeader['content-id'] || null,
        node.parsedHeader['content-description'] || null,
        node.parsedHeader['content-transfer-encoding'] || null,
        node.size,
        node.lineCount,
        node.parsedHeader['content-md5'] || null,
        node.parsedHeader['content-disposition'] && [
            node.parsedHeader['content-disposition'].value,
            flatten(Object.keys(node.parsedHeader['content-disposition'].params).map(function(key){
                return [key, node.parsedHeader['content-disposition'].params[key]];
            })) || null
        ] || null,
        node.parsedHeader['content-language'] && 
            node.parsedHeader['content-language'].value.split(",").map(function(lang){
                return lang.trim();
            }) || null,
        node.parsedHeader['content-location'] || null
    ];
}

function processAttachmentNode(node){
    return [
        node.parsedHeader['content-type'] && node.parsedHeader['content-type'].type || null,
        node.parsedHeader['content-type'] && node.parsedHeader['content-type'].subtype || null,
        node.parsedHeader['content-type'] && 
            node.parsedHeader['content-type'].hasParams && 
            flatten(Object.keys(node.parsedHeader['content-type'].params).map(function(key){
                return [key, node.parsedHeader['content-type'].params[key]];
            })) || null,
        node.parsedHeader['content-id'] || null,
        node.parsedHeader['content-description'] || null,
        node.parsedHeader['content-transfer-encoding'] || null,
        node.size,
        node.parsedHeader['content-md5'] || null,
        node.parsedHeader['content-disposition'] && [
            node.parsedHeader['content-disposition'].value,
            flatten(Object.keys(node.parsedHeader['content-disposition'].params).map(function(key){
                return [key, node.parsedHeader['content-disposition'].params[key]];
            })) || null
        ],
        node.parsedHeader['content-language'] && 
            node.parsedHeader['content-language'].value.split(",").map(function(lang){
                return lang.trim();
            }) || null,
        node.parsedHeader['content-location'] || null
    ];
}