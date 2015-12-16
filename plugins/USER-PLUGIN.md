# User Plugin

This document describes how to write a user plugin. The purpose of a user plugin is to enable Imapper to authenticate users against a user database.

## Interface

### Initial Access
The plugin is accessed by calling `require(plugin)`, where `plugin` is the name of the plugin as provided in the imapper configuration. Thus, if you have a config as follows:

````json
{
	users: {
		name: 'my-user-plugin'
	}
}
````

Then the plugin will activate it by calling `require('my-user-plugin)`.

The plugin is `require`d only once, upon launching. Do not put ongoing refresh code into the initial require.

The plugin is expected to return a single function.

### Initiation
The plugin is initiated by calling the function return by `require()`. The function is passed a single argument, the `options` object from the configuration.

The details of that configuration, what the plugin expects, and how it processes that data are **entirely** up to the plugin itself. Imapper makes no demands of the options.

The return from the function is expected to be an object, called the `usersManager` by Imapper.

For example, using the config below:

````json
{
	users: 'my-user-plugin'
	config: {
		a: true
		someVar: 'Login'
	}
}
````

Imapper will instantiate and initialize the plugin as follows:

````javascript
var usersPlugin = require('my-user-plugin'),
usersManager = usersPlugin({
	a: true
	someVar: 'Login'
});
// usersManager must be an object
````

### Authentication
The `usersManager` object returned by initiating the users plugin is expected to have a single property, a function called `authenticate()`. 

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

