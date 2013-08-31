"use strict";

var net = require("net"),
    crypto = require("crypto"),
    tls = require("tls");

/**
 * @namespace Mockup module
 * @name mockup
 */
module.exports = runClientMockup;

/**
 * <p>Runs a batch of commands against a server</p>
 * 
 * <pre>
 * var cmds = ["A1 CAPABILITY", "A2 STARTTLS", "A3 LOGIN username password", "LOGOUT"];
 * runClientMockup(143, "localhost", cmds, function(resp){
 *     console.log("Final:", resp.toString("utf-8").trim());
 * });
 * </pre>
 * 
 * @memberOf mockup
 * @param {Number} port Port number
 * @param {String} host Hostname to connect to
 * @param {Array} commands Command list to be sent to server
 * @param {Function} callback Callback function to run on completion,
 *        has the last response from the server as a param
 * @param {Boolean} [debug] if set to true log all input/output
 */
function runClientMockup(port, host, commands, debug, callback){
    host = host || "localhost";
    port = port || 25;
    commands = Array.isArray(commands) ? commands : [];

    var ignore_data = false, sslcontext, pair, responses = [];

    var socket = net.connect(port, host),
        command = "";

    socket.on("connect", function(){
        socket.on("data", function(chunk){
            if(ignore_data)return;
            
            responses.push(chunk);
            if(debug){
                console.log("S: "+chunk.toString("utf-8").trim());
            }
            
            if(!commands.length){
                socket.end();
                if(typeof callback == "function"){
                    callback(chunk);
                }
                return;
            }
            
            if(command.match(/^[a-z0-9]+ STARTTLS$/i)){
                ignore_data = true;
                if(debug){
                    console.log("Initiated TLS connection");
                }
                sslcontext = crypto.createCredentials();
                pair = tls.createSecurePair(sslcontext, false);
                
                pair.encrypted.pipe(socket);
                socket.pipe(pair.encrypted);
                pair.fd = socket.fd;
                
                pair.on("secure", function(){
                    if(debug){
                        console.log("TLS connection secured");
                    }
                    command = commands.shift();
                    if(debug){
                        console.log("C: "+command);
                    }
                    pair.cleartext.write(command+"\r\n");

                    pair.cleartext.on("data", function(chunk){

                        responses.push(chunk);
                        if(debug){
                            console.log("S: "+chunk.toString("utf-8").trim());
                        }
                        
                        if(!commands.length){
                            pair.cleartext.end();
                            if(typeof callback == "function"){
                                callback(Buffer.concat(responses));
                            }
                            return;
                        }
                        command = commands.shift();
                        pair.cleartext.write(command+"\r\n");
                        if(debug){
                            console.log("C: "+command);
                        }
                    });
                });
            }else{
                command = commands.shift();
                socket.write(command+"\r\n");
                if(debug){
                    console.log("C: "+command);
                }
            }
        });
    });
    
}