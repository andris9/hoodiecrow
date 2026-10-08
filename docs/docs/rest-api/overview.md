---
title: REST API Overview
sidebar_position: 1
description: Turn on the REST API, the control API over HTTP, and learn its security model, request and error formats, mailbox name encoding and OpenAPI document.
---

# REST API overview

The REST API is the [control API](../control-api/overview.md) over HTTP, for test suites in any language. It inspects and changes the store, manages users and sessions, adds [script rules](../faults/scripted-faults.md) at runtime and streams [server events](./event-stream.md). Changes reach the connected IMAP sessions exactly as control API calls do.

## Turning it on

The REST API is off by default. From the command line, `--rest-port` turns it on:

```bash
imapkit -p 1143 --rest-port=8143
# Starting ImapKit ...
# ImapKit successfully listening on port 1143
# REST API listening on 127.0.0.1:8143
```

| Option         | Environment variable | Description                                                  |
| -------------- | -------------------- | ------------------------------------------------------------ |
| `--rest-port`  | `IMAPKIT_REST_PORT`  | port of the REST API. Without it the REST API does not start |
| `--rest-host`  | `IMAPKIT_REST_HOST`  | address to listen on, default `127.0.0.1`                    |
| `--rest-token` | `IMAPKIT_REST_TOKEN` | bearer token that every request must send                    |

A config file given with `--config` can hold the same settings as `"rest": { "port": 8143, "host": "127.0.0.1", "token": "..." }`. See [Command line](../getting-started/command-line.md).

From Node.js, use the `rest` option together with `server.start()`:

```javascript
import imapkit from 'imapkit';

const server = imapkit({ rest: { port: 8143 } });
const imapPort = await server.start();
const restPort = server.restServer.address().port; // useful with port: 0
```

`rest` is `{ port, host, token }` with the same meaning as the command line options. `port: 0` picks a free port. Only `server.start()` starts the REST API, `server.listen()` does not. `server.stop()` and `control.shutdown()` close it.

Then call it with any HTTP client:

```bash
curl -X POST http://127.0.0.1:8143/v1/mailboxes/INBOX/messages \
     -H 'Content-Type: application/json' \
     -d '{"raw": "Subject: hello\r\n\r\nHi!\r\n", "flags": ["\\Seen"]}'
# {"uid":1,"uidvalidity":1}
```

## Security model

The REST API controls the whole server, including the mail of every user, so it is careful by default. Do not expose it outside a test environment.

- **Loopback by default.** It listens on `127.0.0.1` unless `host` says otherwise.
- **Token for other addresses.** Any address that is not a loopback one (`localhost`, `127.0.0.0/8`, `::1`) needs a token, otherwise `start()` fails:

    ```
    Failed to start ImapKit: The REST API controls the whole server, it needs a token (rest.token, --rest-token) to listen on 0.0.0.0
    ```

    An empty token is refused as well.

- **Bearer token.** With a token, every request must send `Authorization: Bearer <token>`. A missing or wrong token gets `401` with `WWW-Authenticate: Bearer`. The comparison takes constant time.
- **Host check without a token.** Without a token, a request must name a loopback host in its `Host` header. This stops a web page that rebinds its DNS name to `127.0.0.1` from reaching the API:

    ```bash
    curl -H 'Host: evil.example' http://127.0.0.1:8143/v1/mailboxes
    # 401 {"error":{"code":"UNAUTHORIZED","message":"Requests must use a loopback host name"}}
    ```

- **JSON only, no CORS.** Every POST, and every PUT or DELETE with a body, must be `Content-Type: application/json`, otherwise the answer is `415`. A browser can not send such a request to another origin without a CORS preflight, and the REST API sends no CORS headers, so a web page can not call it.
- **Body limit.** A request body can be at most 64 MiB (`413` above that).

With a token, the server can listen on any address, for example in a container:

```bash
imapkit -p 1143 --rest-port=8143 --rest-host=0.0.0.0 --rest-token=sekret
curl -H 'Authorization: Bearer sekret' http://127.0.0.1:8143/v1/users
# [{"name":"testuser","xoauth2":true}]
```

## Requests and responses

Request bodies are JSON objects (an array is accepted where the endpoint takes a list, like script rules). A request without a body counts as `{}`. Note that a POST always needs the `Content-Type: application/json` header, even without a body:

```bash
curl -X POST http://127.0.0.1:8143/v1/reset -H 'Content-Type: application/json'
# {"reset":true}
```

Responses are JSON with `Cache-Control: no-store`. Status `200` is the default, operations that create something answer `201`, `POST /v1/shutdown` answers `202`.

## Errors

Every error is a JSON object with the `ImapKitError` code and message:

```json
{ "error": { "code": "NONEXISTENT", "message": "Mailbox \"Nope\" does not exist" } }
```

| Status | `code`                                                              | When                                                                                       |
| ------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 400    | `INVALID`                                                           | a bad argument, a body that is not JSON or not an object or array, bad URL encoding        |
| 401    | `UNAUTHORIZED`                                                      | a missing or wrong token, or a host name that is not a loopback one                        |
| 404    | `NONEXISTENT`                                                       | the mailbox, message, user, session, rule or ACL entry does not exist                      |
| 404    | `NOTFOUND`                                                          | no such endpoint                                                                           |
| 405    | `METHOD`                                                            | the path exists, but not with this method                                                  |
| 409    | `ALREADYEXISTS`                                                     | the mailbox or user exists already                                                         |
| 409    | other IMAP response codes: `CANNOT`, `HASCHILDREN`, `OVERQUOTA` ... | the operation is not possible in the current state                                         |
| 413    | `TOOBIG`                                                            | the body is larger than 64 MiB, or APPENDLIMIT refused a message added with `checks: true` |
| 415    | `UNSUPPORTED`                                                       | the request is not `application/json`                                                      |
| 500    | `SERVERERROR`                                                       | an unexpected error in the server                                                          |

```bash
curl -s -w '\n%{http_code}\n' -X DELETE http://127.0.0.1:8143/v1/mailboxes/INBOX
# {"error":{"code":"CANNOT","message":"INBOX can not be modified"}}
# 409
curl -s -w '\n%{http_code}\n' -X PATCH http://127.0.0.1:8143/v1/mailboxes
# {"error":{"code":"METHOD","message":"Method PATCH is not allowed here"}}
# 405
```

## Mailbox names in URLs

A mailbox is its [storage name](../control-api/overview.md#mailbox-names-are-storage-names) (modified UTF-7) in the URL, URL encoded as one path segment. A `/` in the name must be `%2F`, otherwise it is a path separator:

| Mailbox         | URL                             |
| --------------- | ------------------------------- |
| `INBOX`         | `/v1/mailboxes/INBOX`           |
| `Work/Projects` | `/v1/mailboxes/Work%2FProjects` |
| `Café`          | `/v1/mailboxes/Caf%26AOk-`      |
| `My Mail`       | `/v1/mailboxes/My%20Mail`       |

`encodeURIComponent()` in JavaScript, `urllib.parse.quote(name, safe="")` in Python and `url.PathEscape()` in Go produce the right form. In JSON bodies (`path` of `POST /v1/mailboxes`, `newPath`, `target`) names are plain strings.

## Message sources

Message sources are base64 in responses, with `"encoding": "base64"` next to `raw`. A request sends `raw` either as text, which is encoded as UTF-8, or as base64 with `"encoding": "base64"`. Use base64 for 8-bit or binary messages that are not valid UTF-8:

```bash
curl -X POST http://127.0.0.1:8143/v1/mailboxes/INBOX/messages \
     -H 'Content-Type: application/json' \
     -d '{"raw": "U3ViamVjdDogYmFzZTY0DQoNCkJvZHkNCg==", "encoding": "base64"}'
# {"uid":2,"uidvalidity":1}
```

`"encoding"` must be `"utf-8"` (the default) or `"base64"`. The same applies to `data` of `POST /v1/sessions/{session}/inject`.

## OpenAPI document

`GET /v1/openapi.json` describes every endpoint of the running server as an [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0) document, including the routes of the loaded plugins. Use it to generate a client, or to check which endpoints a server has:

```bash
curl -s http://127.0.0.1:8143/v1/openapi.json | jq '.paths | keys'
```

The [Endpoints](./endpoints.md) page documents them all with examples.
