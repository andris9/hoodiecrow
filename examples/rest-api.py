#!/usr/bin/env python3
"""
Drives ImapKit through its REST API (README "REST API") from a test that is not written in JavaScript.
Start the server first:

    imapkit -p 1143 --plugin=IDLE --rest-port=8143

Then run `python3 examples/rest-api.py`. Only the standard library is used.
"""

import base64
import imaplib
import json
import urllib.request

REST = "http://127.0.0.1:8143/v1"


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(REST + path, data=data, method=method)
    if data is not None:
        request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request) as response:
        return json.load(response)


# start from the initial state of the server
call("POST", "/reset", {})

# deliver a message, like an incoming mail
added = call("POST", "/mailboxes/INBOX/messages", {"raw": "Subject: hello\r\n\r\nHi from REST\r\n", "flags": ["\\Flagged"]})
print("added UID", added["uid"])

# the IMAP client sees it
imap = imaplib.IMAP4("127.0.0.1", 1143)
imap.login("testuser", "testpass")
imap.select("INBOX")
status, data = imap.uid("FETCH", str(added["uid"]), "(FLAGS BODY.PEEK[HEADER.FIELDS (SUBJECT)])")
print(status, data)

# a fault for the next SELECT, without a restart
call("POST", "/script/rules", {"on": "command", "command": "SELECT", "times": 1, "send": "$TAG NO [UNAVAILABLE] Try again later\r\n"})
print(imap.select("INBOX"))
print(imap.select("INBOX"))

# what the server stores now
message = call("GET", "/mailboxes/INBOX/messages/%d" % added["uid"])
print(message["flags"], base64.b64decode(message["raw"]).decode())
imap.logout()
