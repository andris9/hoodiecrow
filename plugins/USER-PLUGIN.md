# User Plugin

This document describes how to write a user plugin. The purpose of a user plugin is to enable Imapper to authenticate users against a user database.

## Interface

Like all plugins, a users plugin should provide an initialized and instantiated object to imapper:

````javascript
var users = require('imapper-users-static')({
	john: 'dasabsb657223asasa',
	jill: 'sasaswqwdbsb657223'
});

// you now can pass storage to imapper
server = require('imapper')({
	users: users
});

````


### Authentication
The object passed to imapper as the value of the `users` key on configuration is expected to have a single property, a function called `authenticate()`. 

When Imapper needs to authenticate a user, it will call `authenticate(opts,callback)`. The `authenticate()` call has two parameters:

* `opts`: object. The object will have the following properties:
    * `username`: The name of the user authenticating. Whether this is a plain user, e.g. `dave`, or a fully-qualified name, e.g. `dave@mymail.com`, depends on how the user authenticates. 
    * `password`: The authentication password credentials.
    * `method`: The IMAP authentication method provided. Most of the time, this simply will be `"PLAIN"`
* `callback`: function. The callback should be called by the `authenticate` function when authentication has completed.

It is important to note that Imapper is agnostic about the `username` and `password`. It does not modify it in any way. It simply passes it on as provided by the user.

The `callback` should be called by `authenticate` when the authentication is complete, whether successful or failed. The signature of `callback` is `callback(err,data)` where:

* `err`: Any error. If the user successfully authenticated, this should be `null`. If authentication failed, it should be an error object. Note that IMAP does not necessarily provide a method for sending an error message back to the client.
* `data`: Ignored.

In short, if authentication is successful, `err` should be `null`; if it failed, `err` should be an object.

