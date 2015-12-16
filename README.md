# Imapper

Imapper is an IMAP Server. It is descended directly from [Hoodiecrow](https://github.com/andris9/hoodiecrow). However, Hoodiecrow is intended expicitly as a test server, not for production use. It only supports in-memory message storage, single user, no external authentication, and many other limitations. In the words of the talented [Andris Reiman](https://github.com/andris9), it is intended only for testing.

Imapper builds on hoodiecrow to turn it into the first usable, pluggable, production-quality IMAP server written entirely in nodejs.

Pluggable components include:

* User database: list of users can be from config file, memory, active directory, LDAP, database, or anywhere.
* Message store: The actual message storage can be in memory (ephemeral), on local disk, in NFS, an object store, or anywhere. It can be stored in any format, if a plugin exists to support it.


Imapper offers [IMAP4ver1](http://tools.ietf.org/html/rfc3501) support.


# Usage

### Run as a standalone server

To run Imapper you need [Node.js](http://nodejs.org/) in your machine. Node should work on almost any platform, so Imapper should too.

If you have Node.js installed, install Imapper with the `npm` command and run it:

```bash
npm install -g imapper
sudo imapper
```

Sudo is needed to bind to port 143 (default for IMAP) or 993 (default for IMAP over SSL). If you choose to use a higher port, say 1143 (`imapper -p 1143`), you do not need to use sudo.

`imapper` command also provides an incoming SMTP server which distributes all incoming messages
appropriately. To use it, use *smtpPort* option (`hoodiecrow --smtpPort=1025`). **The SMTP server has no proper filtering, security and scaling. You should not use the SMTP server in any production environment.** If you need a production quality SMTP server in nodejs, check out Haraka.

> **Protip** Running `imapper --help` displays useful information about command line options for Imapper and some sample configuration data.

After you have started Imapper server, you can point your IMAP client to `<hostname>:143`. Use the correct username and password as configured.

### Include as a Node.js module

Add `imapper` dependency

```bash
npm install --save imapper
```

Create and start an IMAP server

```javascript
var imapper = require("imapper"),
    server = imapper(options);
server.listen(143);
```

See [complete.js](https://github.com/deitch/imapper/blob/master/examples/complete.js) for an example.


## Configuration
Imapper requires configuration to tell it how to work. 


### Providing COnfiguration
The configuration is provided either as a JSON config file or a configuration object, depending on how Imapper is launched. In both ways, the structure of the configuration is identical and is described below.

#### Command-Line
When launched from the command-line, Imapper requires a JSON configuration file. The path to the config file should be provided. If not, it will look for a file named `imapper.json` in the current directory from which `imapper` was launched. 

If no config file is provided, and `imapper.json` is not available in the current directory, Imapper will exit with an error.

#### Module
When Imapper is included as a module inside a nodejs program, you should **not** provide a configuration file. Instead, you should provide the JSON structure that would be in that config file as the `options` parameter. 

Essentially, launching `imapper --config=/some/file.json` from the command-line is equivalent to:

````javascript
var imapper = require("imapper"),
  config = require('/some/file.json'),
  server = imapper(config);
server.listen(config.port);
````

### Configuration Structure

The configuration object or file contains information on how to configure, launch and run Imapper. 

````json
{
  port: 143,
	tls: true,
	ssl: 993,
	authentication: {
		name: 'imapper_ldap;
		config: {...}
	},
	storage: {
		name: 'imapper_file'
		config: {...}
	}
}
````

Each key in the configuration represents a configurable element of Imapper.

* `port`: The port to listen for in-the-clear or TLS-upgradable IMAP. Optional. Defaults to `143`.
* `tls`: Whether to support upgradable TLS connections. Optional. Defaults to `false`.
* `ssl`: The port to listen for SSL connections. Optional. If not present, will not listen for SSL.
* `authentication`: Configuration for the plugin to use for authentication. Required. Object. See below.
* `storage`: Configuration for the plugin to use for message and folder storage. Required. Object. See below.

Each section of configuration that represents a plugin is represented as an object with two parts:

* `name`: The name of the plugin to use for configuration. This must be a plugin available by installing via `npm install`.
* `config`: The configuration to pass to the plugin. Unique for each plugin.

Note that a plugin need not be distributed to the central npm store to be usable. The [npm site](npmjs.com) provides multiple ways to include a package, including directly from github, your local filesystem or other methods. 

For a plugin to be usable, the module named in the `name` section **must** be installed in the local `node_modules/` via `npm install`. For example, if you intend to use a storage engine called `'imapper_file'`', the module `'imapper_file'` must already be installed. **Imapper does not do `npm install` for you.**


### Available Plugins

The following plugins are available in npm as of this writing.

#### imapper_memoryStorage
A simple plugin that stores all mail messages in memory. Terminating the server means they are lost.

This plugin supports reading its initial data from a file or object. In the `config` object, provide one of the following:

* `data`: The actual data to load
* `file`: A JSON file containing the data to load.

Note that this plugin replicates the behaviour of the original hoodiecrow.

````json
// straight data
{
	storage: {
		name: 'imapper_memoryStorage'
		config: {
			data: {
		    "INBOX":{},
		    "INBOX.Trash":{}
			}
		}
	}
}


// from the configuration file
{
	storage: {
		name: 'imapper_memoryStorage'
		config: {
			file: '/path/to/config/file.json
		}
	}
}
````

#### imapper_htpasswdUsers
Read usernames for authentication from an htpasswd file.

Provide the path to the htpasswd file in the `config` as the option `file`.

````json
{
	authentication: {
		name: 'imapper_htpasswdUsers'
		config: {
			file: '/path/to/htpasswd'
		}
	}
}
````

#### imapper_staticUsers
Include users directly in the configuration. 

In the `config`, each key is a username, while each value is a Bcrypt encrypted password.


````json
{
	authentication: {
		name: 'imapper_staticUsers'
		config: {
			john: 'dasabsb657223asasa',
			jill: 'sasaswqwdbsb657223'
		}
	}
}
````



### Writing Plugins
To write a plugin, you must follow the conventions for each type of plugin. Look in the directory `plugins/` for a README for each type of plugin and a sample.


## Status

### IMAP4rev1

All commands are supported but might be a bit buggy

### Supported Plugins

Plugins can be enabled when starting the server but can not be unloaded or loaded when the server is already running.
All plugins are self contained and not tied to core. If you do not enable a plugin, no trace of it is left
to the system. For example, if you do not enable CONDSTORE, messages do not have a MODSEQ value set.

  * **AUTH-PLAIN** Adds AUTH=PLAIN capability. Supports SASL-IR [RFC4959] as well
  * **CONDSTORE** Partially implemented CONDSTORE [RFC4551] support
  * **CREATE-SPECIAL-USE** Enables CREATE-SPECIAL-USE [RFC6154] capability. Allowed special flags can be set with server option `"special-use"`
  * **ENABLE** Adds ENABLE capability [RFC5161]. Must be loaded before any plugin that requires ENABLE support (eg. CONDSTORE)
  * **ID** Adds ID [RFC2971] capability
  * **IDLE** Adds IDLE [RFC2177] capability
  * **LITERALPLUS** Enables LITERAL+ [RFC2088] capability
  * **LOGINDISABLED** Disables LOGIN support for unencrypted connections
  * **NAMESPACE** Adds NAMESPACE [RFC2342] capability
  * **SASL-IR** Enables SASL-IR [RFC4959] capability
  * **SPECIAL-USE** Enables SPECIAL-USE [RFC6154] capability Mailboxes need to have a "special-use" property (String or Array) that will be used as extra flag for LIST and LSUB responses
  * **STARTTLS** Adds STARTTLS command
  * **UNSELECT** Adds UNSELECT [RFC3691] capability
  * **X-GM-EXT-1** Adds partial support for [Gmail specific](https://developers.google.com/gmail/imap_extensions) options. `X-GM-MSGID` is fully supported, `X-GM-LABELS` is partially supported (labels can be STOREd and FETCHed but setting a label does not change message behavior, for example the message does not get copied to another mailbox). `X-GM-THRID` is not supported as I haven't figured threading out yet.
  * **XOAUTH2** GMail XOAUTH2 login. Only works with SALS-IR, if you need non SASL-IR support as well, let me know. Use `"testuser"` as the username and `"testtoken"` as Access Token to log in.
  * **XTOYBIRD** Custom plugin to allow programmatic control of the server. Login not required to use XTOYBIRD commands

Planned but not yet implemented

  * **MOVE**
  * **UIDPLUS**
  * **QUOTA**


## Existing XTOYBIRD commands

To use these functions, XTOYBIRD plugin needs to be enabled

Available commands:

  * **XTOYBIRD SERVER** dumps server internals
  * **XTOYBIRD CONNECTION** dumps connection internals
  * **XTOYBIRD STORAGE** dumps storage as JSON
  * **XTOYBIRD USERADD "username" "password"** adds or updates user
  * **XTOYBIRD USERDEL "username"** removes an user
  * **XTOYBIRD SHUTDOWN** Closes the server after the last client disconnects. New connections are rejected.

Example usage for XTOYBIRD STORAGE:

```
S: * Hoodiecrow ready for rumble
C: A1 XTOYBIRD STORAGE
S: * XTOYBIRD [XJSONDUMP] {3224}
S: {
S:     "INBOX": {
S:         "messages": [
S:             {
S:                 "raw": "Subject: hello 1\r\n\r\nWorld 1!",
S:                 ...
S: A1 OK XTOYBIRD Completed
```


# Known issues

  * *INBOX** as a separate namespace and managing INBOX subfolders is a mess. CREATE seems to work, DELETE is buggy and RENAME doesn't work with INBOX subfolders (unless the default namespace is `"INBOX."`, not `""`). I need to rethink how this works.

Not sure if these should be fixed or not

  * **STORE** does not emit notifications to other clients
  * **MODSEQ** updates are not notified

These issues are probably not going to get fixed

  * **Session flags** are not supported (this means that `\Recent` flag is also not supported)
  * **addr-adl** (at-domain-list) values are not supported, NIL is always used
  * **anonymous namespaces** are not supported
  * **STORE** returns NO and nothing is updated if there are pending EXPUNGE messages
  * **CHARSET** argument is ignored

# Running tests

Running tests requires you to have grunt-cli installed

    npm install -g grunt-cli

After which you can run

    grunt

or

    npm test

## Example configs

### Cyrus

config.json:

```json
{
    "INBOX":{},
    "INBOX.":{},
    "user.":{
        "type":"user"
    },
    "":{
        "type":"shared"
    }
}
```



## Creating custom plugins

A plugin can be a string as a pointer to a built in plugin or a function. Plugin function is run when the server is created and gets server instance object as an argument.

```javascript
hoodiecrow({
    // Add two plugins, built in "IDLE" and custom function
    plugin: ["IDLE", myAwesomePlugin]
});

// Plugin handler
function myAwesomePlugin(server){

    // Add a string to the capability listing
    server.registerCapability("XSUM");

    /**
     * Add a new command XSUM
     * If client runs this command, the response is a sum of all
     * numeric arguments provided
     *
     * A1 XSUM 1 2 3 4 5
     * * XSUM 15
     * A1 OK SUM completed
     *
     * @param {Object} connection - Session instance
     * @param {Object} parsed - Input from the client in structured form
     * @param {String} data - Input command as a binary string
     * @param {Function} callback - callback function to run
     */
    server.setCommandHandler("XSUM", function(connection, parsed, data, callback){

        // Send untagged XSUM response
        connection.send({
            tag: "*",
            command: "XSUM",
            attributes:[
                [].concat(parsed.attributes || []).reduce(function(prev, cur){
                    return prev + Number(cur.value);
                }, 0)
            ]
        }, "XSUM", parsed, data);

        // Send tagged OK response
        connection.send({
            tag: parsed.tag,
            command: "OK",
            attributes:[
                // TEXT allows to send unquoted
                {type: "TEXT", value: "XSUM completed"}
            ]
        }, "XSUM", parsed, data);
        callback();
    });
}
```

### Plugin mehtods

#### Add a capability

    server.registerCapability(name[, availabilty])

Where

  * **name** a string displayed in the capability response
  * **availability** a function which returns boolean value. Executed before displaying the capability response. If the function returns true, the capability is displayed, if false then not.

Example

```javascript
// Display in CAPABILITY only in Not Authenticated state
server.registerCapability("XAUTH", function(connection){
    return connection.state == "Not Authenticated";
});
```

#### Define a command

    server.setCommandHandler(name, handler)

Where

  * **name** is the command name
  * **handler** *(connection, parsed, data, callback)* is the handler function for the command

Handler arguments

  * **connection** - Session instance
  * **parsed** - Input from the client in structured form (see [imap-handler](https://github.com/andris9/imap-handler#parse-imap-commands) for reference)
  * **data** - Input command as a binary string
  * **callback** - callback function to run (does not take any arguments)

The command should send data to the client with `connection.send()`

    connection.send(response, description, parsed, data, /* any additional data */)

Where

  * **response** is a [imap-handler](https://github.com/andris9/imap-handler#parse-imap-commands) compatible object. To get the correct tag for responsing OK, NO or BAD, look into `parsed.tag`
  * **description** is a string identifying the response to be used by other plugins
  * **parsed** is the `parsed` argument passed to the handler
  * **data** is the `data` argument passed to the handler
  * additional arguments can be used to provide input for other plugins

#### Retrieve an existing handler

To override existing commands you should first cache the existing command, so you can use it in your own command handler.

    server.getCommandHandler(name) -> Function

Where

  * **name** is the function name

Example

```javascript
var list = server.getCommandHandler("LIST");
server.setCommandHandler("LIST", function(connection, parsed, data, callback){
    // do something
    console.log("Received LIST request");
    // run the cached command
    list(connection, parsed, data, callback);
});
```

#### Reroute input from the client

If your plugin needs to get direct input from the client, you can reroute the incoming data by defining a `connection.inputHandler` function. The function gets input data as complete lines (without the linebreaks). Once you want to reroute the input back to the command handler, just clear the function.

```
connection.inputHandler = function(line){
    console.log(line);
    connection.inputHandler = false;
}
```

See [idle.js](https://github.com/andris9/hoodiecrow/blob/master/lib/plugins/idle.js) for an example

#### Override output

Any response sent to the client can be overriden or cancelled by other handlers. You should append your handler to `server.outputHandlers` array. If something is being sent to the client, the response object is passed through all handlers in this array.

    server.outputHandlers.push(function(connection, /* arguments from connection.send */){})

`response` arguments from `connection.send` is an object and thus any modifications will be passed on. If `skipResponse` property is added to the response object, the data is not sent to the client.

```javascript
// All untagged responses are ignored and not passed to the client
server.outputHandlers.push(function(connection, response, description){
    if(response.tag == "*"){
        response.skipResponse = true;
        console.log("Ignoring untagged response for %s", description);
    }
});
```

#### Other possbile operations

It is possible to append messages to a mailbox; create, delete and rename mailboxes; change authentication state and so on through the `server` and `connection` methods and properties. See existing command handlers and plugins for examples.

# License

**MIT**
