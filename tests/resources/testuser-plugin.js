var user = "testuser", pass = "testpass", xoauth2 = {
    accessToken: "testtoken",
    sessionTimeout: 3600 * 1000
};

module.exports = {
	authenticate : function (opts,callback) {
		opts = opts || {};
		switch(opts.method) {
			case 'XOAUTH2':
				if (opts.username !== user) {
					callback({type:"user"});
				} else if (opts.token !== xoauth2.accessToken) {
					callback({type:"token"});
				} else {
					callback();
				}
				break;
			case 'PLAIN':
			case 'LOGIN':
				if (opts.username === user && opts.password === pass) {
					callback();
				} else {
					callback("Bad username password");
				}
				break;
		}
	}
};
