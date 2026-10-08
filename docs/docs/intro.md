---
slug: /
sidebar_position: 1
title: Introduction
---

# ImapKit

ImapKit is a scriptable, in-memory IMAP server for testing IMAP clients. It implements IMAP4rev1 ([RFC 3501](https://www.rfc-editor.org/rfc/rfc3501)) and, as an optional plugin, IMAP4rev2 ([RFC 9051](https://www.rfc-editor.org/rfc/rfc9051)), with more than 50 extensions that can be turned on and off per server instance.

Nothing is ever written to disk: the mailbox tree comes from a JSON object, so every new server starts from the same known state.

## Why ImapKit

- **Strict by design.** ImapKit answers client input that breaks the RFCs with `BAD` or `NO`, so client bugs show up in your test suite instead of in production.
- **Control from your tests.** The control API (`server.control`) adds messages, changes flags, resets UIDVALIDITY and disconnects sessions while clients are connected, and every change reaches the sessions the way a change by another client would.
- **Any language.** The optional REST API exposes the same operations over HTTP, with server events as Server-Sent Events.
- **Scripted faults.** Script rules and quirk presets make the server misbehave on purpose, like real servers do: late responses, literals everywhere, throttling, split output, dropped connections.

ImapKit is maintained by the team behind [EmailEngine](https://emailengine.app/?utm_source=imapkit.com&utm_medium=docs&utm_campaign=oss-docs) and [ImapFlow](https://imapflow.com/).
