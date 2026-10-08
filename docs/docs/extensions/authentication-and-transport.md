---
title: Authentication and Transport
sidebar_position: 9
description: AUTH=PLAIN, SASL-IR, XOAUTH2, OAUTHBEARER, LOGINDISABLED, STARTTLS, COMPRESS=DEFLATE, UNAUTHENTICATE and ID in ImapKit.
---

# Authentication and transport

| Plugin           | Capability         | RFC                                                                         |
| ---------------- | ------------------ | --------------------------------------------------------------------------- |
| `AUTH-PLAIN`     | `AUTH=PLAIN`       | [RFC 4616](https://www.rfc-editor.org/rfc/rfc4616)                          |
| `SASL-IR`        | `SASL-IR`          | [RFC 4959](https://www.rfc-editor.org/rfc/rfc4959)                          |
| `XOAUTH2`        | `AUTH=XOAUTH2`     | [Google XOAUTH2](https://developers.google.com/gmail/imap/xoauth2-protocol) |
| `OAUTHBEARER`    | `AUTH=OAUTHBEARER` | [RFC 7628](https://www.rfc-editor.org/rfc/rfc7628)                          |
| `LOGINDISABLED`  | `LOGINDISABLED`    | [RFC 3501](https://www.rfc-editor.org/rfc/rfc3501)                          |
| `STARTTLS`       | `STARTTLS`         | [RFC 3501](https://www.rfc-editor.org/rfc/rfc3501)                          |
| `COMPRESS`       | `COMPRESS=DEFLATE` | [RFC 4978](https://www.rfc-editor.org/rfc/rfc4978)                          |
| `UNAUTHENTICATE` | `UNAUTHENTICATE`   | [RFC 8437](https://www.rfc-editor.org/rfc/rfc8437)                          |
| `ID`             | `ID`               | [RFC 2971](https://www.rfc-editor.org/rfc/rfc2971)                          |

The default account is `testuser` with password `testpass` and access token `testtoken`. The `users` option defines other accounts, see [Authentication](../guides/authentication.md) for a walkthrough of every login method. `LOGIN` is part of the core and needs no plugin. The AUTH capabilities and `SASL-IR` are only advertised before login.

## AUTH=PLAIN

Adds `AUTHENTICATE PLAIN`. Without [SASL-IR](#sasl-ir) the client waits for an empty continuation request and sends the base64 encoded `authzid NUL authcid NUL password` message on its own line. With SASL-IR it can send it as an initial response in the command.

```text
C: A1 AUTHENTICATE PLAIN AHRlc3R1c2VyAHRlc3RwYXNz
S: A1 BAD SASL-IR must be enabled to send Initial Response with the request
C: A2 AUTHENTICATE PLAIN
S: +
C: AHRlc3R1c2VyAHRlc3RwYXNz
S: A2 OK User logged in
```

- Wrong credentials get `NO [AUTHENTICATIONFAILED]`.
- The authzid must be empty or the same as the user name, acting as another user gets `NO [AUTHORIZATIONFAILED]`.
- `*` instead of the response cancels the exchange with `BAD`. Invalid base64, and invalid UTF-8 in the message (RFC 4616 section 2), are `BAD`.

User names are unicode strings. UTF-8 user names need AUTHENTICATE, since `LOGIN` refuses 8-bit user names and passwords (RFC 9755 section 5).

## SASL-IR

Advertises `SASL-IR` before login, so AUTHENTICATE can carry the initial response (RFC 4959). AUTH=PLAIN and OAUTHBEARER accept an initial response only when SASL-IR is loaded, and XOAUTH2 needs it.

```text
C: A1 CAPABILITY
S: * CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR
S: A1 OK Completed
C: A2 AUTHENTICATE PLAIN AHRlc3R1c2VyAHRlc3RwYXNz
S: A2 OK User logged in
```

## XOAUTH2

Adds the Gmail `AUTHENTICATE XOAUTH2` mechanism. The initial response is the base64 encoded `user=<name>^Aauth=Bearer <token>^A^A`, where `^A` is the octet 0x01.

ImapKit needs SASL-IR loaded and used, Gmail does not: load both plugins.

```javascript
const server = imapkit({ plugins: ['XOAUTH2', 'SASL-IR'] });
```

```text
C: A1 CAPABILITY
S: * CAPABILITY IMAP4rev1 AUTH=XOAUTH2 SASL-IR
S: A1 OK Completed
C: A2 AUTHENTICATE XOAUTH2 dXNlcj10ZXN0dXNlcgFhdXRoPUJlYXJlciB0ZXN0dG9rZW4BAQ==
S: A2 OK User logged in
```

The token of a user is `users[name].xoauth2.accessToken` (`testtoken` for the default `testuser`). A user defined with the `users` option needs this property to log in with XOAUTH2 or OAUTHBEARER:

```javascript
users: { testuser: { password: 'testpass', xoauth2: { accessToken: 'testtoken' } } }
```

A wrong token gets a continuation request with the base64 encoded Gmail error JSON (`{"status":"400","schemes":"Bearer","scope":"https://mail.google.com/"}`), and after the client's next line (an empty one, as Gmail expects) a `NO [AUTHENTICATIONFAILED]`. An unknown user gets `NO [AUTHENTICATIONFAILED]` at once, a malformed response `NO`, and an AUTHENTICATE XOAUTH2 without SASL-IR loaded `BAD`.

## OAUTHBEARER

Adds `AUTHENTICATE OAUTHBEARER` (RFC 7628), with or without SASL-IR. It uses the same tokens as XOAUTH2. The authzid in the GS2 header (`n,a=testuser,`) is optional, without it the token identifies the user.

A failed login gets the JSON error result as a continuation request (`invalid_token` or `invalid_request`), and the client must answer it with `AQ==` (a single `%x01`) to get the final `NO [AUTHENTICATIONFAILED]`:

```text
C: A1 AUTHENTICATE OAUTHBEARER bixhPXRlc3R1c2VyLAFhdXRoPUJlYXJlciB3cm9uZwEB
S: + eyJzdGF0dXMiOiJpbnZhbGlkX3Rva2VuIn0=
C: AQ==
S: A1 NO [AUTHENTICATIONFAILED] SASL authentication failed
C: A2 AUTHENTICATE OAUTHBEARER biwsAWF1dGg9QmVhcmVyIHRlc3R0b2tlbgEB
S: A2 OK SASL authentication succeeded
```

The continuation decodes to `{"status":"invalid_token"}`. Client responses that break the RFC 7628 or GS2 (RFC 5801) grammar are `BAD`, and so is anything other than `AQ==` after an error result.

## LOGINDISABLED

On a connection without TLS, advertises `LOGINDISABLED` before login and refuses `LOGIN` with `NO [PRIVACYREQUIRED]`. Load it together with STARTTLS to test that a client upgrades the connection before it logs in. AUTHENTICATE is not affected.

```text
C: A1 CAPABILITY
S: * CAPABILITY IMAP4rev1 STARTTLS LOGINDISABLED
S: A1 OK Completed
C: A2 LOGIN testuser testpass
S: A2 NO [PRIVACYREQUIRED] Run STARTTLS first
C: A3 STARTTLS
S: A3 OK Server ready to start TLS negotiation
C: A4 CAPABILITY
S: * CAPABILITY IMAP4rev1
S: A4 OK Completed
C: A5 LOGIN testuser testpass
S: A5 OK User logged in
```

## STARTTLS

Adds the `STARTTLS` command, advertised on connections without TLS. After the tagged OK the connection is upgraded to TLS. The server uses a bundled self-signed certificate for `localhost` unless the `credentials` option gives `{ key, cert }`. With `secureConnection: true` (`--secure` on the command line) the server uses TLS from the start instead, and STARTTLS is not advertised.

- STARTTLS on a connection that already uses TLS is `BAD`.
- STARTTLS with commands pipelined after it is `BAD` (RFC 9051 section 6.2.1): TLS is not started and the pipelined commands are refused with `BAD` without running, since they were sent before the TLS layer.

## COMPRESS=DEFLATE

Adds `COMPRESS DEFLATE` (RFC 4978), valid after login. Data is compressed with raw DEFLATE in both directions right after the CRLF of the tagged OK, and every burst of responses ends with a sync flush.

```text
C: A3 COMPRESS DEFLATE
S: A3 OK DEFLATE active
C: A4 COMPRESS DEFLATE
S: A4 BAD [COMPRESSIONACTIVE] DEFLATE active via COMPRESS
```

(The lines after A3 are compressed on the wire.) An unknown mechanism is `BAD`, a second COMPRESS gets `BAD [COMPRESSIONACTIVE]` (RFC 4978 section 3), and COMPRESS with commands pipelined after it is refused like STARTTLS. Input that can not be decompressed ends the connection with `* BYE`. UNAUTHENTICATE ends compression after its tagged OK.

## UNAUTHENTICATE

Adds `UNAUTHENTICATE` (RFC 8437), which returns to the Not Authenticated state so the client can log in again, possibly as another user. It resets the session: the selected mailbox is closed without expunging, ENABLEd extensions and CONDSTORE are turned off, the SEARCHRES result is emptied, and COMPRESS ends after the tagged OK. TLS stays.

```text
C: A3 COMPRESS DEFLATE
S: A3 OK DEFLATE active
C: A5 ENABLE CONDSTORE
S: * ENABLED CONDSTORE
S: A5 OK ENABLE completed
C: A6 UNAUTHENTICATE
S: A6 OK Completed, now in not authenticated state
C: A7 LOGIN testuser testpass
S: A7 OK User logged in
```

UNAUTHENTICATE takes no arguments and is only valid after login. It never fails with `NO` (RFC 8437 section 3).

## ID

Adds the `ID` command (RFC 2971), valid in every state. The server answers with the fields of the `id` server option, or `NIL` without it.

```javascript
const server = imapkit({ plugins: ['ID'], id: { name: 'ImapKit', version: '5.0.0' } });
```

```text
C: A1 ID ("name" "my-client" "version" "1.2")
S: * ID ("name" "ImapKit" "version" "5.0.0")
S: A1 OK ID command completed
C: A2 ID NIL
S: * ID ("name" "ImapKit" "version" "5.0.0")
S: A2 OK ID command completed
C: A3 ID ("name" "a" "NAME" "b")
S: A3 BAD ID field names must not repeat
```

The client's list must follow the RFC 2971 section 3.3 limits, anything else is `BAD`: at most 30 field-value pairs, field names of at most 30 octets that do not repeat (case-insensitively), values of at most 1024 octets, strings or NIL.
