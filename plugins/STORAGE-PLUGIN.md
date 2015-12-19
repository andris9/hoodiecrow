# Storage Plugin

This document describes how to write a storage plugin, also known as a Mail Storage Driver (MSD). The purpose of an MSD is to provide Imapper with the ability to read messages and folders from and write them to a back-end store. 

A storage plugin must implement the MSD interface, as described below.


## Introduction
A mail service might store messages in many backends:

* filesystem
* SQL database
* NoSQL database
* Cloud storage like S3
* combinations

Additionally, the information might be split, e.g. attachments on the filesystem and message data in a database. Finally, the structure of the data may differ from one implementation to another.

The Mail Store Driver, or MSD, abstracts the details of implementation, providing a standard interface to mail storage for standard activities.

Each implementation of a storage plugin must follow the MSD specification.

## Overview
The MSD interface uses two concepts:

* `Connection`: Primary interface. To use a store, you open a "connection" to the store. Use the connection to select a mailbox.
* `Mailbox`: Manage an individual user's mailbox, including all of their folders. A mailbox is the primary interface for a user, and requires implementation of *all* of the actions that can be taken on a mailbox: retrieve a list of folders, search for folders, delete messages, create messages, copy messages, move messages, retrieve messages, flag messages, etc.

## Interface

Like all plugins, a users plugin should provide an initialized and instantiated object to imapper:

````javascript
var storage = require('imapper-storage-memory')({
  "INBOX":{},
  "INBOX.Trash":{}
});

// you now can pass storage to imapper
server = require('imapper')({
	storage: storage
});

````

### Initiation

The `storage` connection object passed to imapper as the value of the key `storage`, hereinafter referred to as a `connection` has the following methods:

* `connection.mailbox(name,user)`: prepare to use an individual mailbox by a given user


### Mailbox
When Imapper needs to connect to an individual mailbox, it will call the `connection.mailbox()` function, and expect to receive a `mailbox` object:

````javascript
var mailbox = connection.mailbox(name,user);
// e.g. connection.mailbox("john@smith.com","jim@smith.com");
````

The arguments to `connection.mailbox()` are:

* `name`: name of the mailbox to use. String. Required.
* `user`: who is accessing the mailbox. String. Optional. Defaults to `name` if not provided. 

The mailbox is returned synchronously, as no connection is created as of yet. The mailbox is expected to use the `user` parameter or, if left blank, the `name`, to determine if each action is allowed.

The returned `mailbox` object has the following properties and methods. All callbacks are of the signature `function(err,data)`

* `folders(callback)`: retrieve all folders for this mailbox. Will pass `data` to the callback as an array of `folder` objects, or an empty array if none found.
* `getFolder(name,callback)`: get folder in this mailbox whose name matches `name`. Will pass `data` to the callback as an array of folder objects, or an empty array if none found. If the folder cannot be selected, callback `err` as `{noselect: true}`
* `createFolder(name,callback)`: create a new folder in this mailbox with the name `name`. Will pass `data` to the callback as a new `folder` object. If creation fails, pass an error to the callback.
* `delFolder(name, callback)`: delete the named folder with all of its messages. If it fails, pass an error to the `err` argument of the callback.
* `renameFolder(folder,name,callback)`: change the name of the named folder to `newName`. If it fails, pass an error to the `err` argument of the callback.
* `createMessage(folder,content,callback)`: add a message to the named folder with the content object `content`. If it fails, pass an error to the `err` argument of the callback. 
* `listMessages(folder,callback)`: retrieve an array of the IDs of all messages in the named folder, or an empty array for none. Pass the array to the callback as the `data` argument.
* `searchMessages(folder,pattern,callback)`: retrieve an array of the IDs of all messages in the named folder that match the search pattern, or an empty array for none. Pass the array to the callback as the `data` argument. See below for search details.
* `getMessages(folder,ids,[options,]callback)`: retrieve actual message objects with their data for the given `ids` from the named folder. Pass the resultant `message` objects to the `data` argument of the callback. See below for details.
* `getRange(folder,range,[options,]callback)`: retrieve actual message objects with their data based on a `range` from a given folder. Pass the resultant `message` objects to the `data` argument of the callback. See below for details.
* `delMessage(folder,id,callback)`: delete this message. If it deletes or moves to trash is dependent on the implementation. 
* `moveMessage(folder,newFolder,id,callback)`: move this message to another folder. You must provide another `folder` object, normally retrieved via `mailbox.find(folderName, callback)`. 
* `copyMessage(folder,newFolder,id,callback)`: move this message to another folder. You must provide another `folder` object, normally retrieved via `mailbox.find(folderName, callback)`. 
* `readMessage(folder,id,read,callback)`: mark this message as read, if `read` is `true`, or unread, if `read` is false. Marking an already read message as read (`true`) is *not* an error, nor is marking an unread message as unread (`false`). 
* `starMessage(folder,id,star,callback)`: mark this message as starred, if `star` is `true`, or unstarred, if `star` is false. Marking an already starred message as starred (`true`) is *not* an error, nor is marking an unstarred message as unstarred (`false`). 
* `setFolderSpecialUse(folder,flags,callback)`: Set this folder to be special use, per RFC6514, for the given array of flags.
* `expunge(folder,ignoreSelf,ignoreExists,callback)`: Expunge deleted messages from a given folder. 
* `getNamespaces(callback)`: List the available namespaces.

#### Methods

##### callbacks
All methods are expected to be asynchronous. The callback signature always should be `function(err,data)`. Any returned value should be in `data`, while errors should be in `err`.

A `null` or `undefined` value for `err` is treated as "there was no error executing this command."

If the executed command failed because it called for a missing item, the `err` is expected to be a string with the following values:

* `"invalid folder"`: The requested folder is invalid or missing.
* `"invalid message"`: The requested message is invalid or missing.




##### searchMessages

The `pattern` argument to `search()` is an object each of whose keys is a field to match, while each value is a string that will be matched to that field in the message, if the field *contains* that string. For example, `{to:'mith'}` will match the following recipients: mith, smith, jim@smith.com.

Regular expression searching is **not** supported.

As of this writing, only the `subject`, `to` and `from` fields are searched. `body` and `text` will be added later.

##### getMessages

`getMessages()` is the primary method of retrieving messages. You normally use `searchMessages()` or `listMessages()` to get a list of IDs, and then `getMessages()` to get actual message(s). The resultant messages are passed to the `data` argument of the callback.

The following arguments are provided:

* `folder`: the fill path to folder from which to retrieve the messages.
* `ids`: a single ID to retrieve, or an array of IDs. If a single `id`, the result will be a single `message` object or, if not found, then `null`. If an array of `id`, the result will be an array of `message` objects or, if not found, an empty array.
* `options`: hash of options. These are as follows:
   * `attachments`: boolean `true`/`false` whether to include attachments. URLs always will be provided to access the attachments, if available.
   * `raw`: boolean `true`/`false` whether to include the raw text message as part of the Message. URL always will be provided to access the raw message, if available.
   * `html`: boolean `true`/`false` whether to include the html message, if provided, as part of the Message. URL always will be provided to access the html message, if available.
   * `headers`: boolean `true`/`false` whether to include the headers as part of the Message. URL always will be provided to access the headers of the message, if available.
    * `all`: boolean `true`/`false` whether to include all options (`attachments`, `raw`, `html`, `headers`). Shortcut. Defaults to `false`.
* `callback(err,data)`: callback to call when messages are ready.


##### createMessage

`createMessage()` creates a new message in the given folder. It has the following signature:

* `folder`: the full path of the folder in which to create the message
* `content`: the content of the message to create
* `callback`: the callback to call when creation is complete

The `content` must be an object, and has the following properties:

* `to`: The recipient address. Optional.
* `from`: The sender address. Required.
* `subject`: Optional.
* `date`: The date of creation. Optional. If not provided, will automatically give it the date at moment of receipt.
* `raw`: Raw complete message. Required.
* `html`: html version of the message. Optional.
* `attachments`: Array of attachments. Optional. Each element of the array is an object with the following properties. All are required.
    * `filename`: String. Name of the file for the attachment.
    * `type`: String. MIME type of the attachment.
    * `content`: Buffer. Body of the attachment.


##### expunge
`expunge()` expunges (i.e. permanently deletes) messages marked as deleted. It has the following signature:

* `folder`: the full path of the folder whose deleted messages should be expunged
* `callback`: the callback to call when expunge is complete

The callback is expected to return an error message if there is an error. If there is no error, it is expected to return a `data` object with the following properties:

* `exists`: new total number of messages in this folder after expunge has been completed
* `expunged`: an array of integers indicating which messages in this inbox were expunged

##### getNamespaces
`getNamespaces()` lists the available namespaces. It has no arguments except for the `callback`. The `callback` is expected to receive an error if there is an error. The data for the callback should have a single object, with the following properties:

* `personal`: An array of personal namespaces.
* `shared`: The array of shared namespaces.
* `users`: The list of other users' namespaces.

Each value in each array is expected to be an object with two properties:

* `name`: The name of the namespace.
* `separator`: The separator character for the namespace.

Example of a single personal namespaces, no other users' namespaces, and 2 shared namespaces.

````json
{
  "personal": [{"name": "", "separator": "/"}],
  "users": [],
  "shared": [{"name":"#ftp/","separator":"."}, {"name":"#public/","separator":"."}]
}
````

#### Returned Objects
The commands on a `mailbox` object can return either `folder` or `message` objects.

##### Folder
The methods that return folders are expected to return objects that have the following properties:

* `name`: name of the folder
* `id`: unique ID of the folder, if relevant
* `path`: full path to the folder
* `allowPermanentFlags`: boolean whether or not this folder allows permanent flags.
* `uidnext`: string. The next available UID.
* `uidvalidity`: string. The UID for this session.
* `flags`: object with a key representing the name of each flag on a message in the folder, and the value an integer of the number of messages on which it appears.
* `seen`: integer with the number of messages that have the `Seen` flag set
* `unseen`: integer with the number of messages that do not have the `Seen` flag set
* `permanentFlags`: array of strings, with each element representing a unique permanent flag in this folder
* `messages`: integer, total number of messages in this folder.
* `separator`: character, the separator for this folder. Separators normally are by namespace. It is up to the implementation to ensure the separator is listed on each folder object that it returns.

##### Message
The methods that return messages are expected to return objects that have the following properties:

* `properties`: object with the properties of the message. Synchronous.
* `raw`: the raw text body of the message, if option `raw` or `all` is `true`. Synchronous.
* `raw_url`: URL to retrieve the text body of the message, if available. Synchronous.
* `headers`: the raw text headers of the message, if option `headers` or `all` is `true`. Synchronous.
* `headers_url`: URL to retrieve the headers of the message, if available. Synchronous.
* `html`: the html body of the message, if option `html` or `all` is `true`. Synchronous.
* `html_url`: URL to retrieve the html form of the message, if available. Synchronous.
* `attachments`: an array with the attachments of the message. See below. Synchronous.


###### Attachments
When a message is provided, the `attachments` property **always** is an array whose length matches the number of attachments. If there are no attachments, it is a zero-length array.

Each element of the array is an object with the following properties:

* `url`: a URL to the attachment, only if the attachment can be retrieved via URL. It is up to the MSD implementation to determine if and how to provide this URL. For example, it might be a URL that is accessible only via authentication, or it might be a time-limited or unlimited signed URL for S3 access.
* `content`: The actual attachment itself. This is populated only if, when `folder.get(mid)` was called, the option `attachments` or `all` set to `true`.






