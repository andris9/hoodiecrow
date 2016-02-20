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

* `getFolder(path,callback)`: get folder in this mailbox whose path matches `path`. Will pass `data` to the callback as an array of folder objects, or an empty array if none found. If the folder cannot be selected, callback `err` as `{noselect: true}`
* `createFolder(path,callback)`: create a new folder in this mailbox with the path `path`. Will pass `data` to the callback as a new `folder` object. If creation fails, pass an error to the callback.
* `delFolder(path, callback)`: delete the named folder at `path` with all of its messages. If it fails, pass an error to the `err` argument of the callback.
* `renameFolder(source, destination, callback)`: rename the named folder at `source` with the new path `destination`. If it fails, pass an error to the `err` argument of the callback.
* `createMessage(folder,content,callback)`: add a message to the named folder with the content object `content`. If it fails, pass an error to the `err` argument of the callback. 
* `addFlags(folder,ids,isUid,flags,callback)`: add the flags in `flags` to message(s) `ids` in folder `folder`. `ids` is index in the folder if `isUid` is false or undefined, or the UID of the messages if `true`. `ids` is a string in the format to match a range of messages. See below "Range of Messages". `flags` must be an array of String flags. If the message(s) or folder do not exist, return an error. If the flags already exist on message, do not return an error, as this call should be idempotent. `data` returned in the callback should be an array of changed messages, each of which should be an object with the properties `index`, `uid` and `flags`.
* `removeFlags(folder,ids,isUid,flags,callback)`: remove the flags in `flags` from message(s) `ids` in folder `folder`. `ids` is index in the folder if `isUid` is false or undefined, UID if `true`. `ids` is a string in the format to match a range of messages. See below "Range of Messages". `flags` must be an array of String flags. If the message(s) or folder do not exist, return an error. If the flags do not exist on message, do not return an error, as this call should be idempotent. `data` returned in the callback should be an array of changed messages, each of which should be an object with the properties `index`, `uid` and `flags`.
* `replaceFlags(folder,ids,isUid,flags,callback)`: replace all of the flags in `flags` on message(s) `ids` in folder `folder` with `flags`. `ids` is index in the folder if `isUid` is false or undefined, UID if `true`. `ids` is a string in the format to match a range of messages. See below "Range of Messages". `flags` must be an array of String flags. If the message(s) or folder do not exist, return an error. `data` returned in the callback should be an array of changed messages, each of which should be an object with the properties `index`, `uid` and `flags`.
* `addProperties(folder,ids,isUid,properties,callback)`: add the properties in `properties` to message(s) `ids` in folder `folder`. `ids` is index in the folder if `isUid` is false or undefined, UID if `true`. `ids` is a string in the format to match a range of messages. See below "Range of Messages". `properties` must be a hash of String properties. If the message(s) or folder do not exist, return an error. If the properties already exist on message, do not return an error, as this call should be idempotent. 
* `removeProperties(folder,ids,isUid,properties,callback)`: remove the properties in `properties` from message `ids` in folder `folder`. `ids` is index in the folder if `isUid` is false or undefined, UID if `true`. `ids` is a string in the format to match a range of messages. See below "Range of Messages". `properties` must be an array of String properties. If the message(s) or folder do not exist, return an error. 
* `replaceProperties(folder,ids,isUid,properties,callback)`: replace all of the properties in `properties` on message(s) `ids` in folder `folder` with `properties`. `ids` is index in the folder if `isUid` is false or undefined, UID if `true`. `ids` is a string in the format to match a range of messages. See below "Range of Messages". `properties` must be a hash of String flags. 
* `namespace(path,callback)`: get the namespace for the given path. Returned object should be null if not found, or an object with a `separator` property to indicate the separator.
* `getNamespaces(callback)`: List the available namespaces.
* `matchFolders(namespace,name,callback)`: search for folders whose name includes `name` in namespace `namespace`. If `namespace` is blank, searches the default namespace for this user, including INBOX. Should return folder objects.
* `getMessageRange(path,range,isUid,callback)`: retrieve actual message objects with their data based on a `range` from a given folder `path`. The `range` is index, unless `isUid` is `true`, in which case it is UID(s). Pass the resultant `message` objects to the `data` argument of the callback. See below for details of a message range.
* `setFolderSpecialUse(folder,flags,callback)`: Set this folder to be special use, per RFC6514, for the given array of flags.
* `searchMessages(folder,query,callback)`: retrieve an array of the IDs - both index and UID - of all messages in the named `folder` that match the search `query`, or an empty array for none. Pass an array of objects to the callback as the `data` argument. See below for search details.
* `subscribeFolder(path,callback)`: subscribe to a given folder. Should return `err` if there is an error, specifically if the folder is invalid, does not exist or is not selectable or subscribable, `null` otherwise.
* `expunge(folder,ignoreSelf,ignoreExists,callback)`: Expunge deleted messages from a given folder. 


#### Methods

##### callbacks
All methods are expected to be asynchronous. The callback signature always should be `function(err,data)`. Any returned value should be in `data`, while errors should be in `err`.

A `null` or `undefined` value for `err` is treated as "there was no error executing this command."

If the executed command failed because it called for a missing item, the `err` is expected to be a string with the following values:

* `"invalid folder"`: The requested folder is invalid or missing.
* `"invalid message"`: The requested message is invalid or missing.




##### searchMessages
`searchMessages()` is a method to search for messages in a given folder and return the matched IDs. This section describes how to implement `searchMessages()`.

###### query parameters

The `query` argument to `searchMessages()` is an object structured as follows. Each of the following is a key in the object. The value depends on the key type. If a key does not exist, then it is ignored, and any value is matched. The list is based on [rfc3501](https://tools.ietf.org/html/rfc3501#section-6.4.4).


* `headers`: Object. Keys are headers to be checked, case-insensitive. Values are the value of the header. To check for presence of a header independent of its value, use a blank string `""`. Currently included headers:
    * `bcc`: String.
    * `cc`: String.
    * `from`: String.
    * `subject`: String.
    * `to`: String.
    * `date`: Object. `Date:` header is before, on or after the specified date. Matches date search format (see below).
* `date`: Object. Return message whose internal calendar date - **not** the `From:` header - (ignoring time) is before, on or after the specified date. Matches date search format (see below).
* `body`: String. Return messages whose body contains the given string.
* `flags`: Array. Each element in the array is a string whose value is a flag that is set. Return messages with the specified flag set. Case-sensitive. Any flag can be included. Current global flags are:
    * `"\Deleted"`
    * `"\Draft"`
    * `"\Flagged"`
    * `"\Recent"`
    * `"\Seen"`
* `size`: Object. Return messages larger or smaller than the given number of bytes, depending on the object:
    * `{'gt':bytes}`: messages larger than `bytes`
    * `{'lt':bytes}`: messages smaller than `bytes`
* `text`: String. Return messages whose heaers or body contain the given string.
* `index`: String. Return messages whose index in the mailbox matches the given range. Identical to `getMessageRange(range,false)`.
* `uid`: String. Return messages whose UID matches the given range. Syntax is identical to `getMessageRange(range,true)`.


###### String searches

For **all** search values where a string is accepted, notably `body`, `text`, and any headers, it should match if the field *contains* that string. For example, `{to:'mith'}` will match the following recipients: mith, smith, jim@smith.com.

Regular expression searching is **not** supported.

###### Date searches

Date searches, notably `{"headers":{"date":value}}` (`Date:` header) and `{"date":value}` (internal date), the `value` accepted is an object that can have one of three options:

* `{"lt": date}`: item is before `date`, ignoring time and timezone
* `{"ge": date}`: item is on or after `date`, ignoring time and timezone
* `{"eq": date}`: item is on `date`, ignoring time and timezone

The value of the `date` to compare the search **must** match [RFC3501](https://tools.ietf.org/html/rfc3501#section-9) date format, which is `DD-MMM-YYYY`, e.g. "23-Nov-2015" or "01-Jan-1994".

E.g.

````json
{
  "headers": {"date": {"eq":"23-Nov-2013"}}
}
````

###### Flags
Flag searches check for a flag that is set. 

Example 1: Search for all messages that have "MyFlag" and "\Deleted" set.

````json
{
  "flags": ["MyFlag","\Deleted"]
}
````

Example 2: Search for all messages that have "MyFlag" set and "\Deleted" not set

````json
{
  "flags": [
		"MyFlag",
		{"not":"\Deleted"}
	],
}
````


**Warning:** As global flags start with a '\' character, be careful escaping them out of strings.


###### Headers
Search for a header that matches a particular value, or exists.

Example 1: Search for all messages that have the header "X-HDG" set to "abc":

````json
{
  "headers": {
		"X-HDG": "abc"
	}
}
````

Example 2: Search for all messages that have the header "X-HDG" set to "abc", and "X-IMP" present:

````json
{
  "headers": {
		"X-HDG": "abc",
		"X-IMP": "",
	}
}
````

Example 3: Search for all messages that have the header "X-HDG" set to "abc", and "X-IMP" not present:

````json
{
  "headers": {
		"X-HDG": "abc"
		"X-IMP": {not:""},
	}
}
````



###### Logical NOT

The default for all fields is a match, you can negate fields by changing any string value to an object with a key of `"not"` and the value matching the normal search value.

The following search terms do not support logical NOT and will be ignored:

* Any date searches
* Sequence/Range searches
* UID searches
* ALL

Examples:

Match any email that has a bcc to "jason":

````json
{
	"headers": {
		"bcc":"jason"
	}
}
````

Match any email that does not have a bcc to "jason":

````json
{
	"headers": {
		"bcc":{"not":"jason"}
	}
}
````

Match any email that has a bcc to "jason" and is not from "jim":

````json
{
	"headers": {
		"bcc":"jason",
		"from":{"not":"jim"}
	}
}
````

Match any email that has flag "ABC" set:

````json
{
	flags: ["ABC"]
}
````

Match any email that has flag "ABC" and "DEF" set:

````json
{
	flags: ["ABC","DEF"]
}
````

Match any email that has flag "ABC" or "DEF" set:

````json
{
	flags: {or: ["ABC","DEF"]}
}
````

Match any email that has flag "ABC" set and "DEF" not set:

````json
{
	flags: ["ABC",{not:"DEF"}]
}
````

Match any email that has flag "ABC" set or "DEF" not set:

````json
{
	flags: {or: ["ABC",{not:"DEF"}]}
}
````


###### Logical OR
The default for multiple search terms is to logically AND them together. You can logically OR terms by wrapping them in an object with the key `"or"`.


Examples:

Match any email that has a bcc to "jason" or cc to "jill":

````json
{
	"headers": {
		"or":{
			"bcc":"jason",
			"cc":"jill"
		}
	}
}
````

Match any email that has a bcc to "jason" or cc to "jill", and is from "sally"

````json
{
	"headers": {
		"or":{
			"bcc":"jason",
			"cc":"jill"
		},
		"from":"sally"
	}
}
````

Match any email that has a bcc to "jason" or "jill"

````json
{
	"headers": {
		"bcc": {"or": ["jason","jill"]}
	}
}
````


###### results
The callback from `searchMessages()` should match the normal `function(err,data)` signature. Any error should be placed in `err`. If there is no error, `data` is expected to contain the results.

* If no results match, `data` should be an empty array.
* If there are results, `data` should be an array of objects.

Each object represents a single matching message. The object must have only two properties:

* `index`: The index of this message in the folder.
* `uid`: The UID for this message.

Examples:

````json
[
  {"index":1,"uid":36578},
  {"index":6,"uid":367722},
  {"index":7,"uid":367723}
]
````


##### getMessageRange

`getMessageRange()` is the primary method of retrieving messages. You normally use `searchMessages()` to get a list of IDs, and then `getMessageRange()` to get actual message(s). The resultant messages are passed to the `data` argument of the callback.

* `getMessageRange(path,range,isUid,callback)`: retrieve actual message objects with their data based on a `range` from a given folder `path`. The `range` is index, unless `isUid` is `true`, in which case it is UID(s). Pass the resultant `message` objects to the `data` argument of the callback. See below for details of a message range.

The following arguments are provided:

* `path`: the full path to folder from which to retrieve the messages.
* `range`: a string range describing which messages to retrieve. See below for the syntax. 
* `isUid`: true if `range` is a range of UID, false/null/undefined otherwise. Default is false.
* `callback`: callback function to which to pass the results.


##### createMessage

`createMessage()` creates a new message in the given folder. It has the following signature:

* `folder`: the full path of the folder in which to create the message
* `content`: the content of the message to create
* `callback`: the callback to call when creation is complete

The `content` must be an object, and has the following properties:

* `raw`: The entire content of the message.
* `internaldate`: Internal date of the message creation time on the server, per https://tools.ietf.org/html/rfc3501#section-2.3.3 
* `flags`: Array of flag strings. Optional.

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
* `path`: The separator-sensitive path to this folder, e.g. "INBOX" or "sub/my/folders".
* `allowPermanentFlags`: boolean whether or not this folder allows permanent flags.
* `uidnext`: string. Optional. The next available UID.
* `uidvalidity`: string. The UID for this session.
* `flags`: object with a key representing the name of each flag on a message in the folder, and the value an integer of the number of messages on which it appears. If not present, must be an empty array `[]`.
* `seen`: integer with the number of messages that have the `Seen` flag set
* `unseen`: integer with the number of messages that do not have the `Seen` flag set
* `permanentFlags`: array of strings, with each element representing a unique permanent flag in this folder
* `messages`: integer, total number of messages in this folder.
* `separator`: character, the separator for this folder. Separators normally are by namespace. It is up to the implementation to ensure the separator is listed on each folder object that it returns.
* `subscribed`: boolean. Should be `true` if the user has subscribed to this folder, thus indicating it will show up in `LSUB` commands. `false` or `undefined` otherwise.

##### Message
The methods that return messages, primarily `getMessageRange()` are expected to return an array. Each element in the array should itself be an array with two elements:

* `index`: the index for the message in the given folder
* `message`: the message object

The message object is expected to have the following properties:

* `raw`: The entire content of the message.
* `internaldate`: Internal date of the message creation time on the server, per https://tools.ietf.org/html/rfc3501#section-2.3.3 
* `flags`: Array of flag strings. Optional.
* `properties`: Object of properties, keyed on property name. Optional.



###### Attachments
When a message is provided, the `attachments` property **always** is an array whose length matches the number of attachments. If there are no attachments, it is a zero-length array.

Each element of the array is an object with the following properties:

* `url`: a URL to the attachment, only if the attachment can be retrieved via URL. It is up to the MSD implementation to determine if and how to provide this URL. For example, it might be a URL that is accessible only via authentication, or it might be a time-limited or unlimited signed URL for S3 access.
* `content`: The actual attachment itself. This is populated only if, when `folder.get(mid)` was called, the option `attachments` or `all` set to `true`.



#### Message Range
Several of the methods operate on a range of messages in a folder. The message range format is a single string, no whitespace allowed, that matches the requirements for IMAP [FETCH](https://tools.ietf.org/html/rfc3501#section-6.4.5) sequence set from RFC 3501. In general, it is composed of two element types: range and items.

* Range: `M:N` - messages from index M to index N. For example, 2:5 retrieves messages 2, 3, 4, 5.
* Items: `M,N` - messages index M and index N. For example, 2,5 retrieves messages 2, 5.

You can combine ranges and items to retrieve more messages at once. For example, `1:4,8,13:17,21` retrieves messages 1 through 4, 8, 13 through 17 and 21.


