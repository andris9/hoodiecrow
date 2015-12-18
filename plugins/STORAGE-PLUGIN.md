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
The MSD interface uses four concepts:

* `Connection`: Primary interface. To use a store, you open a "connection" to the store. Use the connection to select a mailbox.
* `Mailbox`: Manage an individual user's mailbox, including all of their folders. Use a mailbox to find folders, list all folders, or create a new folder.
* `Folder`: Manage a collection of messages. Use a folder to delete the folder, rename it, retrieve message IDs by search, retrieve all message IDs, save a new message, or retrieve one or more actual messages.
* `Message`: Represents an individual message. Use a message to get all data about a message, including raw data and attachments, delete a message, move a message to a different folder, mark it as read/unread, mark it as starred/unstarred.

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
* `select(name,callback)`: select folder in this mailbox whose name matches `name`. Will pass `data` to the callback as an array of `folder` objects, or an empty array if none found. If the folder cannot be selected, callback `err` as `{noselect: true}`
* `create(name,callback)`: create a new folder in this mailbox with the name `name`. Will pass `data` to the callback as a new `folder` object. If creation fails, pass an error to the callback.

### Folder
Managing an individual folder and working with the messages in that folder requires a `folder` object. As described above, a `folder` object is retrieved via `mailbox` methods.

The returned `folder` object has the following properties and methods. All callbacks are of the signature `function(err,data)`

* `properties`: an object with all of the properties of the folder, e.g. `name`, `id`, etc. Synchronous.
* `status`: an object with status of the folder information. Synchronous. See below.
* `allowPermanentFlags`: boolean whether or not this folder allows permanent flags.
* `messages`: integer, total number of messages in this folder.
* `uidnext`: string. The next available UID.
* `uidvalidity`: string. The UID for this session.
* `del(callback)`: delete this folder with all of its messages. If it fails, pass an error to the `err` argument of the callback.
* `rename(name,callback)`: change the name of this folder to `name`. If it fails, pass an error to the `err` argument of the callback.
* `createMessage(content,callback)`: add a message to this folder with the content object `content`. If it fails, pass an error to the `err` argument of the callback. 
* `list(callback)`: retrieve an array of the IDs of all messages in this folder, or an empty array for none. Pass the array to the callback as the `data` argument.
* `search(pattern,callback)`: retrieve an array of the IDs of all messages in this folder that match the search pattern, or an empty array for none. Pass the array to the callback as the `data` argument. See below for search details.
* `get(ids,[options,]callback)`: retrieve actual message objects with their data for the given `ids`. Pass the resultant `message` objects to the `data` argument of the callback. See below for details.


#### status
`folder.status` is an object with status information about the folder. Its properties are as follows:

* `flags`: object with a key representing the name of each flag on a message in the folder, and the value an integer of the number of messages on which it appears.
* `seen`: integer with the number of messages that have the `Seen` flag set
* `unseen`: integer with the number of messages that do not have the `Seen` flag set
* `permanentFlags`: array of strings, with each element representing a unique permanent flag in this folder


#### search

The `pattern` argument to `search()` is an object each of whose keys is a field to match, while each value is a string that will be matched to that field in the message, if the field *contains* that string. For example, `{to:'mith'}` will match the following recipients: mith, smith, jim@smith.com.

Regular expression searching is **not** supported.

As of this writing, only the `subject`, `to` and `from` fields are searched. `body` and `text` will be added later.

#### get

`get()` is the primary method of retrieving messages. You normally use `search()` or `list()` to get a list of IDs, and then `get()` to get actual message(s). The resultant messages are passed to the `data` argument of the callback.

The following arguments are provided:

* `ids`: a single ID to retrieve, or an array of IDs. If a single `id`, the result will be a single `message` object or, if not found, then `null`. If an array of `id`, the result will be an array of `message` objects or, if not found, an empty array.
* `options`: hash of options. These are as follows:
   * `attachments`: boolean `true`/`false` whether to include attachments. URLs always will be provided to access the attachments, if available.
   * `raw`: boolean `true`/`false` whether to include the raw text message as part of the Message. URL always will be provided to access the raw message, if available.
   * `html`: boolean `true`/`false` whether to include the html message, if provided, as part of the Message. URL always will be provided to access the html message, if available.
   * `headers`: boolean `true`/`false` whether to include the headers as part of the Message. URL always will be provided to access the headers of the message, if available.
    * `all`: boolean `true`/`false` whether to include all options (`attachments`, `raw`, `html`, `headers`). Shortcut. Defaults to `false`.
* `callback(err,data)`: callback to call when messages are ready.


#### createMessage

`folder.createMessage()` creates a new message in the given folder. It has the following signature:

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



### Message
Use a `message` object to manage an individual message. 

The `message` object supports the following properties and methods:

* `properties`: object with the properties of the message. Synchronous.
* `raw`: the raw text body of the message, if option `raw` or `all` is `true`. Synchronous.
* `raw_url`: URL to retrieve the text body of the message, if available. Synchronous.
* `headers`: the raw text headers of the message, if option `headers` or `all` is `true`. Synchronous.
* `headers_url`: URL to retrieve the headers of the message, if available. Synchronous.
* `html`: the html body of the message, if option `html` or `all` is `true`. Synchronous.
* `html_url`: URL to retrieve the html form of the message, if available. Synchronous.
* `attachments`: an array with the attachments of the message. See below. Synchronous.
* `del(callback)`: delete this message. If it deletes or moves to trash is dependent on the implementation. 
* `move(folder,callback)`: move this message to another folder. You must provide another `folder` object, normally retrieved via `mailbox.find(folderName, callback)`. 
* `read(read,callback)`: mark this message as read, if `read` is `true`, or unread, if `read` is false. Marking an already read message as read (`true`) is *not* an error, nor is marking an unread message as unread (`false`). 
* `star(star,callback)`: mark this message as starred, if `star` is `true`, or unstarred, if `star` is false. Marking an already starred message as starred (`true`) is *not* an error, nor is marking an unstarred message as unstarred (`false`). 


#### Attachments
When a message is provided, the `attachments` property **always** is an array whose length matches the number of attachments. If there are no attachments, it is a zero-length array.

Each element of the array is an object with the following properties:

* `url`: a URL to the attachment, only if the attachment can be retrieved via URL. It is up to the MSD implementation to determine if and how to provide this URL. For example, it might be a URL that is accessible only via authentication, or it might be a time-limited or unlimited signed URL for S3 access.
* `content`: The actual attachment itself. This is populated only if, when `folder.get(mid)` was called, the option `attachments` or `all` set to `true`.

